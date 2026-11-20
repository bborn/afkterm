import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, type Stats } from "node:fs";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileInfo, FileType, Folder } from "./contract";
import { CONFIG_DIR } from "./config";

// Lets the phone look at files Claude mentions. Only the home folder and the temp
// folders are served, checked after resolving symlinks, and never the places that
// hold keys: the phone is one stolen device away from being someone else's.
export interface FileRules { home:string; roots:string[]; denied:string[] }

export class FileError extends Error { constructor(public status:number,message:string){super(message);} }

const real=(p:string)=>{try {return realpathSync(p);} catch {return p;}};
const uniq=(list:string[])=>[...new Set(list.flatMap(p=>[resolve(p),real(p)]))];
export function fileRules(home=homedir(),temps=["/tmp","/private/tmp","/var/folders",tmpdir()],config=[CONFIG_DIR,join(home,".iterm-web")]):FileRules {
  // Credentials that commonly live in the home folder, beyond the ones asked for by name.
  const secrets=[".ssh",".gnupg","Library/Keychains",".aws",".netrc",".config/gh",".docker",".kube"].map(p=>join(home,p));
  return {home:resolve(home),roots:uniq([home,...temps]),denied:uniq([...secrets,...config])};
}

const inside=(p:string,dir:string)=>p===dir || p.startsWith(dir.endsWith("/")?dir:dir+"/");
// .env files and private keys, wherever they are. Public keys (id_*.pub) are fine.
export const secretName=(name:string)=>/^\.env/i.test(name) || /\.(pem|key)$/i.test(name) || (/^id_/.test(name) && !name.endsWith(".pub"));
const refused=(p:string,rules:FileRules)=>rules.denied.some(d=>inside(p,d)) || p.split("/").some(secretName);

// What the phone typed, as an absolute path: ~ is the home folder, relative paths
// start in the session's folder. Null when it can't be placed.
export function resolveInput(input:string,cwd:string,rules:FileRules):string|null {
  if(!input || input.length>4096 || input.includes("\0"))return null;
  if(input==="~" || input.startsWith("~/"))return resolve(rules.home,input.slice(2));
  if(isAbsolute(input))return resolve(input);
  return isAbsolute(cwd)?resolve(cwd,input):null;
}

// The path's real location and stats, if the phone may see it.
export async function access(path:string,rules:FileRules):Promise<{real:string;stats:Stats}> {
  if(refused(path,rules))throw new FileError(403,"You can't open this file from your phone.");
  const target=await realpath(path).catch(()=>{throw new FileError(404,"That file doesn't exist.");});
  if(!rules.roots.some(r=>inside(target,r)) || refused(target,rules))throw new FileError(403,"You can't open this file from your phone.");
  const stats=await stat(target);
  if(!stats.isFile() && !stats.isDirectory())throw new FileError(403,"You can't open this file from your phone.");
  return {real:target,stats};
}

const TYPES:[RegExp,FileType,string][]=[
  [/^(png)$/,"image","image/png"],[/^(jpe?g)$/,"image","image/jpeg"],[/^(gif)$/,"image","image/gif"],[/^(webp)$/,"image","image/webp"],
  [/^(svg)$/,"image","image/svg+xml"],[/^(heic|heif)$/,"image","image/jpeg"],
  [/^(pdf)$/,"pdf","application/pdf"],
  [/^(mp4|m4v)$/,"video","video/mp4"],[/^(mov)$/,"video","video/quicktime"],[/^(webm)$/,"video","video/webm"],
  [/^(mp3)$/,"audio","audio/mpeg"],[/^(m4a|aac)$/,"audio","audio/mp4"],[/^(wav)$/,"audio","audio/wav"],[/^(ogg|oga|opus)$/,"audio","audio/ogg"],[/^(flac)$/,"audio","audio/flac"],
  [/^(md|markdown|mdx)$/,"markdown","text/plain; charset=utf-8"],
  // Served as plain text so nothing (HTML especially) runs on afkterm's own origin.
  [/^(txt|log|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|rb|erb|py|go|rs|java|kts?|swift|[ch]|cc|cpp|hpp|m|mm|cs|php|sh|bash|zsh|fish|sql|lua|pl|r|exs?|vue|svelte|gradle|properties|lock|diff|patch|tex|rst|org|graphql|proto|tf|nix|plist|gitignore)$/,"text","text/plain; charset=utf-8"],
];
const typeFor=(name:string)=>{const ext=extname(name).slice(1).toLowerCase();return TYPES.find(([re])=>re.test(ext));};
// Files without a known extension (Makefile, LICENSE) are text when they have no NUL bytes.
async function looksLikeText(path:string,size:number) {
  if(!size)return true;
  const handle=await open(path,"r").catch(()=>null);if(!handle)return false;
  try {const {buffer,bytesRead}=await handle.read(Buffer.alloc(Math.min(size,4096)),0,Math.min(size,4096),0);return !buffer.subarray(0,bytesRead).includes(0);}
  finally {await handle.close();}
}
async function fileType(name:string,real:string,size:number):Promise<FileType> {
  const known=typeFor(name);
  if(known)return known[1];
  return await looksLikeText(real,size)?"text":"other";
}

// File URLs are signed instead of carrying the device secret, so <img>, <video> and
// the phone's own viewers can load them, and a shared link can't unlock anything else.
// The secret lives only in memory; links stop working when afkterm restarts.
export class FileTokens {
  private secret=randomBytes(32);
  constructor(private ttl=24*3600*1000) {}
  private mac=(path:string,exp:number)=>createHmac("sha256",this.secret).update(`${path}\n${exp}`).digest("base64url");
  url(path:string) {const exp=Date.now()+this.ttl;return `/api/file?path=${encodeURIComponent(path)}&exp=${exp}&sig=${this.mac(path,exp)}`;}
  verify(path:string,exp:string,sig:string) {
    const n=Number(exp);if(!Number.isFinite(n) || n<Date.now())return false;
    const want=Buffer.from(this.mac(path,n)),got=Buffer.from(sig);
    return want.length===got.length && timingSafeEqual(want,got);
  }
}

async function info(path:string,rules:FileRules,tokens:FileTokens):Promise<FileInfo> {
  const {real,stats}=await access(path,rules);
  const name=basename(path) || path;
  const base={path,name,size:stats.size,mtime:stats.mtimeMs};
  if(stats.isDirectory())return {...base,kind:"dir",type:"other"};
  return {...base,kind:"file",type:await fileType(name,real,stats.size),url:tokens.url(path)};
}

// Which of these paths exist and may be shown. Missing and refused ones are left out.
export async function statFiles(inputs:string[],cwd:string,rules:FileRules,tokens:FileTokens) {
  const files:Record<string,FileInfo>={};
  await Promise.all(inputs.map(async input=>{
    const path=resolveInput(input,cwd,rules);
    if(path)try {files[input]=await info(path,rules,tokens);} catch {}
  }));
  return files;
}

const MAX_ENTRIES=1000;
export async function listFolder(input:string,cwd:string,rules:FileRules,tokens:FileTokens):Promise<Folder> {
  const path=resolveInput(input,cwd,rules);
  if(!path)throw new FileError(400,"That isn't a path on your Mac.");
  const {real,stats}=await access(path,rules);
  if(!stats.isDirectory())throw new FileError(400,"That isn't a folder.");
  const names=(await readdir(real)).sort((a,b)=>a.localeCompare(b));
  const entries=(await Promise.all(names.slice(0,MAX_ENTRIES).map(n=>info(join(path,n),rules,tokens).catch(()=>null)))).filter((e):e is FileInfo=>!!e);
  entries.sort((a,b)=>(a.kind==="dir"?0:1)-(b.kind==="dir"?0:1) || a.name.localeCompare(b.name));
  const up=dirname(path);
  const parent=up!==path?await info(up,rules,tokens).catch(()=>null):null;
  return {path,name:basename(path) || path,parent,entries,truncated:names.length>MAX_ENTRIES};
}

// HEIC photos become JPEGs on the Mac (phones show those everywhere). Kept by content key.
const converting=new Map<string,Promise<string>>();
async function heicToJpeg(real:string,stats:Stats) {
  const dir=join(tmpdir(),"afkterm-heic");
  const out=join(dir,createHash("sha256").update(`${real}\n${stats.mtimeMs}\n${stats.size}`).digest("hex").slice(0,32)+".jpg");
  if(await stat(out).catch(()=>null))return out;
  let job=converting.get(out);
  if(!job){
    job=(async()=>{
      await mkdir(dir,{recursive:true,mode:0o700});
      await promisify(execFile)("/usr/bin/sips",["-s","format","jpeg",real,"--out",out],{timeout:60000});
      return out;
    })().finally(()=>converting.delete(out));
    converting.set(out,job);
  }
  return job.catch(()=>{throw new FileError(501,"You can't view this HEIC photo here. Your Mac couldn't convert it.");});
}

// Raster images, video and audio can't run script; everything else gets a sandbox
// so even a mislabeled file can't reach the app's storage. PDFs and media keep no
// policy at all, since some viewers refuse to render under one.
const SANDBOX="sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

export async function serveFile(req:IncomingMessage,res:ServerResponse,rules:FileRules,tokens:FileTokens) {
  const q=new URL(req.url || "/","http://local").searchParams;
  const path=q.get("path") || "";
  if(!tokens.verify(path,q.get("exp") || "",q.get("sig") || ""))throw new FileError(403,"This link has expired. Open the file again from the chat.");
  let {real,stats}=await access(path,rules);
  if(!stats.isFile())throw new FileError(400,"That isn't a file.");
  const name=basename(path);
  const known=typeFor(name);
  let mime=known?.[2] ?? (await looksLikeText(real,stats.size)?"text/plain; charset=utf-8":"application/octet-stream");
  if(/\.(heic|heif)$/i.test(name) && !q.get("download")){real=await heicToJpeg(real,stats);stats=await stat(real);mime="image/jpeg";}
  const media=/^(application\/pdf|video\/|audio\/)/.test(mime);
  if(media)res.removeHeader("content-security-policy");else res.setHeader("content-security-policy",SANDBOX);
  const download=q.get("download") || mime==="application/octet-stream";
  const headers:Record<string,string|number>={
    "content-type":mime,"accept-ranges":"bytes","cache-control":"private, max-age=300",
    "content-disposition":`${download?"attachment":"inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  // Video players read in pieces and the text viewer reads only the first part.
  const size=stats.size;let start=0,end=size-1,status=200;
  const range=String(req.headers.range || "");
  if(range && size){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if(m && (m[1] || m[2])){
      start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
      end=m[1] && m[2]?Math.min(Number(m[2]),size-1):size-1;
      if(start>end || start>=size){res.writeHead(416,{...headers,"content-range":`bytes */${size}`});return void res.end();}
      status=206;headers["content-range"]=`bytes ${start}-${end}/${size}`;
    }
  }
  headers["content-length"]=size?end-start+1:0;
  res.writeHead(status,headers);
  if(req.method==="HEAD" || !size)return void res.end();
  await pipeline(createReadStream(real,{start,end}),res).catch(()=>res.destroy());
}
