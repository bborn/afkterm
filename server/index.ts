import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { actionSchema, claudeSendSchema, sessionId as sessionIdSchema, type Action, type ClaudeSend, type InputOptions, type Preview, type SessionList } from "./contract";
import { apiKey, authorize, hasKey, Pairing, sameOriginSocket, type AuthConfig } from "./auth";
import { LiveSessions } from "./live";
import { MAX_UPLOAD_BYTES, saveUpload } from "./uploads";
import { MAX_AUDIO_BYTES, whisper, type Transcriber } from "./voice";

export interface Backend {
  list(signal:AbortSignal):Promise<SessionList>;
  preview(sessionId:string,signal:AbortSignal):Promise<Preview>;
  inputOptions(sessionId:string,signal:AbortSignal):Promise<InputOptions>;
  action(action:Action,signal:AbortSignal):Promise<{sessionId:string|null}>;
  sendClaude(sessionId:string,input:ClaudeSend,signal:AbortSignal):Promise<{sessionId:string|null}>;
  transcriptPath?(sessionId:string):string|undefined;
  onScreenUpdate?(sessionId:string,listener:()=>void):()=>void;
  hostName?():string;
  // The terminal app's name, for the UI ("iTerm2" when left out).
  appName?():string;
}

class HttpError extends Error { constructor(public status:number,message:string,public extra:Record<string,unknown>={}){super(message);} }

// No framing (clickjacking), and nothing loads from anywhere but iterm-web itself:
// in particular, images in Claude's Markdown can't leak data to other servers.
const securityHeaders=(host:string)=>({
  "x-frame-options":"DENY",
  "x-content-type-options":"nosniff",
  "referrer-policy":"no-referrer",
  "content-security-policy":`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://${host} ws://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
});
const MAX_SOCKETS=32, MAX_WATCHED=16;

const MIME:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".json":"application/json",".webmanifest":"application/manifest+json",".ico":"image/x-icon",".woff2":"font/woff2"};

async function body(req:IncomingMessage,limit:number):Promise<Buffer> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of req){
    size+=chunk.length;
    if(size>limit)throw new HttpError(413,"Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const json=async<T>(req:IncomingMessage,schema:z.ZodType<T>)=>{
  let value:unknown;
  try {value=JSON.parse((await body(req,1024*1024)).toString("utf8"));} catch(error) {if(error instanceof HttpError)throw error;throw new HttpError(400,"Invalid JSON.");}
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new HttpError(400,parsed.error.issues.map(i=>i.message).join("; "));
  return parsed.data;
};

export function createApp({backend,auth,staticDir,voice=whisper}:{backend:Backend;auth:AuthConfig;staticDir:string;voice?:Transcriber}) {
  const live=new LiveSessions((id,signal)=>backend.preview(id,signal),{watchPath:id=>backend.transcriptPath?.(id),onChange:backend.onScreenUpdate?(id,changed)=>backend.onScreenUpdate!(id,changed):undefined});
  const lifecycle=new AbortController();
  const signal=(req:IncomingMessage)=>{
    const controller=new AbortController();
    req.on("close",()=>{if(!req.complete)controller.abort();});
    return AbortSignal.any([controller.signal,lifecycle.signal,AbortSignal.timeout(30000)]);
  };

  const pairing=new Pairing();

  async function api(req:IncomingMessage,res:ServerResponse,path:string,login:string) {
    const send=(status:number,data:unknown)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));};
    const method=req.method || "GET";
    const key=apiKey(req.headers);
    // A new device trades a pairing code (from `iterm-web pair`) for the device secret.
    if(path==="/api/pair" && method==="POST"){
      if(key!=="pair")throw new HttpError(403,"Missing app header.");
      const {code}=await json(req,z.object({code:z.string().max(20)}));
      if(!auth.key)return send(200,{key:""});
      if(!pairing.redeem(code))throw new HttpError(403,"That code didn't work. Run `iterm-web pair` on your Mac for a new one.");
      return send(200,{key:auth.key});
    }
    if(!hasKey(key,auth))throw new HttpError(401,"This device isn't paired yet.",{pairing:true});
    if(path==="/api/pair-code" && method==="POST")return send(200,{code:pairing.create()});
    if(path==="/api/me" && method==="GET")return send(200,{login,host:backend.hostName?.() ?? hostname().replace(/\.local$/,""),app:backend.appName?.() ?? "iTerm2",voice:voice.available()});
    if(path==="/api/sessions" && method==="GET")return send(200,await backend.list(signal(req)));
    if(path==="/api/transcribe" && method==="POST"){
      if(!voice.available())throw new HttpError(501,"Voice input isn't set up on your Mac. Run `brew install whisper-cpp ffmpeg` and download a model.");
      return send(200,{text:await voice.transcribe(await body(req,MAX_AUDIO_BYTES),signal(req))});
    }
    if(path==="/api/new-window" && method==="POST")return send(200,await backend.action({kind:"new-window"},signal(req)));
    const match=/^\/api\/sessions\/([^/]+)\/([a-z-]+)$/.exec(path);
    if(!match)throw new HttpError(404,"Not found.");
    const id=sessionIdSchema.parse(decodeURIComponent(match[1]));
    const route=`${method} ${match[2]}`;
    if(route==="GET preview")return send(200,await backend.preview(id,signal(req)));
    if(route==="GET skills")return send(200,await backend.inputOptions(id,signal(req)));
    if(route==="POST action"){
      const input=await json(req,z.record(z.string(),z.unknown()));
      const action=actionSchema.parse({...input,sessionId:id});
      if(action.kind==="new-window")throw new HttpError(400,"Use /api/new-window.");
      const result=await backend.action(action,signal(req));
      live.poke(id);
      return send(200,result);
    }
    if(route==="POST claude"){
      const result=await backend.sendClaude(id,await json(req,claudeSendSchema),signal(req));
      live.poke(id);
      return send(200,result);
    }
    if(route==="POST uploads"){
      const name=decodeURIComponent(String(req.headers["x-file-name"] || "attachment"));
      return send(200,await saveUpload(id,name,await body(req,MAX_UPLOAD_BYTES)));
    }
    throw new HttpError(404,"Not found.");
  }

  // Static files are small and few; keep them (and their gzip) in memory.
  const files=new Map<string,{data:Buffer;gzip?:Buffer}>();
  async function serveStatic(req:IncomingMessage,res:ServerResponse,path:string) {
    const root=resolve(staticDir);
    let file=resolve(root,"."+normalize(path));
    if(!file.startsWith(root))throw new HttpError(404,"Not found.");
    if(!files.has(file) && !(await stat(file).catch(()=>null))?.isFile())file=join(root,"index.html");
    let entry=files.get(file);
    if(!entry){
      const data=await readFile(file).catch(()=>{throw new HttpError(404,"App is not built. Run npm run build.");});
      entry={data,gzip:/\.(html|js|css|svg|json|webmanifest)$/.test(file)?gzipSync(data):undefined};
      if(file.includes(`${root}/assets/`))files.set(file,entry);
    }
    const immutable=file.includes(`${root}/assets/`);
    const gzip=entry.gzip && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    res.writeHead(200,{"content-type":MIME[extname(file)] || "application/octet-stream","cache-control":immutable?"public, max-age=31536000, immutable":"no-cache",...(gzip?{"content-encoding":"gzip",vary:"accept-encoding"}:{})});
    res.end(gzip?entry.gzip:entry.data);
  }

  const server=createServer(async(req,res)=>{
    const path=new URL(req.url || "/","http://local").pathname;
    for(const [name,value] of Object.entries(securityHeaders(String(req.headers.host || ""))))res.setHeader(name,value);
    try {
      const auth_=authorize(req.headers,auth);
      if(!auth_.ok)throw new HttpError(auth_.status,auth_.reason);
      if(path.startsWith("/api/"))await api(req,res,path,auth_.login);
      else await serveStatic(req,res,path);
    } catch(error) {
      const status=error instanceof HttpError?error.status:error instanceof z.ZodError?400:500;
      const message=error instanceof z.ZodError?error.issues.map(i=>i.message).join("; "):error instanceof Error?error.message:String(error);
      if(!res.headersSent){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});}
      res.end(JSON.stringify({error:message,...(error instanceof HttpError?error.extra:{})}));
    }
  });

  // Previews are JSON up to a few hundred KB; compression shrinks them ~5-10x.
  const sockets=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:{threshold:1024},clientTracking:true});
  server.on("upgrade",(req,socket,head)=>{
    const url=new URL(req.url || "/","http://local");
    const id=sessionIdSchema.safeParse(url.searchParams.get("session") || "");
    // Browsers can't add headers to WebSockets, so the device secret rides in the URL.
    const allowed=url.pathname==="/api/live" && id.success && authorize(req.headers,auth).ok
      && sameOriginSocket(req.headers,auth) && hasKey(url.searchParams.get("key"),auth);
    const full=sockets.clients.size>=MAX_SOCKETS || (id.success && live.size>=MAX_WATCHED && !live.watching(id.data));
    if(!allowed || full){socket.end(`HTTP/1.1 ${allowed?"503 Service Unavailable":"403 Forbidden"}\r\n\r\n`);return;}
    sockets.handleUpgrade(req,socket,head,ws=>{
      const unsubscribe=live.subscribe(id.data,{send:data=>ws.send(data)});
      // Phones drop connections silently when backgrounded; ping to notice.
      let alive=true;
      const ping=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);
      ws.on("pong",()=>{alive=true;});
      ws.on("close",()=>{clearInterval(ping);unsubscribe();});
      ws.on("error",()=>ws.terminate());
    });
  });
  server.on("close",()=>lifecycle.abort());
  return {server,live};
}

// The built web app: dist/web next to the bundled CLI, or ../dist/web in development.
function staticRoot() {
  const here=fileURLToPath(new URL(".",import.meta.url));
  return [join(here,"web"),join(here,"..","dist","web")].find(dir=>existsSync(join(dir,"index.html"))) || join(here,"web");
}

export async function startServer({port,auth,fake=false,terminals="iterm"}:{port:number;auth:AuthConfig;fake?:boolean;terminals?:"iterm"|"herdr"}) {
  if(!fake && !auth.key)throw new Error("No device secret configured. Run `iterm-web setup`.");
  if(!auth.allowedLogins.size && !auth.allowLocal)throw new Error("No Tailscale login is allowed. Run `iterm-web setup`, or set ITERM_WEB_ALLOWED_LOGINS.");
  const backend:Backend=fake?(await import("./fake")).fake:terminals==="herdr"?await import("./herdr"):await import("./iterm");
  const {server}=createApp({backend,auth,staticDir:staticRoot()});
  // Loopback only: other devices reach iterm-web solely through Tailscale Serve.
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",()=>resolve());});
  console.log(`iterm-web listening on http://127.0.0.1:${port}${fake?" (demo data)":terminals==="herdr"?" (Herdr)":""}`);
  for(const sig of ["SIGINT","SIGTERM"] as const)process.on(sig,()=>{server.close();process.exit(0);});
  return server;
}
