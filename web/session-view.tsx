import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, useLiveSession, useStoredState, type Session, type Upload } from "./api";
import { Chat, PromptCard } from "./chat";
import { Composer } from "./composer";
import { QuestionCard } from "./question";
import { Sheet, type SheetAction } from "./sheet";
import { tabLabel } from "./session-list";
import { BackIcon, MoreIcon } from "./icons";
import { ChatKeys, TerminalKeys, type Key } from "./keys";
import { TabDrawer } from "./tab-drawer";

// Horizontal swipes start a drawer drag, except on things that scroll sideways or take text.
const NO_SWIPE=".keys, pre, table, textarea, input, .sheet, .prompt-details";

export function SessionView({sessionId,session,sessions,gone,back,open,refreshList}:{sessionId:string;session?:Session;sessions:Session[];gone:boolean;back:()=>void;open:(id:string)=>void;refreshList:()=>void}) {
  const {preview,error,connected}=useLiveSession(sessionId);
  const [mode,setMode]=useState<"chat"|"terminal">("chat");
  const [showKeys,setShowKeys]=useStoredState("show-keys",true);
  const [wrap,setWrap]=useStoredState("terminal-wrap",true);
  const [fontSize,setFontSize]=useStoredState("terminal-font",11);
  const [menu,setMenu]=useState(false);
  const [busy,setBusy]=useState(false);
  // Messages sent from here, shown until they appear in Claude's transcript.
  const [pending,setPending]=useState<{id:string;text:string;match:string;at:number}[]>([]);
  // The prompt just answered, hidden until the screen catches up.
  const [answered,setAnswered]=useState<string|null>(null);
  const [actionError,setActionError]=useState("");
  const scroller=useRef<HTMLDivElement>(null);
  const atBottom=useRef(true);
  const [behind,setBehind]=useState(false);
  const [chatKeysExpanded,setChatKeysExpanded]=useStoredState("chat-keys-expanded",false);
  // Tab drawer: open state, plus the live finger position while dragging it.
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [drawerX,setDrawerX]=useState<number|null>(null);
  const drawerWidth=Math.min(window.innerWidth*.86,380);
  const drag=useRef<{x:number;y:number;t:number;base:number;decided:boolean;active:boolean}|null>(null);

  const claude=preview?.claude;
  const chat=mode==="chat" && claude?.source==="transcript";
  const prompt=claude?.prompt && claude.prompt.text!==answered?claude.prompt:undefined;
  useEffect(()=>{
    if(!answered)return;
    if(claude?.prompt?.text!==answered){setAnswered(null);return;}
    // If the tap didn't take, show the prompt again.
    const timer=setTimeout(()=>setAnswered(null),4000);
    return ()=>clearTimeout(timer);
  },[claude?.prompt?.text,answered]);
  useEffect(()=>{
    if(!pending.length)return;
    const users=(claude?.messages || []).filter(m=>m.role==="user").slice(-pending.length-3).map(m=>m.text.trim());
    const left=pending.filter(p=>Date.now()-p.at<20000 && !users.some(u=>u.startsWith(p.match.slice(0,200))));
    if(left.length!==pending.length)setPending(left);
  },[claude?.messages,pending]);
  const question=claude?.question;
  const sendClaude=async(text:string,files:Upload[])=>{
    const item={id:crypto.randomUUID(),text:[text,...files.map(f=>`📎 ${f.name}`)].filter(Boolean).join("\n"),match:text.trim() || "Attached file:",at:Date.now()};
    atBottom.current=true;setPending(p=>[...p,item]);
    try {await api.sendClaude(sessionId,{text,files});}
    catch(e){setPending(p=>p.filter(x=>x.id!==item.id));throw e;}
  };
  // Hidden once you've sent something, until Claude's next turn.
  const replies=claude?.replies?.length && !pending.length && !claude.working?claude.replies:undefined;
  const working=!!claude?.working && !prompt && !question;

  // Follow new output while the reader is at the bottom; otherwise offer a jump.
  const content=chat?JSON.stringify(claude?.messages.at(-1))+claude?.messages.length:preview?.text;
  useLayoutEffect(()=>{
    const el=scroller.current;if(!el)return;
    if(atBottom.current)el.scrollTop=el.scrollHeight;
    else setBehind(true);
  },[content,chat,prompt?.text,question?.prompt,working,pending.length]);
  useEffect(()=>{atBottom.current=true;setBehind(false);},[chat]);
  const toBottom=()=>{const el=scroller.current;if(el){el.scrollTo({top:el.scrollHeight,behavior:"smooth"});atBottom.current=true;setBehind(false);}};

  async function run(action:Parameters<typeof api.action>[1],after?:(id:string|null)=>void) {
    setBusy(true);setActionError("");
    try {const result=await api.action(sessionId,action);after?.(result.sessionId);return true;}
    catch(e){setActionError(errorMessage(e));return false;}
    finally{setBusy(false);}
  }
  const key=(k:Key)=>void run({kind:"key",key:k});

  const claudeKeysMenu=!!claude && mode==="chat";
  const menuActions:SheetAction[]=[
    {label:"Show on Mac",onSelect:()=>void run({kind:"focus"})},
    {label:"Rename tab",onSelect:()=>{const name=window.prompt("Tab name",session?tabLabel(session):"");if(name?.trim())void run({kind:"rename",name:name.trim()},()=>refreshList());}},
    {label:"New tab",onSelect:()=>void run({kind:"new-tab"},id=>{refreshList();if(id)open(id);})},
    {label:"Split right",onSelect:()=>void run({kind:"split",direction:"vertical"},id=>{refreshList();if(id)open(id);})},
    {label:"Split down",onSelect:()=>void run({kind:"split",direction:"horizontal"},id=>{refreshList();if(id)open(id);})},
    ...(!chat?[
      {label:wrap?"Don't wrap lines":"Wrap lines",onSelect:()=>setWrap(!wrap)},
      {label:"Larger text",onSelect:()=>setFontSize(Math.min(18,fontSize+1))},
      {label:"Smaller text",onSelect:()=>setFontSize(Math.max(8,fontSize-1))},
    ]:[]),
    ...(!claudeKeysMenu?[{label:showKeys?"Hide key bar":"Show key bar",onSelect:()=>setShowKeys(!showKeys)}]:[]),
    {label:"Close pane",destructive:true,onSelect:()=>{if(window.confirm("Close this pane? Running programs may stop."))void run({kind:"close",confirmed:true},()=>{refreshList();back();});}},
    {label:"Close tab",destructive:true,onSelect:()=>{if(window.confirm("Close this tab and all its panes? Running programs may stop."))void run({kind:"close-tab",confirmed:true},()=>{refreshList();back();});}},
  ];

  const status=gone?"This tab was closed"
    :!connected && !preview?"Connecting…"
    :prompt || question?"Waiting for you"
    :working?"Claude is working…"
    :session?.cwd.replace(/^\/Users\/[^/]+/,"~") || "";

  const claudeKeys=!!claude && mode==="chat";
  return <div className="screen session"
    onTouchStart={e=>{
      const t=e.touches[0];
      drag.current=e.touches.length===1 && !(e.target as Element).closest(NO_SWIPE)
        ?{x:t.clientX,y:t.clientY,t:Date.now(),base:drawerOpen?drawerWidth:0,decided:false,active:false}:null;
    }}
    onTouchMove={e=>{
      const d=drag.current;if(!d)return;
      const t=e.touches[0];const dx=t.clientX-d.x,dy=t.clientY-d.y;
      if(!d.decided){
        if(Math.abs(dx)<10 && Math.abs(dy)<10)return;
        d.decided=true;
        // Right opens, left closes; anything mostly vertical is a scroll.
        d.active=Math.abs(dx)>Math.abs(dy)*1.3 && (drawerOpen?dx<0:dx>0);
      }
      if(d.active)setDrawerX(Math.max(0,Math.min(drawerWidth,d.base+dx)));
    }}
    onTouchEnd={e=>{
      const d=drag.current;drag.current=null;
      if(!d?.active)return;
      const dx=e.changedTouches[0].clientX-d.x;
      const flick=Math.abs(dx)>40 && Date.now()-d.t<250;
      const x=d.base+dx;
      setDrawerOpen(flick?dx>0:x>drawerWidth*.4);
      setDrawerX(null);
    }}
    onTouchCancel={()=>{drag.current=null;setDrawerX(null);}}>
    <header className="topbar">
      <button type="button" className="icon-button back" aria-label="All tabs" onClick={back}><BackIcon /></button>
      <div className="topbar-center" role="button" tabIndex={0} aria-label="Show tabs" onClick={()=>setDrawerOpen(true)} onKeyDown={e=>{if(e.key==="Enter")setDrawerOpen(true);}}>
        <p className="topbar-name">{session?tabLabel(session):"Session"}</p>
        <p className="topbar-status" data-state={prompt || question?"prompt":working?"working":connected?"ok":"offline"}>{status}</p>
      </div>
      {claude?.source==="transcript" && <div className="segmented" role="group" aria-label="View">
        <button type="button" aria-pressed={chat} onClick={()=>setMode("chat")}>Chat</button>
        <button type="button" aria-pressed={!chat} onClick={()=>setMode("terminal")}>Term</button>
      </div>}
      <button type="button" className="icon-button" aria-label="Session actions" onClick={()=>setMenu(true)}><MoreIcon /></button>
    </header>
    {(actionError || error) && <p className="banner" role="alert">{actionError || error}</p>}
    {claude?.source==="screen" && mode==="chat" && <p className="banner banner-muted">{claude.notice}</p>}
    <div className="scroll" ref={scroller} onScroll={()=>{const el=scroller.current;if(!el)return;atBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;if(atBottom.current)setBehind(false);}}>
      {chat && claude
        ?<Chat view={claude} pending={pending.map(p=>p.text)} />
        :<pre className="terminal" data-wrap={wrap} style={{fontSize}}>{preview?preview.text || "The screen is empty.":"Reading screen…"}</pre>}
    </div>
    {behind && <button type="button" className="jump" onClick={toBottom}>↓ New output</button>}
    <div className="dock">
      {working && <div className="working"><span className="spinner" aria-hidden="true" />Claude is working<button type="button" className="stop" disabled={busy} onClick={()=>key("escape")}>Stop</button></div>}
      {question && <QuestionCard question={question} disabled={busy} answer={answer=>run({kind:"question",prompt:question.prompt,answer})} />}
      {prompt && <PromptCard key={prompt.text} prompt={prompt} disabled={busy} choose={k=>{setAnswered(prompt.text);key(k as Key);}} />}
      {claudeKeys
        ?<ChatKeys mode={claude?.mode} menu={!!claude?.menu && !prompt && !question} busy={busy} expanded={chatKeysExpanded} setExpanded={setChatKeysExpanded} send={key} />
        :showKeys && <TerminalKeys busy={busy} send={key} />}
      {chat && replies && <div className="replies" role="group" aria-label="Quick replies">
        {replies.map(r=><button key={r} type="button" className="reply" disabled={busy || gone}
          onClick={()=>void sendClaude(r,[]).catch(e=>setActionError(errorMessage(e)))}>{r}</button>)}
      </div>}
      <Composer sessionId={sessionId} mode={chat || (claude && mode==="chat")?"claude":"terminal"} disabled={gone}
        sendClaude={sendClaude}
        sendText={async text=>{await api.action(sessionId,{kind:"send",text,enter:true});atBottom.current=true;}} />
    </div>
    <TabDrawer sessions={sessions} currentId={sessionId} open={drawerOpen} offset={drawerX} width={drawerWidth}
      select={id=>{setDrawerOpen(false);open(id);}} close={()=>setDrawerOpen(false)} />
    <Sheet open={menu} onClose={()=>setMenu(false)} title={session?tabLabel(session):undefined} actions={menuActions} />
  </div>;
}
