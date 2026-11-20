import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { CONFIG_DIR, envVar } from "./config";

// Hands-free mode's voice: Kokoro, a small neural voice, on the Mac with mlx-audio.
// It's optional; without it the phone speaks with its own voices. Set up with:
//   uv venv ~/.afkterm/tts/.venv --python 3.12
//   VIRTUAL_ENV=~/.afkterm/tts/.venv uv pip install mlx-audio "misaki[en]"
// The model stays loaded while it's in use (about 550MB) and is stopped after
// ten idle minutes, so it costs nothing when you aren't talking.

export const MAX_SPEECH_CHARS=1200;
const IDLE=10*60*1000, TIMEOUT=30000;
const venv=()=>envVar("TTS_VENV") || join(CONFIG_DIR,"tts",".venv");
const python=()=>join(venv(),"bin","python");

// Libraries print to stdout as they go, so replies use a copy of the real stdout
// and everything else goes to stderr. A warm-up line makes the first reply quick.
const WORKER=String.raw`
import json, os, sys
out = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)
import numpy as np
from mlx_audio.tts.utils import load_model
from mlx_audio.audio_io import write
model = load_model(model_path=os.environ.get("AFKTERM_TTS_MODEL", "mlx-community/Kokoro-82M-bf16"))
def say(text, voice, speed):
    chunks = [np.asarray(r.audio) for r in model.generate(text=text, voice=voice or "af_heart", speed=speed or 1.0, lang_code="a", verbose=False)]
    return np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
say("Ready.", None, None)
print(json.dumps({"ready": True}), file=out, flush=True)
for line in sys.stdin:
    req = None
    try:
        req = json.loads(line)
        write(req["out"], say(req["text"], req.get("voice"), req.get("speed")), model.sample_rate, format="wav")
        print(json.dumps({"id": req["id"], "ok": True}), file=out, flush=True)
    except Exception as e:
        print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "error": str(e)[:300]}), file=out, flush=True)
`;

export interface Speaker { available():boolean; speak(text:string,signal:AbortSignal):Promise<Buffer>; }

type Waiter={resolve:(ok:boolean)=>void;reject:(e:Error)=>void};
let worker:{child:ChildProcess;ready:Promise<void>;waiting:Map<string,Waiter>}|null=null;
let idle:ReturnType<typeof setTimeout>|undefined;
let queue:Promise<unknown>=Promise.resolve();
let next=0;

function stop() {
  clearTimeout(idle);
  worker?.child.kill();worker=null;
}
process.on("exit",stop);

function start() {
  const child=spawn(python(),["-c",WORKER],{stdio:["pipe","pipe","ignore"],env:{...process.env,VIRTUAL_ENV:venv(),HF_HUB_DISABLE_PROGRESS_BARS:"1",TOKENIZERS_PARALLELISM:"false"}});
  const waiting=new Map<string,Waiter>();
  let ready!:()=>void, failed!:(e:Error)=>void;
  const w={child,waiting,ready:new Promise<void>((res,rej)=>{ready=res;failed=rej;})};
  createInterface({input:child.stdout!}).on("line",line=>{
    let msg:any;try{msg=JSON.parse(line);}catch{return;}
    if(msg.ready)return ready();
    const waiter=waiting.get(msg.id);if(!waiter)return;
    waiting.delete(msg.id);
    msg.ok?waiter.resolve(true):waiter.reject(Error(`The Mac's voice failed: ${msg.error}`));
  });
  child.on("exit",()=>{
    failed(Error("The Mac's voice stopped before it was ready."));
    for(const waiter of waiting.values())waiter.reject(Error("The Mac's voice stopped."));
    if(worker===w)worker=null;
  });
  return w;
}

async function synthesize(text:string,dir:string,signal:AbortSignal) {
  worker??=start();
  const w=worker;
  await w.ready;
  signal.throwIfAborted();
  const id=String(++next), wav=join(dir,"out.wav");
  const done=new Promise<boolean>((resolve,reject)=>{
    w.waiting.set(id,{resolve,reject});
    setTimeout(()=>{if(w.waiting.delete(id)){reject(Error("The Mac's voice took too long."));stop();}},TIMEOUT);
  });
  w.child.stdin!.write(JSON.stringify({id,text,out:wav,voice:envVar("TTS_VOICE") || undefined})+"\n");
  await done;
  // AAC is about a tenth the size of WAV, which matters on a phone's data.
  const m4a=join(dir,"out.m4a");
  await promisify(execFile)("/usr/bin/afconvert",["-f","m4af","-d","aac","-b","64000",wav,m4a],{timeout:15000});
  return readFile(m4a);
}

export const kokoro:Speaker={
  available:()=>process.platform==="darwin" && existsSync(python()) && existsSync(join(venv(),"lib")) && !/^(?:0|off|false|no)$/i.test(envVar("TTS") || ""),
  speak(text,signal) {
    // One at a time: the model isn't shared between requests.
    const run=queue.then(async()=>{
      clearTimeout(idle);
      const dir=await mkdtemp(join(tmpdir(),"afkterm-speech-"));
      try {return await synthesize(text.slice(0,MAX_SPEECH_CHARS),dir,signal);}
      finally {
        await rm(dir,{recursive:true,force:true});
        idle=setTimeout(stop,IDLE);
      }
    });
    queue=run.catch(()=>{});
    return run;
  },
};
