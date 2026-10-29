import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

// Whether the Mac can transcribe, asked once per app load.
let available:Promise<boolean>|null=null;
export function useVoiceAvailable() {
  const [ok,setOk]=useState(false);
  useEffect(()=>{
    if(!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==="undefined")return;
    available??=api.me().then(me=>!!me.voice,()=>{available=null;return false;});
    let live=true;
    void available.then(v=>{if(live)setOk(v);});
    return ()=>{live=false;};
  },[]);
  return ok;
}

type Recording={stream:MediaStream;recorder:MediaRecorder;chunks:Blob[];started:number;audio:AudioContext;loudest:number};
export type VoiceState="idle"|"recording"|"transcribing";

// Tap to record, then stop() to get the text back from whisper on the Mac.
export function useVoice(onError:(message:string)=>void) {
  const [state,setState]=useState<VoiceState>("idle");
  const [level,setLevel]=useState(0);
  const [seconds,setSeconds]=useState(0);
  const rec=useRef<Recording|null>(null);

  function release() {
    const r=rec.current;rec.current=null;
    if(!r)return;
    if(r.recorder.state!=="inactive")r.recorder.stop();
    r.stream.getTracks().forEach(t=>t.stop());
    void r.audio.close().catch(()=>{});
  }
  useEffect(()=>release,[]);

  async function start() {
    if(rec.current)return;
    // Made before any await, while the tap still counts as a gesture, or iOS leaves it suspended.
    const audio=new AudioContext();
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
      const recorder=new MediaRecorder(stream);
      void audio.resume().catch(()=>{});
      const analyser=audio.createAnalyser();analyser.fftSize=256;
      audio.createMediaStreamSource(stream).connect(analyser);
      const r:Recording={stream,recorder,chunks:[],started:Date.now(),audio,loudest:0};
      recorder.ondataavailable=e=>{if(e.data.size)r.chunks.push(e.data);};
      recorder.start(250);
      rec.current=r;
      setState("recording");setSeconds(0);
      // A loudness meter and timer, so it's obvious the mic is hearing you.
      const samples=new Uint8Array(analyser.fftSize);
      const tick=()=>{
        if(rec.current!==r)return;
        analyser.getByteTimeDomainData(samples);
        let peak=0;for(const v of samples)peak=Math.max(peak,Math.abs(v-128));
        const level=Math.min(1,peak/64);
        r.loudest=Math.max(r.loudest,level);
        setLevel(level);
        setSeconds(Math.floor((Date.now()-r.started)/1000));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch(e) {
      void audio.close().catch(()=>{});
      release();setState("idle");
      onError(e instanceof DOMException && e.name==="NotAllowedError"?"Microphone access was denied. Allow it in Settings for this site, then try again.":errorMessage(e));
    }
  }

  function cancel() {release();setState("idle");}

  // Resolves to the transcript, or "" if there was nothing to hear.
  async function stop():Promise<string> {
    const r=rec.current;if(!r)return "";
    const done=new Promise<void>(resolve=>{r.recorder.onstop=()=>resolve();});
    const short=Date.now()-r.started<500;
    const metered=r.audio.state==="running";
    release();
    if(short){setState("idle");return "";}
    // Whisper invents words ("you") for silence, so don't send a recording nobody spoke in.
    if(metered && r.loudest<.08){setState("idle");onError("Didn't hear anything. Check the mic and try again.");return "";}
    setState("transcribing");
    try {
      await done;
      const text=(await api.transcribe(new Blob(r.chunks,{type:r.recorder.mimeType}))).text;
      if(!text)onError("Didn't catch that. Try again a little closer to the mic.");
      return text;
    } catch(e){onError(errorMessage(e));return "";}
    finally{setState("idle");}
  }

  return {state,level,seconds,start,stop,cancel};
}
