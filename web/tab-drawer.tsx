import { useState } from "react";
import type { Session } from "./api";
import { Attention, TabTitle, groupSections, ink, matches } from "./session-list";

// The tab list as a drawer over the current session: swipe right to pull it in,
// tap a tab to switch. `offset` is the drag position in px (null when not dragging).
export function TabDrawer({sessions,currentId,open,offset,width,select,close}:{
  sessions:Session[]; currentId:string; open:boolean; offset:number|null; width:number;
  select:(id:string)=>void; close:()=>void;
}) {
  const [query,setQuery]=useState("");
  const q=query.trim().toLowerCase();
  const sections=groupSections(sessions.filter(s=>matches(s,q)));
  const x=offset ?? (open?width:0);
  if(x<=0 && !open)return null;
  const dragging=offset!==null;
  return <>
    <div className="drawer-backdrop" style={{opacity:Math.min(1,x/width)*.55,transition:dragging?"none":undefined}} onClick={close} />
    <nav className="drawer" aria-label="Tabs" style={{width,transform:`translateX(${x-width}px)`,transition:dragging?"none":undefined}}>
      <div className="drawer-head">
        <p className="drawer-title">Tabs</p>
        <input type="search" placeholder="Search" value={query} onChange={e=>setQuery(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      </div>
      <div className="drawer-list">
        {sections.map((section,i)=><section key={`${section.key}:${i}`}>
          {section.group && <p className="drawer-group" style={{background:section.group.color,color:ink(section.group.color)}}>{section.group.name || "Unnamed group"}</p>}
          {section.sessions.map(s=><button key={s.id} type="button" className="drawer-row" data-current={s.id===currentId} onClick={()=>{if(s.id===currentId)close();else select(s.id);}}>
            <span className="row-title"><TabTitle session={s} /><Attention session={s} /></span>
            <span className="row-sub">{section.sessions.filter(p=>p.tabIndex===s.tabIndex).length>1?`Pane ${s.paneIndex} · `:""}{s.attention==="blocked" && s.ask?s.ask:s.cwd.replace(/^\/Users\/[^/]+/,"~")}</span>
          </button>)}
        </section>)}
        {!sections.length && <p className="empty">{q?"No matching tabs.":"No tabs."}</p>}
      </div>
    </nav>
  </>;
}
