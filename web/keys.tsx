import type { Action } from "./api";

export type Key = Extract<Action,{kind:"key"}>["key"];
const ALL:[Key,string][]=[["escape","esc"],["shift-tab","⇧tab"],["up","↑"],["down","↓"],["enter","⏎"],["tab","tab"],["ctrl-c","^C"],["left","←"],["right","→"],["ctrl-d","^D"]];
const NAV:Key[]=["up","down","enter"];

const keyButton=(k:Key,label:string,busy:boolean,send:(k:Key)=>void)=>
  <button key={k} type="button" className="key" disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>send(k)}>{label}</button>;

// Full key bar, for the terminal view.
export function TerminalKeys({busy,send}:{busy:boolean;send:(k:Key)=>void}) {
  return <div className="keys" aria-label="Keys">{ALL.map(([k,label])=>keyButton(k,label,busy,send))}</div>;
}

// Slim key bar for chatting with Claude: the mode switch and esc, plus arrows and
// Enter only while a menu that couldn't become buttons is on screen. "More" reveals the rest.
// `modes`: show Claude's permission mode as a chip that cycles it (other agents get a plain ⇧tab key).
export function ChatKeys({modes=true,mode,menu,busy,expanded,setExpanded,send}:{
  modes?:boolean; mode?:string; menu:boolean; busy:boolean; expanded:boolean; setExpanded:(v:boolean)=>void; send:(k:Key)=>void;
}) {
  const shown:Key[]=["escape",...(menu?NAV:[])];
  const rest=ALL.filter(([k])=>(!modes || k!=="shift-tab") && !shown.includes(k));
  const label=!mode?"mode":mode==="default"?"default mode":mode;
  return <div className="keys chat-keys" aria-label="Keys">
    {modes && <button type="button" className="key mode-chip" data-mode={mode?.replace(/\s+/g,"-") || "unknown"} disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>send("shift-tab")} aria-label={`Switch mode (now ${label})`}>
      <span className="mode-dot" aria-hidden="true" />{label}<span className="mode-hint">⇧tab</span>
    </button>}
    {ALL.filter(([k])=>shown.includes(k)).map(([k,label])=>keyButton(k,label,busy,send))}
    {expanded && rest.map(([k,label])=>keyButton(k,label,busy,send))}
    <button type="button" className="key key-more" aria-expanded={expanded} onMouseDown={e=>e.preventDefault()} onClick={()=>setExpanded(!expanded)}>{expanded?"less":"keys"}</button>
  </div>;
}
