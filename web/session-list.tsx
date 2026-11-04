import { useRef, useState } from "react";
import { api, errorMessage, useStoredState, type Session, type SessionList as List } from "./api";
import { Sheet } from "./sheet";
import { PlusIcon } from "./icons";

export const tabLabel=(s:Session)=>(s.tabName || s.name || "Untitled tab").replace(/^[✳✻✶✢·*]\s*/,"");

// Readable text on an iTerm tab-group color.
export function ink(color:string) {
  const rgb=color.startsWith("#")?[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255):(color.match(/[01]\.\d+/g)||[]).map(Number);
  const linear=rgb.map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
  return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722>.179?"#111111":"#ffffff";
}

export function subtitle(s:Session,panes:number) {
  if(panes>1)return `Pane ${s.paneIndex} · ${s.name}`;
  const cwd=s.cwd.replace(/^\/Users\/[^/]+/,"~");
  if(s.claude)return cwd;
  return [s.atPrompt?"At prompt":s.processing?"Running":"",cwd].filter(Boolean).join(" · ");
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

export function SessionList({host,app="iTerm2",data,error,refresh,open}:{host:string;app?:string;data:List|null;error:string;refresh:()=>void;open:(id:string)=>void}) {
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useStoredState<Record<string,boolean>>("collapsed-groups",{});
  const [closing,setClosing]=useState<Session|null>(null);
  const [menu,setMenu]=useState(false);
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState("");

  const q=query.trim().toLowerCase();
  const sessions=(data?.sessions || []).filter(s=>matches(s,q));
  const sections=groupSections(sessions);
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
      <div className="topbar-title"><span className="host-dot" data-ok={!error && !!data} />{host || "iTerm Web"}</div>
      <button type="button" className="icon-button" aria-label="New tab or window" disabled={busy} onClick={()=>setMenu(true)}><PlusIcon /></button>
    </header>
    <div className="search"><input type="search" placeholder="Search tabs, folders…" value={query} onChange={e=>setQuery(e.target.value)} autoCapitalize="off" autoCorrect="off" /></div>
    {(error || actionError) && <p className="banner" role="alert">{actionError || error}</p>}
    {data?.metadataError && <p className="banner banner-muted">{data.metadataError}</p>}
    <main className="list" aria-label="Tabs">
      {!data && !error && <p className="empty">Connecting to {app}…</p>}
      {data && !data.running && <p className="empty">{app} isn't running on this Mac.</p>}
      {data?.running && !sessions.length && <p className="empty">{q?"No matching tabs.":"No open tabs."}</p>}
      {sections.map((section,i)=>{
        const folded=!q && (collapsed[section.key] ?? section.group?.collapsed ?? false);
        return <section key={`${section.key}:${i}`}>
          {windows>1 && (i===0 || sections[i-1].windowId!==section.windowId) && <p className="window-label">Window {section.windowId}</p>}
          {section.group && <button type="button" className="group" style={{background:section.group.color,color:ink(section.group.color)}} aria-expanded={!folded} onClick={()=>setCollapsed({...collapsed,[section.key]:!folded})}>
            <span>{section.group.name || "Unnamed group"}</span><span className="group-count">{section.sessions.length}{folded?" ›":" ⌄"}</span>
          </button>}
          {!folded && section.sessions.map(s=><Row key={s.id} session={s} subtitle={subtitle(s,section.sessions.filter(p=>p.tabIndex===s.tabIndex).length)} open={()=>open(s.id)} close={()=>setClosing(s)} />)}
        </section>;
      })}
      {data && <p className="list-footer">{data.sessions.length} sessions · {windows} {windows===1?"window":"windows"}{data.truncated?" · list truncated":""}</p>}
    </main>
    <Sheet open={menu} onClose={()=>setMenu(false)} actions={[
      ...(current?[{label:"New tab",onSelect:()=>void run(()=>api.action(current.id,{kind:"new-tab"}))}]:[]),
      {label:"New window",onSelect:()=>void run(api.newWindow)},
    ]} />
    <Sheet open={!!closing} onClose={()=>setClosing(null)} title={closing?`Close “${tabLabel(closing)}”?`:""} message="This closes the tab and all its panes. Running programs may stop."
      actions={closing?[{label:"Close tab",destructive:true,onSelect:()=>void run(()=>api.action(closing.id,{kind:"close-tab",confirmed:true}),false)}]:[]} />
  </div>;
}

// Swipe left to reveal Close; tap to open.
function Row({session:s,subtitle,open,close}:{session:Session;subtitle:string;open:()=>void;close:()=>void}) {
  const [offset,setOffset]=useState(0);
  const [revealed,setRevealed]=useState(false);
  const gesture=useRef<{x:number;y:number;dx:number;dy:number}|null>(null);
  const swiped=useRef(false);
  return <div className="row-wrap">
    {(revealed || offset<0) && <button type="button" className="row-close" onClick={()=>{setRevealed(false);close();}}>Close</button>}
    <button type="button" className="row" data-selected={s.selected} style={{transform:`translateX(${offset || (revealed?-88:0)}px)`}}
      onTouchStart={e=>{swiped.current=false;const t=e.touches[0];gesture.current={x:t.clientX,y:t.clientY,dx:0,dy:0};}}
      onTouchMove={e=>{
        const g=gesture.current;if(!g)return;
        const t=e.touches[0];g.dx=t.clientX-g.x;g.dy=t.clientY-g.y;
        if(Math.abs(g.dx)>Math.abs(g.dy)*1.5 && Math.abs(g.dx)>10){swiped.current=true;setOffset(Math.max(-88,Math.min(0,(revealed?-88:0)+g.dx)));}
      }}
      onTouchEnd={()=>{const g=gesture.current;gesture.current=null;setOffset(0);if(g && swiped.current && Math.abs(g.dx)>45)setRevealed(g.dx<0);}}
      onClick={()=>{if(swiped.current){swiped.current=false;return;}if(revealed){setRevealed(false);return;}open();}}
      onContextMenu={e=>{e.preventDefault();close();}}>
      <span className="row-main">
        <span className="row-title">{s.claude && <span className="claude-mark" aria-label="Claude">✳</span>}<span className="truncate">{tabLabel(s)}</span></span>
        <span className="row-sub">{subtitle}</span>
      </span>
      <span className="activity" data-active={s.processing} aria-label={s.processing?"Output active":"Quiet"} />
    </button>
  </div>;
}
