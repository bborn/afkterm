import { useEffect, useRef, useState } from "react";
import { agentName, api, errorMessage, useStoredState, type ClaudeView } from "./api";
import { command, groupParts, heardNothing, newSpeech, type Speech, type SpeechState } from "./speech-text";
import { SpeechDetector } from "./speech-detector";

// Hands-free: talk to Claude in one tab and hear its replies. While Claude isn't
// speaking, the mic listens; a pause ends what you said, Whisper on the Mac writes it
// down, and it's sent. When Claude's turn ends, its reply is read aloud in parts,
// with the sentence being read shown large enough to glance at.

const SETTLE=1500;

// iOS only lets a page make sound or speak after a tap, so this runs in the tap
// that turns hands-free on.
let audio:AudioContext|null=null;
export function unlockAudio() {
  audio??=new AudioContext();
  void audio.resume().catch(()=>{});
  // A silent buffer and an empty utterance, so both kinds of playback are allowed later.
  try {const s=audio.createBufferSource();s.buffer=audio.createBuffer(1,1,22050);s.connect(audio.destination);s.start();} catch {}
  try {speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(""));} catch {}
}
export const handsFreeSupported=()=>!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder!=="undefined" && "speechSynthesis" in window;

function beep(freqs:number[],ms=90) {
  if(!audio)return;
  let at=audio.currentTime;
  for(const freq of freqs){
    const osc=audio.createOscillator(), gain=audio.createGain();
    osc.frequency.value=freq;gain.gain.setValueAtTime(.0001,at);
    gain.gain.exponentialRampToValueAtTime(.15,at+.01);gain.gain.exponentialRampToValueAtTime(.0001,at+ms/1000);
    osc.connect(gain).connect(audio.destination);osc.start(at);osc.stop(at+ms/1000+.02);
    at+=ms/1000;
  }
}
const sentSound=()=>beep([660,880]), missedSound=()=>beep([440,330],120), errorSound=()=>beep([300,220],160);

// The Mac's voice when it's set up, asked once per app load.
let macVoice:Promise<boolean>|null=null;
const hasMacVoice=()=>macVoice??=api.me().then(me=>!!me.speech,()=>{macVoice=null;return false;});

// The phone's best English voice: one you downloaded (Premium, then Enhanced) beats the default.
function phoneVoice() {
  const voices=speechSynthesis.getVoices().filter(v=>/^en[-_]/i.test(v.lang));
  const rank=(v:SpeechSynthesisVoice)=>(/premium/i.test(v.voiceURI+v.name)?0:/enhanced/i.test(v.voiceURI+v.name)?1:2)+(/^en[-_]US/i.test(v.lang)?0:.5);
  return voices.sort((a,b)=>rank(a)-rank(b))[0];
}
function speakOnPhone(text:string,signal:AbortSignal):Promise<void> {
  return new Promise(resolve=>{
    if(signal.aborted)return resolve();
    const u=new SpeechSynthesisUtterance(text);
    const voice=phoneVoice();if(voice){u.voice=voice;u.lang=voice.lang;}
    // iOS sometimes never fires `end`, so give up after the time the words should take.
    const timer=setTimeout(done,text.split(/\s+/).length*600+4000);
    function done(){clearTimeout(timer);signal.removeEventListener("abort",abort);resolve();}
    function abort(){speechSynthesis.cancel();done();}
    u.onend=done;u.onerror=done;
    signal.addEventListener("abort",abort);
    speechSynthesis.speak(u);
  });
}
async function play(data:ArrayBuffer,signal:AbortSignal) {
  if(!audio || signal.aborted)return;
  const buffer=await audio.decodeAudioData(data);
  if(signal.aborted)return;
  await new Promise<void>(resolve=>{
    const source=audio!.createBufferSource();source.buffer=buffer;source.connect(audio!.destination);
    const abort=()=>{try{source.stop();}catch{}};
    source.onended=()=>{signal.removeEventListener("abort",abort);resolve();};
    signal.addEventListener("abort",abort);
    source.start();
  });
}

const sentences=(part:string)=>part.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(s=>s.trim()).filter(Boolean) ?? [part];

export type Phase="listening"|"hearing"|"transcribing"|"speaking"|"waiting-on-you"|"error";
interface Display {phase:Phase;level:number;heard:string;sentence:string;before:string;note:string;error:string}

// The last thing Claude said in its own words, once its turn is over.
function reply(view:ClaudeView|undefined) {
  if(!view || view.working || view.prompt || view.question)return null;
  const last=view.messages.findLast(m=>m.role!=="tool");
  return last?.role==="assistant"?last:null;
}

class Loop {
  closed=false;
  view?:ClaudeView;
  private heard:SpeechState={spoken:new Map(),finished:new Set()};
  private queue:Speech[]=[];
  private signature="";
  private startedAt=Date.now();
  private more:string[]=[];
  private lastParts:string[]=[];
  private listening:AbortController|null=null;
  private talking=false;
  private speaking:AbortController|null=null;
  private wake?:()=>void;
  private detector=new SpeechDetector();
  private loggedFloor=false;
  private settle?:ReturnType<typeof setTimeout>;
  private lock:WakeLockSentinel|null=null;
  private events:string[]=[];
  private flush?:ReturnType<typeof setInterval>;
  constructor(private hooks:{send:(text:string)=>Promise<void>;stop:()=>void;exit:()=>void;bargeIn:()=>boolean;show:(d:Partial<Display>)=>void}){}

  // A trail of what happened, sent to the Mac's log: names and sizes, never words.
  private log(event:string) {
    this.events.push(`${new Date().toISOString().slice(11,23)} ${event}`.slice(0,120));
    if(this.events.length>=40)this.send();
  }
  private send() {
    if(!this.events.length)return;
    const events=this.events;this.events=[];
    void api.handsFreeLog(events).catch(()=>{});
  }

  start(view:ClaudeView|undefined) {
    void api.warmVoice();
    this.view=view;
    // Only what Claude says from now on is read.
    for(const m of view?.messages ?? [])if(m.role==="assistant")this.heard.finished.add(m.id);
    this.log(`start working=${!!view?.working} messages=${view?.messages.length ?? 0}`);
    void this.keepAwake();
    document.addEventListener("visibilitychange",this.visible);
    this.flush=setInterval(()=>this.send(),4000);
    // Loads the Mac's voice now, so the first reply doesn't wait for it.
    void hasMacVoice().then(mac=>{if(mac)void api.speak("Ready.").catch(()=>{});});
    void this.run();
  }
  close() {
    this.log("exit");this.send();
    this.closed=true;clearTimeout(this.settle);clearInterval(this.flush);
    this.listening?.abort();this.speaking?.abort();
    document.removeEventListener("visibilitychange",this.visible);
    void this.lock?.release().catch(()=>{});
    this.wake?.();
  }
  private visible=()=>{
    this.log(`visibility ${document.visibilityState}`);
    if(document.visibilityState==="visible")void this.keepAwake();
  };
  private async keepAwake() {
    try {this.lock=await navigator.wakeLock?.request("screen") ?? null;} catch {}
  }

  // Claude's words count once the transcript has held still for a moment.
  update(view:ClaudeView|undefined) {
    this.view=view;
    const last=view?.messages.findLast(m=>m.role==="assistant");
    const signature=`${last?.id}:${last?.text.length}:${reply(view)?.id}`;
    if(signature!==this.signature){
      this.signature=signature;clearTimeout(this.settle);
      this.settle=setTimeout(()=>this.collect(),SETTLE);
    }
    if(!view?.prompt && !view?.question)this.wake?.();
  }
  private collect() {
    // The view open when hands-free started can be a moment behind the transcript,
    // so whatever shows up in the first few seconds is old, not new.
    if(Date.now()<this.startedAt+4000){
      for(const m of this.view?.messages ?? [])if(m.role==="assistant")this.heard.finished.add(m.id);
      return;
    }
    const items=newSpeech(this.view?.messages ?? [],reply(this.view)?.id ?? null,this.heard);
    if(!items.length)return;
    // A newer update replaces one that hasn't been read yet.
    this.queue=[...this.queue.filter(q=>q.final || !items.some(i=>!i.final)),...items];
    for(const i of items)this.log(`${i.final?"reply":"update"} sentences=${i.sentences.length} talking=${this.talking}`);
    // Interrupt listening, unless you're in the middle of saying something.
    if(!this.talking)this.listening?.abort();
  }
  // Tapping the screen while Claude is speaking skips the rest.
  skip() {if(this.speaking){this.log("skip");this.more=[];this.speaking.abort();}}

  private async run() {
    while(!this.closed){
      try {
        const next=this.queue.shift();
        if(next){
          if(!this.hooks.bargeIn()){await this.sayItem(next);continue;}
          // Talking over Claude: listen while it speaks, and stop it when you start.
          const speaking=this.sayItem(next);
          const clip=await this.listen(true);
          await speaking;
          if(clip)await this.handle(clip);
          continue;
        }
        if(this.view?.prompt || this.view?.question){
          this.hooks.show({phase:"waiting-on-you"});
          this.log("waiting-on-you");
          await this.sayOnce(`${agentName(this.view?.agent)} is asking you something. Answer it on the screen.`);
          if(this.view?.prompt || this.view?.question)await new Promise<void>(resolve=>{this.wake=resolve;});
          this.wake=undefined;continue;
        }
        const clip=await this.listen();
        if(clip)await this.handle(clip);
      } catch(e) {
        errorSound();
        this.log(`error ${errorMessage(e).slice(0,80)}`);
        if(e instanceof DOMException && e.name==="NotAllowedError"){
          this.hooks.show({phase:"error",error:"Microphone access was denied. Allow it for this site, then turn hands-free on again."});
          return;
        }
        this.hooks.show({phase:"error",error:errorMessage(e)});
        await new Promise(r=>setTimeout(r,3000));
      }
    }
  }

  private sayItem(item:Speech) {
    if(!item.final)return this.say([item.sentences.join(" ")],false);
    const parts=groupParts(item.sentences);
    if(parts.length)this.lastParts=parts;
    return this.say(parts);
  }
  // Reads the first part sentence by sentence, then offers the rest.
  private async say(parts:string[],offerMore=true) {
    if(!parts.length)return;
    const controller=this.speaking=new AbortController();
    const signal=controller.signal;
    const lines=sentences(parts[0]);
    const mac=await hasMacVoice();
    this.log(`speak voice=${mac?"mac":"phone"} sentences=${lines.length} parts=${parts.length}`);
    // The Mac's audio for the next sentence is fetched while this one plays.
    const fetched=new Map<number,Promise<ArrayBuffer|null>>();
    const fetchLine=(i:number)=>{
      if(!mac || i>=lines.length)return;
      if(!fetched.has(i))fetched.set(i,api.speak(lines[i],signal).catch(e=>{this.log(`mac-voice-failed ${errorMessage(e).slice(0,60)}`);return null;}));
    };
    fetchLine(0);fetchLine(1);
    for(const [i,line] of lines.entries()){
      if(signal.aborted)break;
      this.hooks.show({phase:"speaking",sentence:line,before:i?lines[i-1]:"",note:""});
      fetchLine(i+1);fetchLine(i+2);
      const data=mac?await fetched.get(i):null;
      if(data)await play(data,signal).catch(()=>speakOnPhone(line,signal));
      else await speakOnPhone(line,signal);
    }
    if(offerMore)this.more=signal.aborted?[]:parts.slice(1);
    if(offerMore && this.more.length){
      this.hooks.show({sentence:"There's more. Want to hear it?",before:lines.at(-1) ?? ""});
      const offer="There's more. Want to hear it?";
      const data=mac?await api.speak(offer,signal).catch(()=>null):null;
      if(data)await play(data,signal).catch(()=>{});else await speakOnPhone(offer,signal);
    }
    if(this.speaking===controller)this.speaking=null;
    this.log(`speak-done aborted=${signal.aborted} more=${this.more.length}`);
  }
  private asked=new Set<string>();
  private async sayOnce(text:string) {
    const key=this.view?.prompt?.text ?? this.view?.question?.prompt ?? text;
    if(this.asked.has(key))return;
    this.asked.add(key);
    this.hooks.show({sentence:text,before:""});
    this.speaking=new AbortController();
    await speakOnPhone(text,this.speaking.signal);
    this.speaking=null;
  }

  private async handle(clip:Blob) {
    this.hooks.show({phase:"transcribing",note:""});
    const text=(await api.transcribe(clip)).text.trim();
    this.log(`transcribed chars=${text.length}`);
    if(!text || heardNothing(text)){
      // Say so, rather than going quietly back to listening.
      this.log(`dropped ${text?"noise":"empty"}`);
      missedSound();
      this.hooks.show({phase:"listening",note:"Didn't catch that. Say it again?"});
      return;
    }
    this.hooks.show({heard:text,sentence:"",before:""});
    const offeringMore=this.more.length>0;
    const said=command(text,offeringMore);
    if(said)this.log(`command ${said}`);
    if(said==="exit"){this.hooks.exit();return;}
    if(said==="stop"){this.more=[];this.hooks.stop();sentSound();return;}
    if(said==="repeat"){await this.say(this.lastParts);return;}
    if(said==="more"){await this.say(this.more);return;}
    if(said==="no-more"){this.more=[];return;}
    this.more=[];
    const busy=!!this.view?.working;
    await this.hooks.send(text);
    this.log(`sent busy=${busy}`);
    sentSound();
    // Claude reads it once it's done with what it's on, so say why nothing comes back yet.
    if(busy)this.hooks.show({note:`Sent. ${agentName(this.view?.agent)} will get to it when it finishes what it's doing.`});
  }

  // One utterance: the mic is on only while listening, so iOS plays Claude's
  // voice through the speaker rather than the earpiece.
  private async listen(overSpeech=false):Promise<Blob|null> {
    if(!overSpeech)this.hooks.show({phase:"listening",level:0});
    const controller=this.listening=new AbortController();
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    try {
      if(controller.signal.aborted || this.closed)return null;
      audio??=new AudioContext();
      void audio.resume().catch(()=>{});
      const analyser=audio.createAnalyser();analyser.fftSize=1024;
      const source=audio.createMediaStreamSource(stream);source.connect(analyser);
      const recorder=new MediaRecorder(stream);
      const chunks:Blob[]=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.start(250);
      const samples=new Float32Array(analyser.fftSize);
      const detector=this.detector;detector.reset();
      const spoke=await new Promise<boolean>(resolve=>{
        const finish=(v:boolean)=>{controller.signal.removeEventListener("abort",abort);resolve(v);};
        const abort=()=>finish(false);
        controller.signal.addEventListener("abort",abort);
        const calibrated=!!detector.floor;
        let wasSpeaking=overSpeech;
        const tick=()=>{
          if(controller.signal.aborted)return;
          analyser.getFloatTimeDomainData(samples);
          let sum=0;for(const v of samples)sum+=v*v;
          const speaking=!!this.speaking;
          const event=detector.push(Math.sqrt(sum/samples.length),Date.now(),speaking);
          if(wasSpeaking && !speaking)this.hooks.show({phase:"listening"});
          wasSpeaking=speaking;
          if(event!=="calibrating" && !calibrated && !this.loggedFloor){this.loggedFloor=true;this.log(`calibrated floor=${detector.floor.toFixed(4)}`);}
          if(!speaking)this.hooks.show({level:detector.level});
          if(event==="onset" && speaking){this.log("talked-over");this.more=[];this.speaking?.abort();}
          if(event==="onset"){this.talking=true;this.hooks.show({phase:"hearing",note:""});this.log("onset");}
          if(event==="pause" || event==="max"){this.log(`end ${event}`);return finish(true);}
          if(event==="idle")return finish(false);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const stopped=new Promise<void>(r=>{recorder.onstop=()=>r();});
      recorder.stop();await stopped;
      source.disconnect();
      const clip=spoke && chunks.length?new Blob(chunks,{type:recorder.mimeType}):null;
      if(spoke)this.log(`clip bytes=${clip?.size ?? 0} ms=${Date.now()-detector.talkingSince}`);
      return clip;
    } finally {
      this.talking=false;
      stream.getTracks().forEach(t=>t.stop());
      if(this.listening===controller)this.listening=null;
    }
  }
}

export function HandsFree({view,send,stop,exit}:{view:ClaudeView|undefined;send:(text:string)=>Promise<void>;stop:()=>void;exit:()=>void}) {
  const name=agentName(view?.agent);
  const [d,setD]=useState<Display>({phase:"listening",level:0,heard:"",sentence:"",before:"",note:"",error:""});
  const loop=useRef<Loop|null>(null);
  // Off by default: with the mic on, an iPhone without headphones plays speech
  // through the quiet earpiece. Fine in the car or with AirPods.
  const [talkOver,setTalkOver]=useStoredState("hands-free-talk-over",false);
  const hooks=useRef({send,stop,exit,talkOver});hooks.current={send,stop,exit,talkOver};
  useEffect(()=>{
    const l=new Loop({
      send:t=>hooks.current.send(t),stop:()=>hooks.current.stop(),exit:()=>hooks.current.exit(),bargeIn:()=>hooks.current.talkOver,
      show:p=>setD(d=>({...d,...(p.phase && p.phase!=="error"?{error:""}:{}),...p})),
    });
    loop.current=l;l.start(view);
    return ()=>l.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{loop.current?.update(view);},[view]);
  const working=!!view?.working;
  const listening=d.phase==="listening" || d.phase==="hearing";
  const label=d.phase==="error"?"Something went wrong"
    :d.phase==="speaking"?name
    :d.phase==="transcribing"?"Got it"
    :d.phase==="waiting-on-you"?`${name} needs you`
    :d.phase==="hearing"?"Listening"
    :working?`${name} is working`:"Listening";
  const hint=d.phase==="speaking"?(talkOver?"Talk to interrupt, or tap to skip":"Tap to skip")
    :d.phase==="waiting-on-you"?"Answer on screen, then hands-free carries on"
    :working?"Say “stop” to interrupt":"Pause when you're done";
  // The big text: what Claude is saying, else what you just said, else a note.
  const big=d.phase==="error"?d.error
    :d.phase==="speaking" || d.phase==="waiting-on-you"?d.sentence
    :d.phase==="transcribing"?"…"
    :d.note || d.heard;
  return <div className="handsfree" data-phase={d.phase} onClick={()=>loop.current?.skip()}>
    <div className="handsfree-top">
      <span className="handsfree-dot" />
      <span className="handsfree-label">{label}</span>
      <button type="button" className="handsfree-toggle" aria-pressed={talkOver} onClick={e=>{e.stopPropagation();setTalkOver(!talkOver);}}>Talk over: {talkOver?"on":"off"}</button>
      <button type="button" className="handsfree-exit" onClick={e=>{e.stopPropagation();exit();}}>Exit</button>
    </div>
    <div className="handsfree-words">
      {d.phase==="speaking" && d.before && <p className="handsfree-before">{d.before}</p>}
      {big && <p className="handsfree-big" data-who={d.phase==="speaking" || d.phase==="waiting-on-you"?"claude":d.note?"note":"you"}>{big}</p>}
      {!big && listening && <p className="handsfree-big handsfree-quiet">Talk to {name}</p>}
    </div>
    <div className="handsfree-bottom">
      <div className="handsfree-meter"><span style={{transform:`scaleX(${listening?Math.max(.02,d.level):0})`}} /></div>
      <p className="handsfree-hint">{hint}</p>
    </div>
  </div>;
}
