import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR, envVar } from "./config";

export const MAX_AUDIO_BYTES=25*1024*1024;

// The login agent runs with a bare PATH, so look where Homebrew installs things.
const BIN_DIRS=["/opt/homebrew/bin","/usr/local/bin","/usr/bin"];
const which=(name:string)=>BIN_DIRS.map(dir=>join(dir,name)).find(existsSync);

// whisper.cpp models, in the order we'd rather use them: fast enough on a Mac, good enough to send.
const MODEL_DIRS=()=>[join(CONFIG_DIR,"models"),join(homedir(),".cache","whisper.cpp")];
const MODEL_ORDER=["large-v3-turbo","small.en","small","base.en","base","medium.en","medium","tiny.en","tiny"];
function findModel() {
  const configured=envVar("WHISPER_MODEL");
  if(configured)return existsSync(configured)?configured:undefined;
  const found=MODEL_DIRS().flatMap(dir=>{try{return readdirSync(dir).filter(f=>/^ggml-.+\.bin$/.test(f)).map(f=>join(dir,f));}catch{return [];}});
  const rank=(path:string)=>{const i=MODEL_ORDER.findIndex(m=>path.endsWith(`ggml-${m}.bin`));return i<0?MODEL_ORDER.length:i;};
  return found.sort((a,b)=>rank(a)-rank(b))[0];
}

// whisper-cli loads the model on every run (about 0.6s); whisper-server keeps it
// loaded, so a clip comes back in well under 0.1s. Started on first use and
// stopped after ten idle minutes (about 250MB while it runs).
const SERVER_IDLE=10*60*1000;
let server:{child:ChildProcess;port:number;ready:Promise<void>}|null=null;
let serverIdle:ReturnType<typeof setTimeout>|undefined;
function stopServer(){clearTimeout(serverIdle);server?.child.kill();server=null;}
process.on("exit",stopServer);
const freePort=()=>new Promise<number>((resolve,reject)=>{
  const probe=createServer();probe.once("error",reject);
  probe.listen(0,"127.0.0.1",()=>{const port=(probe.address() as {port:number}).port;probe.close(()=>resolve(port));});
});
async function startServer(bin:string,model:string) {
  const port=await freePort();
  const child=spawn(bin,["-m",model,"--host","127.0.0.1","--port",String(port),"-l",/\.en\.bin$/.test(model)?"en":"auto","-nt"],{stdio:"ignore"});
  const s={child,port,ready:(async()=>{
    for(let i=0;i<60;i++){
      if(child.exitCode!==null)throw Error("whisper-server stopped");
      try {await fetch(`http://127.0.0.1:${port}/`);return;} catch {}
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error("whisper-server didn't start");
  })()};
  child.on("exit",()=>{if(server===s)server=null;});
  return s;
}
async function transcribeWithServer(bin:string,model:string,wav:string,signal:AbortSignal) {
  server??=await startServer(bin,model);
  const s=server;
  clearTimeout(serverIdle);
  try {
    await s.ready;
    const form=new FormData();
    form.append("file",new Blob([await readFile(wav)],{type:"audio/wav"}),"in.wav");
    form.append("response_format","text");
    const res=await fetch(`http://127.0.0.1:${s.port}/inference`,{method:"POST",body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if(!res.ok)throw Error(`whisper-server answered ${res.status}`);
    return await res.text();
  } catch(e) {
    if(!signal.aborted)stopServer();
    throw e;
  } finally {serverIdle=setTimeout(stopServer,SERVER_IDLE);}
}

export interface Transcriber { available():boolean; transcribe(audio:Buffer,signal:AbortSignal):Promise<string>; warm?():void; }

// Speech to text on the Mac with whisper.cpp: ffmpeg turns the phone's recording
// (webm or mp4) into 16 kHz WAV, then whisper-cli prints the text. Nothing leaves the machine.
export const whisper:Transcriber={
  available:()=>!!(which("whisper-cli") && which("ffmpeg") && findModel()),
  // Starts whisper-server as you start talking, so the first clip doesn't wait for it.
  warm() {
    const bin=which("whisper-server"),model=findModel();
    if(!bin || !model || server || /^(?:0|off|false|no)$/i.test(envVar("WHISPER_SERVER") || ""))return;
    void startServer(bin,model).then(s=>{
      if(server){s.child.kill();return;}
      server=s;clearTimeout(serverIdle);serverIdle=setTimeout(stopServer,SERVER_IDLE);
      s.ready.catch(()=>{if(server===s)stopServer();});
    },()=>{});
  },
  async transcribe(audio,signal) {
    const whisperCli=which("whisper-cli"),ffmpeg=which("ffmpeg"),model=findModel();
    if(!whisperCli || !ffmpeg || !model)throw Error("Voice input needs whisper-cli, ffmpeg and a whisper model on your Mac. Run `brew install whisper-cpp ffmpeg`.");
    const dir=await mkdtemp(join(tmpdir(),"afkterm-voice-"));
    try {
      await writeFile(join(dir,"in"),audio,{mode:0o600});
      const run=promisify(execFile);
      await run(ffmpeg,["-nostdin","-loglevel","error","-i",join(dir,"in"),"-ar","16000","-ac","1","-f","wav",join(dir,"in.wav")],{signal,timeout:30000});
      const serverBin=which("whisper-server");
      let stdout:string|undefined;
      if(serverBin && !/^(?:0|off|false|no)$/i.test(envVar("WHISPER_SERVER") || "")){
        try {stdout=await transcribeWithServer(serverBin,model,join(dir,"in.wav"),signal);}
        catch(e) {signal.throwIfAborted();console.error(`whisper-server failed, using whisper-cli: ${e instanceof Error?e.message:e}`);}
      }
      stdout??=(await run(whisperCli,["-m",model,"-f",join(dir,"in.wav"),"-nt","-np","-l",/\.en\.bin$/.test(model)?"en":"auto"],{signal,timeout:60000,maxBuffer:1024*1024})).stdout;
      // whisper marks silence and noise as [BLANK_AUDIO], (music) and the like.
      return stdout.replace(/\[[A-Z_ ]+\]|\((?:music|silence|noise|inaudible)\)/gi,"").replace(/\s+/g," ").trim();
    } finally {await rm(dir,{recursive:true,force:true});}
  },
};
