import { useEffect, useRef, useState } from "react";
import { useKeptScroll } from "./kept-scroll";
import { dropTarget, moved, shiftFor, type Block } from "./tab-order";
import { agentName, api, errorMessage, useStoredState, type Session, type SessionList as List } from "./api";
import { Sheet } from "./sheet";
import { BellIcon, PlusIcon } from "./icons";
import { useNotifications } from "./notifications";

export const tabLabel=(s:Session)=>(s.tabName || s.name || "Untitled tab").replace(/^[✳✻✶✢·*]\s*/,"");

// A tab named "🛟 Support" gets that emoji as its icon, as in Herdr's sidebar.
const EMOJI=/^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;
export function TabTitle({session:s}:{session:Session}) {
  const label=tabLabel(s), emoji=label.match(EMOJI);
  const name=emoji && label.length>emoji[0].length?label.slice(emoji[0].length):label;
  return <>
    {emoji && name!==label?<span className="tab-emoji" aria-hidden="true">{emoji[1]}</span>
      :s.claude && <span className="claude-mark" data-agent={s.agent ?? "claude"} aria-label={agentName(s.agent)}>{s.agent==="codex"?"◎":s.agent==="antigravity"?"▲":"✳"}</span>}
    <span className="truncate">{name}</span>
  </>;
}

// Readable text on an iTerm tab-group color.
export function ink(color:string) {
  const rgb=color.startsWith("#")?[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255):(color.match(/[01]\.\d+/g)||[]).map(Number);
  const linear=rgb.map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
  return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722>.179?"#111111":"#ffffff";
}

export function subtitle(s:Session,panes:number) {
  if(s.attention==="blocked" && s.ask)return s.ask;
  if(panes>1)return `Pane ${s.paneIndex} · ${s.name}`;
  const cwd=s.cwd.replace(/^\/Users\/[^/]+/,"~");
  if(s.claude)return cwd;
  return [s.atPrompt?"At prompt":s.processing?"Running":"",cwd].filter(Boolean).join(" · ");
}

// Herdr's word for an agent waiting on you, or one that finished while nobody looked.
export function Attention({session:s}:{session:Session}) {
  if(s.attention==="blocked")return <span className="attention" data-kind="blocked">Needs you</span>;
  if(s.attention==="done")return <span className="attention" data-kind="done">Done</span>;
  return null;
}
// The most urgent in a group, for its header: blocked counts first.
export function groupAttention(sessions:Session[]) {
  const blocked=sessions.filter(s=>s.attention==="blocked").length, done=sessions.filter(s=>s.attention==="done").length;
  return blocked?{kind:"blocked",count:blocked}:done?{kind:"done",count:done}:null;
}

export type Section={key:string;windowId:number;group:Session["group"];sessions:Session[]};
// Preserve iTerm's window → group → tab → pane order.
export function groupSections(sessions:Session[]):Section[] {
  const sections:Section[]=[];
  for(const s of sessions){
    const key=`${s.windowId}:${s.group?.id || "ungrouped"}`;
    if(sections.at(-1)?.key!==key)sections.push({key,windowId:s.windowId,group:s.group,sessions:[]});
    sections.at(-1)!.sessions.push(s);
  }
  return sections;
}
export const matches=(s:Session,q:string)=>!q || [s.group?.name,s.tabName,s.name,s.cwd,s.profile].join(" ").toLowerCase().includes(q);

// What the tab list shows, shared by the list and the tab drawer so both read the
// same way: All or Needs you, and which groups are folded.
export function useListView(all:Session[]) {
  const [inbox,setInbox]=useStoredState("inbox",false);
  const [collapsed,setCollapsed]=useStoredState<Record<string,boolean>>("collapsed-groups",{});
  // Only Herdr reports which agents need you.
  const canInbox=all.some(s=>s.turn!==null);
  return {inbox:inbox && canInbox,setInbox,canInbox,collapsed,setCollapsed,
    waiting:all.filter(s=>s.attention).length,blocked:all.some(s=>s.attention==="blocked")};
}
export type ListView=ReturnType<typeof useListView>;

const urgency=(x:Session)=>x.attention==="blocked"?0:1;
export function visibleSections(all:Session[],q:string,inbox:boolean):Section[] {
  const sections=groupSections(all.filter(s=>matches(s,q) && (!inbox || s.attention)));
  if(!inbox)return sections;
  // In the inbox, what's waiting on you comes before what's only done, in each group and across them.
  return sections.map(section=>({...section,sessions:[...section.sessions].sort((a,b)=>urgency(a)-urgency(b))}))
    .sort((a,b)=>Math.min(...a.sessions.map(urgency))-Math.min(...b.sessions.map(urgency)));
}
export const isFolded=(view:ListView,section:Section,q:string)=>!q && !view.inbox && (view.collapsed[section.key] ?? section.group?.collapsed ?? false);

export function ListFilter({view}:{view:ListView}) {
  if(!view.canInbox)return null;
  return <div className="list-filter" role="tablist" aria-label="Show">
    <button type="button" role="tab" aria-selected={!view.inbox} onClick={()=>view.setInbox(false)}>All</button>
    <button type="button" role="tab" aria-selected={view.inbox} onClick={()=>view.setInbox(true)}>Needs you{view.waiting?<span className="list-filter-count" data-kind={view.blocked?"blocked":"done"}>{view.waiting}</span>:null}</button>
  </div>;
}

export function GroupHeader({view,section,folded}:{view:ListView;section:Section;folded:boolean}) {
  if(!section.group)return null;
  const g=groupAttention(section.sessions);
  return <button type="button" className="group" style={{background:section.group.color,color:ink(section.group.color)}} aria-expanded={!folded}
    onClick={()=>{if(!view.inbox)view.setCollapsed({...view.collapsed,[section.key]:!folded});}}>
    <span>{section.group.name || "Unnamed group"}</span>
    <span className="group-end">
      {g && <span className="group-attention" data-kind={g.kind}>{g.count}</span>}
      <span className="group-count">{section.sessions.length}{folded?" ›":" ⌄"}</span>
    </span>
  </button>;
}

// A tab being dragged to a new place in its group.
interface Drag {key:string;blocks:Block[];from:number;y0:number;scroll0:number;y:number;target:number;rows:string[][]}
const HOLD_MS=450;
const rank=(ids:string[],id:string)=>{const i=ids.indexOf(id);return i<0?Infinity:i;};

export function SessionList({host,app="iTerm2",moveTabs=false,data,error,refresh,open}:{host:string;app?:string;moveTabs?:boolean;data:List|null;error:string;refresh:()=>void;open:(id:string)=>void}) {
  const [query,setQuery]=useState("");
  const [closing,setClosing]=useState<Session|null>(null);
  const [menu,setMenu]=useState(false);
  const [bell,setBell]=useState(false);
  const notify=useNotifications();
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState("");

  const [drag,setDrag]=useState<Drag|null>(null);
  // The order you dropped tabs in, shown until the next list from the Mac.
  // Row ids in the new order; tab numbers can't be used, since they follow position.
  const [pending,setPending]=useState<{key:string;ids:string[];at:number}|null>(null);
  // Kept until the Mac's list shows the new order, so a refresh already on its way doesn't undo it.
  useEffect(()=>{
    if(!pending || !data)return;
    const ids=groupSections(data.sessions).find(x=>x.key===pending.key)?.sessions.map(s=>s.id) ?? [];
    if(ids.join()===pending.ids.join() || Date.now()-pending.at>6000)setPending(null);
  },[data,pending]);
  const list=useRef<HTMLElement>(null);
  useKeptScroll("list",list);

  const q=query.trim().toLowerCase();
  const view=useListView(data?.sessions || []);
  const sections=visibleSections(data?.sessions || [],q,view.inbox).map(section=>pending?.key!==section.key?section
    :{...section,sessions:[...section.sessions].sort((a,b)=>rank(pending.ids,a.id)-rank(pending.ids,b.id))});
  const shown=sections.reduce((n,s)=>n+s.sessions.length,0);
  const canDrag=moveTabs && !q && !view.inbox;

  // Holding a row picks up its tab; the rows' places are measured once, at pickup.
  function pickUp(key:string,tab:number,y:number) {
    const el=list.current;if(!el)return;
    const blocks:Block[]=[];const rows:string[][]=[];
    for(const row of el.querySelectorAll<HTMLElement>(`[data-section="${CSS.escape(key)}"]`)){
      const r=row.getBoundingClientRect(),t=Number(row.dataset.tab);
      if(blocks.at(-1)?.tab===t){blocks.at(-1)!.height+=r.height;rows.at(-1)!.push(row.dataset.id!);}
      else {blocks.push({tab:t,top:r.top,height:r.height});rows.push([row.dataset.id!]);}
    }
    const from=blocks.findIndex(b=>b.tab===tab);
    if(from<0 || blocks.length<2)return;
    setDrag({key,blocks,from,y0:y,scroll0:el.scrollTop,y,target:from,rows});
  }
  useEffect(()=>{
    if(!drag)return;
    const el=list.current!;
    let current=drag,frame=0;
    const update=(y:number)=>{
      const dy=y-current.y0+el.scrollTop-current.scroll0;
      current={...current,y,target:dropTarget(current.blocks,current.from,dy)};
      setDrag(current);
    };
    // Near the top or bottom edge, the list scrolls so a tab can travel further.
    const scroll=()=>{
      const r=el.getBoundingClientRect(),edge=56;
      const step=current.y<r.top+edge?-8:current.y>r.bottom-edge?8:0;
      if(step){const before=el.scrollTop;el.scrollTop+=step;if(el.scrollTop!==before)update(current.y);}
      frame=requestAnimationFrame(scroll);
    };
    frame=requestAnimationFrame(scroll);
    const move=(e:TouchEvent)=>{e.preventDefault();update(e.touches[0].clientY);};
    const end=()=>{
      const {from,target,rows,key}=current;
      setDrag(null);
      if(target===from)return;
      const order=moved(rows,from,target);
      setPending({key,ids:order.flat(),at:Date.now()});
      setActionError("");
      api.action(rows[from][0],{kind:"move-tab",before:order[target+1]?.[0] ?? null})
        .then(refresh,e=>{setPending(null);setActionError(errorMessage(e));});
    };
    window.addEventListener("touchmove",move,{passive:false});
    window.addEventListener("touchend",end);
    window.addEventListener("touchcancel",end);
    return ()=>{cancelAnimationFrame(frame);window.removeEventListener("touchmove",move);window.removeEventListener("touchend",end);window.removeEventListener("touchcancel",end);};
    // Only a new pickup restarts this; moves update `current` here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[drag?.key,drag?.from,drag?.y0]);
  const lift=(key:string,tab:number):{dy:number;lifted:boolean}=>{
    if(!drag || drag.key!==key)return {dy:0,lifted:false};
    const i=drag.blocks.findIndex(b=>b.tab===tab);
    if(i===drag.from)return {dy:drag.y-drag.y0+(list.current?.scrollTop ?? 0)-drag.scroll0,lifted:true};
    return {dy:shiftFor(i,drag.from,drag.target,drag.blocks[drag.from].height),lifted:false};
  };
  const windows=new Set(data?.sessions.map(s=>s.windowId)).size;
  const current=data?.sessions.find(s=>s.selected) || data?.sessions[0];

  async function run(fn:()=>Promise<{sessionId:string|null}>,openResult=true) {
    setBusy(true);setActionError("");
    try {const result=await fn();refresh();if(openResult && result.sessionId)open(result.sessionId);}
    catch(e){setActionError(errorMessage(e));}
    finally{setBusy(false);}
  }

  return <div className="screen">
    <header className="topbar">
      <div className="topbar-title"><span className="host-dot" data-ok={!error && !!data} />{host || "afkterm"}</div>
      <button type="button" className="icon-button bell" aria-label="Notifications" data-on={notify.state==="on" || undefined} onClick={()=>setBell(true)}><BellIcon /></button>
      <button type="button" className="icon-button" aria-label="New tab or window" disabled={busy} onClick={()=>setMenu(true)}><PlusIcon /></button>
    </header>
    <div className="search"><input type="search" placeholder="Search tabs, folders…" value={query} onChange={e=>setQuery(e.target.value)} autoCapitalize="off" autoCorrect="off" /></div>
    <ListFilter view={view} />
    {(error || actionError || notify.error) && <p className="banner" role="alert">{actionError || error || notify.error}</p>}
    {data?.metadataError && <p className="banner banner-muted">{data.metadataError}</p>}
    <main className="list" aria-label="Tabs" ref={list} data-dragging={drag?"":undefined}>
      {!data && !error && <p className="empty">Connecting to {app}…</p>}
      {data && !data.running && <p className="empty">{app} isn't running on this Mac.</p>}
      {data?.running && !shown && <p className="empty">{q?"No matching tabs.":view.inbox?"Nothing needs you right now.":"No open tabs."}</p>}
      {sections.map((section,i)=>{
        const folded=isFolded(view,section,q);
        return <section key={`${section.key}:${i}`}>
          {windows>1 && (i===0 || sections[i-1].windowId!==section.windowId) && <p className="window-label">Window {section.windowId}</p>}
          <GroupHeader view={view} section={section} folded={folded} />
          {!folded && section.sessions.map(s=><Row key={s.id} session={s} section={section.key} subtitle={subtitle(s,section.sessions.filter(p=>p.tabIndex===s.tabIndex).length)} open={()=>open(s.id)} close={()=>setClosing(s)}
            {...lift(section.key,s.tabIndex)} hold={canDrag && section.sessions.length>1?y=>pickUp(section.key,s.tabIndex,y):undefined} />)}
        </section>;
      })}
      {data && <p className="list-footer">{data.sessions.length} sessions · {windows} {windows===1?"window":"windows"}{data.truncated?" · list truncated":""}</p>}
    </main>
    <Sheet open={menu} onClose={()=>setMenu(false)} actions={[
      ...(current?[{label:"New tab",onSelect:()=>void run(()=>api.action(current.id,{kind:"new-tab"}))}]:[]),
      {label:"New window",onSelect:()=>void run(api.newWindow)},
    ]} />
    <NotifySheet open={bell} onClose={()=>setBell(false)} notify={notify} />
    <Sheet open={!!closing} onClose={()=>setClosing(null)} title={closing?`Close “${tabLabel(closing)}”?`:""} message="This closes the tab and all its panes. Running programs may stop."
      actions={closing?[{label:"Close tab",destructive:true,onSelect:()=>void run(()=>api.action(closing.id,{kind:"close-tab",confirmed:true}),false)}]:[]} />
  </div>;
}

function NotifySheet({open,onClose,notify}:{open:boolean;onClose:()=>void;notify:ReturnType<typeof useNotifications>}) {
  const {state,done,enable,disable}=notify;
  const message={
    loading:"Checking…",
    unsupported:"This browser can't show notifications.",
    "home-screen":"Notifications only work in the Home Screen app. In Safari, tap Share, then Add to Home Screen, and open afkterm from there.",
    denied:"Notifications are turned off for afkterm. You can allow them in Settings, under Notifications.",
    off:"Get a notification on this phone when an agent needs you. You won't get one while afkterm is open.",
    on:done?"You'll get a notification when an agent needs you or is done.":"You'll get a notification when an agent needs you.",
  }[state];
  const actions=state==="off"?[
    {label:"When an agent needs you",onSelect:()=>void enable(false)},
    {label:"When it needs you or is done",onSelect:()=>void enable(true)},
  ]:state==="on"?[
    done?{label:"Only when an agent needs you",onSelect:()=>void enable(false)}:{label:"Also when an agent is done",onSelect:()=>void enable(true)},
    {label:"Turn off notifications",destructive:true,onSelect:()=>void disable()},
  ]:[];
  return <Sheet open={open} onClose={onClose} title="Notifications" message={message} actions={actions} />;
}

// Swipe left to reveal Close; tap to open; hold, then drag, to move the tab.
function Row({session:s,section,subtitle,open,close,dy,lifted,hold}:{session:Session;section:string;subtitle:string;open:()=>void;close:()=>void;dy:number;lifted:boolean;hold?:(y:number)=>void}) {
  const [offset,setOffset]=useState(0);
  const [revealed,setRevealed]=useState(false);
  const gesture=useRef<{x:number;y:number;dx:number;dy:number}|null>(null);
  const swiped=useRef(false);
  const timer=useRef(0);
  const held=useRef(false);
  const lastTouch=useRef(0);
  const cancelHold=()=>{clearTimeout(timer.current);timer.current=0;};
  useEffect(()=>cancelHold,[]);
  return <div className="row-wrap" data-section={section} data-tab={s.tabIndex} data-id={s.id} data-lifted={lifted || undefined}
    style={dy || lifted?{transform:`translateY(${dy}px)`}:undefined}>
    {(revealed || offset<0) && <button type="button" className="row-close" onClick={()=>{setRevealed(false);close();}}>Close</button>}
    <button type="button" className="row" data-selected={s.selected} style={{transform:`translateX(${offset || (revealed?-88:0)}px)`}}
      onTouchStart={e=>{
        swiped.current=false;held.current=false;lastTouch.current=Date.now();
        const t=e.touches[0];gesture.current={x:t.clientX,y:t.clientY,dx:0,dy:0};
        if(hold && !revealed && e.touches.length===1){
          const y=t.clientY;cancelHold();
          timer.current=window.setTimeout(()=>{timer.current=0;held.current=true;swiped.current=true;navigator.vibrate?.(10);hold(gesture.current ? gesture.current.y+gesture.current.dy : y);},HOLD_MS);
        }
      }}
      onTouchMove={e=>{
        const g=gesture.current;if(!g || held.current)return;
        const t=e.touches[0];g.dx=t.clientX-g.x;g.dy=t.clientY-g.y;
        // Moving before the hold is up means scrolling or swiping, not picking it up.
        if(Math.hypot(g.dx,g.dy)>8)cancelHold();
        if(Math.abs(g.dx)>Math.abs(g.dy)*1.5 && Math.abs(g.dx)>10){swiped.current=true;setOffset(Math.max(-88,Math.min(0,(revealed?-88:0)+g.dx)));}
      }}
      onTouchEnd={()=>{cancelHold();const g=gesture.current;gesture.current=null;setOffset(0);if(!held.current && g && swiped.current && Math.abs(g.dx)>45)setRevealed(g.dx<0);}}
      onTouchCancel={cancelHold}
      onClick={()=>{if(swiped.current){swiped.current=false;return;}if(revealed){setRevealed(false);return;}open();}}
      // A long press with a finger moves the tab; the context menu (right click) still closes it.
      onContextMenu={e=>{e.preventDefault();if(Date.now()-lastTouch.current>1000)close();}}>
      <span className="row-main">
        <span className="row-title"><TabTitle session={s} /></span>
        <span className="row-sub">{subtitle}</span>
      </span>
      {s.attention?<Attention session={s} />:<span className="activity" data-active={s.processing} aria-label={s.processing?"Output active":"Quiet"} />}
    </button>
  </div>;
}
