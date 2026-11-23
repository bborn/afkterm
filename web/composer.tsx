import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, type InputSkill, type Upload } from "./api";
import { CloseIcon, EditIcon, MicIcon, PlusIcon, SendIcon } from "./icons";
import { useVoice, useVoiceAvailable } from "./voice";
import { pressEnd, slideCancels, type Press } from "./push-to-talk";
import { AttachmentTile, kindOf } from "./attachments";

// `preview` is a local copy of an image, shown until it's sent.
type Attachment = { id:string; name:string; upload?:Upload; error?:string; preview?:string };
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

  const [cleared,setCleared]=useState<string|null>(null);
  const [multiline,setMultiline]=useState(false);
  useEffect(()=>{if(cleared===null)return;const t=setTimeout(()=>setCleared(null),5000);return ()=>clearTimeout(t);},[cleared]);
  // More than one line, typed or wrapped.
  useEffect(()=>{
    const el=input.current;if(!el){setMultiline(false);return;}
    setMultiline(text.includes("\n") || el.scrollHeight>parseFloat(getComputedStyle(el).lineHeight)*1.6+18);
  },[text]);
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
      const preview=kindOf(file.name)==="image" || file.type.startsWith("image/")?URL.createObjectURL(file):undefined;
      setFiles(f=>[...f,{id,name:file.name,preview}]);
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

  // Voice: the mic shows while the box is empty. Hold it to talk and let go to send,
  // like Claude's push-to-talk; tap it to record hands-off, then stop to send or to edit.
  const showMic=mode==="claude" && voiceAvailable && !text && !files.length;
  async function finishVoice(edit:boolean) {
    setError("");
    const spoken=await voice.stop();
    if(!spoken)return;
    if(edit){setText(t=>t?`${t} ${spoken}`:spoken);input.current?.focus();}
    else await send(spoken);
  }

  // The press in progress. The talk button stays the same element while held, so
  // the pointer capture survives the composer switching to the recording row.
  const press=useRef<Press & {id:number;starting:Promise<void>}|null>(null);
  // Set by a press so the click that follows it is skipped; cleared if no click comes (a slid-off touch).
  const pressed=useRef(0);
  const [held,setHeld]=useState(false);
  const [cancelling,setCancelling]=useState(false);
  function pressDown(e:React.PointerEvent<HTMLButtonElement>) {
    if(e.button!==0 || press.current || voice.state!=="idle" || disabled || !showMic || sending)return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setError("");
    // Started here, in the gesture, so getUserMedia and the AudioContext are allowed.
    press.current={id:e.pointerId,at:Date.now(),x:e.clientX,y:e.clientY,starting:voice.start()};
    pressed.current=Date.now();
    setHeld(true);setCancelling(false);
  }
  async function pressUp(e:React.PointerEvent<HTMLButtonElement>,lost=false) {
    const p=press.current;if(!p || p.id!==e.pointerId)return;
    press.current=null;setHeld(false);setCancelling(false);
    const token=pressed.current;setTimeout(()=>{if(pressed.current===token)pressed.current=0;},500);
    voice.wake();
    // A system sheet (the first mic prompt) or a lost touch: keep recording with the stop buttons showing.
    const end=lost?"tap":pressEnd(p,Date.now(),e.clientX,e.clientY);
    await p.starting;
    if(end==="cancel")voice.cancel();
    else if(end==="send")await finishVoice(false);
  }

  const voiceOn=voice.state!=="idle" || held;
  const talk=held || (showMic && !sending && !voiceOn);
  const seconds=`${Math.floor(voice.seconds/60)}:${String(voice.seconds%60).padStart(2,"0")}`;

  return <div className="composer">
    {!voiceOn && suggestions.length>0 && <div className="suggestions" role="listbox">
      {suggestions.map(s=><button key={s.command} type="button" role="option" className="suggestion" onMouseDown={e=>e.preventDefault()} onClick={()=>{setText(`/${s.command} `);input.current?.focus();}}>
        <span className="suggestion-command">/{s.command}{s.hint && <span className="suggestion-hint"> {s.hint}</span>}</span>
        <span className="suggestion-desc">{s.description}</span>
      </button>)}
    </div>}
    {error && <p className="composer-error" role="alert">{error}</p>}
    {!voiceOn && files.length>0 && <div className="tiles">{files.map(f=><AttachmentTile key={f.id} name={f.name} src={f.preview}
      state={f.error?"error":f.upload?"ready":"uploading"} error={f.error}
      remove={()=>{if(f.preview)URL.revokeObjectURL(f.preview);setFiles(list=>list.filter(a=>a.id!==f.id));}} />)}</div>}
    <div className={voiceOn?"composer-row voice-row":"composer-row"}>
      {voiceOn?<>
        {!held && <button type="button" className="round-button attach" aria-label="Cancel recording" disabled={voice.state==="transcribing"} onClick={voice.cancel}><CloseIcon /></button>}
        <div className="voice-meter" data-state={voice.state} data-cancel={cancelling || undefined} aria-live="polite">
          {voice.state==="transcribing"?<span className="voice-hint">Transcribing…</span>:<>
            <span className="voice-dot" style={{transform:`scale(${1+voice.level*1.2})`}} />
            <span>{seconds}</span>
            <span className="voice-hint truncate">{!held?"Listening…":cancelling?"Release to cancel":"Release to send, slide ← to cancel"}</span>
          </>}
        </div>
        {!held && <button type="button" className="round-button attach" aria-label="Stop and edit" disabled={voice.state==="transcribing"} onClick={()=>void finishVoice(true)}><EditIcon /></button>}
      </>:<>
        {mode==="claude" && <>
          <button type="button" className="round-button attach" aria-label="Attach files" disabled={disabled || files.length>=10} onClick={()=>picker.current?.click()}><PlusIcon /></button>
          <input ref={picker} type="file" multiple hidden onChange={e=>{void attach(e.target.files);e.target.value="";}} />
        </>}
        <div className="field" data-clear={multiline || cleared!==null || undefined}>
        <textarea ref={input} rows={1} value={text} maxLength={16000} enterKeyHint={mode==="terminal"?"send":"enter"}
          placeholder={mode==="claude"?"Message Claude":"Type a command"}
          autoCapitalize={mode==="terminal"?"off":"sentences"} autoCorrect={mode==="terminal"?"off":"on"} spellCheck={mode==="claude"}
          onChange={e=>setText(e.target.value)}
          onKeyDown={e=>{
            if(e.key!=="Enter" || e.nativeEvent.isComposing)return;
            if(e.metaKey || e.ctrlKey || ((finePointer() || mode==="terminal") && !e.shiftKey)){e.preventDefault();void send();}
          }} />
          {/* Clearing a long draft by holding delete is slow on a phone. Undo stays for a few seconds after. */}
          {cleared!==null && !text?<button type="button" className="field-clear" data-undo onClick={()=>{setText(cleared);setCleared(null);input.current?.focus();}}>Undo</button>
            :multiline && <button type="button" className="field-clear" aria-label="Clear message" onMouseDown={e=>e.preventDefault()} onClick={()=>{setCleared(text);setText("");input.current?.focus();}}><CloseIcon /></button>}
        </div>
      </>}
      {/* One button in one place for talk, stop-and-send and send, so a held press keeps its element. */}
      <button type="button" className="round-button send" data-talk={talk || undefined} data-held={held || undefined}
        aria-label={held?"Release to send":talk?"Talk":voiceOn?"Stop and send":"Send"}
        disabled={talk?disabled && !held:voiceOn?voice.state==="transcribing":!canSend}
        onPointerDown={pressDown}
        onPointerMove={e=>{const p=press.current;if(p && p.id===e.pointerId)setCancelling(slideCancels(p,e.clientX,e.clientY));}}
        onPointerUp={e=>void pressUp(e)}
        onPointerCancel={e=>void pressUp(e,true)}
        onLostPointerCapture={e=>void pressUp(e,true)}
        // Keep the drawer swipe from starting under a held mic.
        onTouchStart={e=>{if(talk)e.stopPropagation();}}
        onContextMenu={e=>{if(talk || held)e.preventDefault();}}
        onClick={()=>{
          // The click after a press was already handled by the press; keyboard clicks have no press.
          if(pressed.current){pressed.current=0;return;}
          if(talk){setError("");void voice.start();}
          else if(voiceOn)void finishVoice(false);
          else void send();
        }}>
        {talk?<MicIcon />:voice.state==="transcribing" || sending?"…":<SendIcon />}
      </button>
    </div>
  </div>;
}
