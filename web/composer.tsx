import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, type InputSkill, type Upload } from "./api";
import { CloseIcon, EditIcon, MicIcon, PlusIcon, SendIcon } from "./icons";
import { useVoice, useVoiceAvailable } from "./voice";

type Attachment = { id:string; name:string; upload?:Upload; error?:string };
const finePointer=()=>window.matchMedia("(pointer: fine)").matches;

// The message box. In Claude mode it sends one bracketed paste plus Enter, with
// attachment paths; in terminal mode it types the text and presses Enter.
export function Composer({sessionId,mode,disabled,sendClaude,sendText}:{
  sessionId:string; mode:"claude"|"terminal"; disabled:boolean;
  sendClaude:(text:string,files:Upload[])=>Promise<void>;
  sendText:(text:string)=>Promise<void>;
}) {
  const draftKey=`draft:${sessionId}`;
  const [text,setText]=useState(()=>localStorage.getItem(draftKey) || "");
  const [files,setFiles]=useState<Attachment[]>([]);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const [skills,setSkills]=useState<InputSkill[]|null>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  const picker=useRef<HTMLInputElement>(null);
  const voiceAvailable=useVoiceAvailable();
  const voice=useVoice(setError);

  useEffect(()=>{try{text?localStorage.setItem(draftKey,text):localStorage.removeItem(draftKey);}catch{}},[text,draftKey]);
  useLayoutEffect(()=>{
    const el=input.current;if(!el)return;
    el.style.height="auto";
    el.style.height=`${Math.min(el.scrollHeight,Math.max(120,(window.visualViewport?.height || window.innerHeight)*.4))}px`;
  },[text]);

  // Slash suggestions while typing the first word.
  const slash=mode==="claude" && /^\/[\w:.\/-]*$/.test(text)?text.slice(1).toLowerCase():null;
  useEffect(()=>{
    if(slash===null || skills)return;
    api.skills(sessionId).then(r=>setSkills(r.skills),()=>setSkills([]));
  },[slash,skills,sessionId]);
  const suggestions=slash===null || !skills?[]:skills
    .filter(s=>s.command.toLowerCase().includes(slash) || s.label.toLowerCase().includes(slash))
    .sort((a,b)=>Number(!a.command.toLowerCase().startsWith(slash))-Number(!b.command.toLowerCase().startsWith(slash)))
    .slice(0,8);

  async function attach(list:FileList|null) {
    for(const file of Array.from(list || []).slice(0,10-files.length)){
      const id=crypto.randomUUID();
      setFiles(f=>[...f,{id,name:file.name}]);
      try {const upload=await api.upload(sessionId,file);setFiles(f=>f.map(a=>a.id===id?{...a,upload}:a));}
      catch(e){setFiles(f=>f.map(a=>a.id===id?{...a,error:errorMessage(e)}:a));}
    }
  }

  const uploading=files.some(f=>!f.upload && !f.error);
  const ready=files.filter(f=>f.upload).map(f=>f.upload!);
  const canSend=!disabled && !sending && !uploading && (mode==="claude"?!!text.trim() || ready.length>0:text.length>0);

  // Clear right away so sending feels instant; put the draft back if it fails.
  async function send(spoken?:string) {
    if(spoken===undefined?!canSend:disabled || sending || uploading)return;
    const draft={text:spoken ?? text,files};
    setSending(true);setError("");setText("");setFiles([]);
    input.current?.focus();
    try {
      if(mode==="claude")await sendClaude(draft.text.trim(),ready);
      else await sendText(draft.text);
    } catch(e){
      setError(errorMessage(e));
      setText(current=>current || draft.text);setFiles(current=>current.length?current:draft.files);
    }
    finally{setSending(false);}
  }

  // Voice: the mic shows while the box is empty. Stop to send what you said, or to edit it first.
  const showMic=mode==="claude" && voiceAvailable && !text && !files.length;
  async function finishVoice(edit:boolean) {
    setError("");
    const spoken=await voice.stop();
    if(!spoken)return;
    if(edit){setText(t=>t?`${t} ${spoken}`:spoken);input.current?.focus();}
    else await send(spoken);
  }

  if(voice.state!=="idle")return <div className="composer">
    {error && <p className="composer-error" role="alert">{error}</p>}
    <div className="composer-row voice-row">
      <button type="button" className="round-button attach" aria-label="Cancel recording" disabled={voice.state==="transcribing"} onClick={voice.cancel}><CloseIcon /></button>
      <div className="voice-meter" data-state={voice.state} aria-live="polite">
        {voice.state==="recording"?<>
          <span className="voice-dot" style={{transform:`scale(${1+voice.level*1.2})`}} />
          <span>{Math.floor(voice.seconds/60)}:{String(voice.seconds%60).padStart(2,"0")}</span>
          <span className="voice-hint">Listening…</span>
        </>:<span className="voice-hint">Transcribing…</span>}
      </div>
      <button type="button" className="round-button attach" aria-label="Stop and edit" disabled={voice.state==="transcribing"} onClick={()=>void finishVoice(true)}><EditIcon /></button>
      <button type="button" className="round-button send" aria-label="Stop and send" disabled={voice.state==="transcribing"} onClick={()=>void finishVoice(false)}>{voice.state==="transcribing"?"…":<SendIcon />}</button>
    </div>
  </div>;

  return <div className="composer">
    {suggestions.length>0 && <div className="suggestions" role="listbox">
      {suggestions.map(s=><button key={s.command} type="button" role="option" className="suggestion" onMouseDown={e=>e.preventDefault()} onClick={()=>{setText(`/${s.command} `);input.current?.focus();}}>
        <span className="suggestion-command">/{s.command}{s.hint && <span className="suggestion-hint"> {s.hint}</span>}</span>
        <span className="suggestion-desc">{s.description}</span>
      </button>)}
    </div>}
    {error && <p className="composer-error" role="alert">{error}</p>}
    {files.length>0 && <div className="chips">{files.map(f=><span key={f.id} className="chip" data-state={f.error?"error":f.upload?"ready":"uploading"} title={f.error}>
      <span className="truncate">{f.name}</span>
      <button type="button" aria-label={`Remove ${f.name}`} onClick={()=>setFiles(list=>list.filter(a=>a.id!==f.id))}>×</button>
    </span>)}</div>}
    <div className="composer-row">
      {mode==="claude" && <>
        <button type="button" className="round-button attach" aria-label="Attach files" disabled={disabled || files.length>=10} onClick={()=>picker.current?.click()}><PlusIcon /></button>
        <input ref={picker} type="file" multiple hidden onChange={e=>{void attach(e.target.files);e.target.value="";}} />
      </>}
      <textarea ref={input} rows={1} value={text} maxLength={16000} enterKeyHint={mode==="terminal"?"send":"enter"}
        placeholder={mode==="claude"?"Message Claude":"Type a command"}
        autoCapitalize={mode==="terminal"?"off":"sentences"} autoCorrect={mode==="terminal"?"off":"on"} spellCheck={mode==="claude"}
        onChange={e=>setText(e.target.value)}
        onKeyDown={e=>{
          if(e.key!=="Enter" || e.nativeEvent.isComposing)return;
          if(e.metaKey || e.ctrlKey || ((finePointer() || mode==="terminal") && !e.shiftKey)){e.preventDefault();void send();}
        }} />
      {showMic && !sending
        ?<button type="button" className="round-button send" aria-label="Talk" disabled={disabled} onClick={()=>{setError("");void voice.start();}}><MicIcon /></button>
        :<button type="button" className="round-button send" aria-label="Send" disabled={!canSend} onClick={()=>void send()}>{sending?"…":<SendIcon />}</button>}
    </div>
  </div>;
}
