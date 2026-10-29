import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const MAX_AUDIO_BYTES=25*1024*1024;

// The login agent runs with a bare PATH, so look where Homebrew installs things.
const BIN_DIRS=["/opt/homebrew/bin","/usr/local/bin","/usr/bin"];
const which=(name:string)=>BIN_DIRS.map(dir=>join(dir,name)).find(existsSync);

// whisper.cpp models, in the order we'd rather use them: fast enough on a Mac, good enough to send.
const MODEL_DIRS=()=>[join(homedir(),".iterm-web","models"),join(homedir(),".cache","whisper.cpp")];
const MODEL_ORDER=["large-v3-turbo","small.en","small","base.en","base","medium.en","medium","tiny.en","tiny"];
function findModel() {
  const configured=process.env.ITERM_WEB_WHISPER_MODEL;
  if(configured)return existsSync(configured)?configured:undefined;
  const found=MODEL_DIRS().flatMap(dir=>{try{return readdirSync(dir).filter(f=>/^ggml-.+\.bin$/.test(f)).map(f=>join(dir,f));}catch{return [];}});
  const rank=(path:string)=>{const i=MODEL_ORDER.findIndex(m=>path.endsWith(`ggml-${m}.bin`));return i<0?MODEL_ORDER.length:i;};
  return found.sort((a,b)=>rank(a)-rank(b))[0];
}

export interface Transcriber { available():boolean; transcribe(audio:Buffer,signal:AbortSignal):Promise<string>; }

// Speech to text on the Mac with whisper.cpp: ffmpeg turns the phone's recording
// (webm or mp4) into 16 kHz WAV, then whisper-cli prints the text. Nothing leaves the machine.
export const whisper:Transcriber={
  available:()=>!!(which("whisper-cli") && which("ffmpeg") && findModel()),
  async transcribe(audio,signal) {
    const whisperCli=which("whisper-cli"),ffmpeg=which("ffmpeg"),model=findModel();
    if(!whisperCli || !ffmpeg || !model)throw Error("Voice input needs whisper-cli, ffmpeg and a whisper model on your Mac. Run `brew install whisper-cpp ffmpeg`.");
    const dir=await mkdtemp(join(tmpdir(),"iterm-web-voice-"));
    try {
      await writeFile(join(dir,"in"),audio,{mode:0o600});
      const run=promisify(execFile);
      await run(ffmpeg,["-nostdin","-loglevel","error","-i",join(dir,"in"),"-ar","16000","-ac","1","-f","wav",join(dir,"in.wav")],{signal,timeout:30000});
      const {stdout}=await run(whisperCli,["-m",model,"-f",join(dir,"in.wav"),"-nt","-np","-l",/\.en\.bin$/.test(model)?"en":"auto"],{signal,timeout:60000,maxBuffer:1024*1024});
      // whisper marks silence and noise as [BLANK_AUDIO], (music) and the like.
      return stdout.replace(/\[[A-Z_ ]+\]|\((?:music|silence|noise|inaudible)\)/gi,"").replace(/\s+/g," ").trim();
    } finally {await rm(dir,{recursive:true,force:true});}
  },
};
