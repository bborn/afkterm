import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ClaudeView, Prompt } from "./api";
import { Folded, FoldButton } from "./question";

const short=(s:string,n=80)=>s.length>n?s.slice(0,n-1)+"…":s;
const base=(p:string)=>p.split("/").filter(Boolean).at(-1) || p;

// A one-line description of a tool call, e.g. "npm test" for Bash.
export function toolSummary(m:ChatMessage):string {
  let input:Record<string,unknown>={};
  try {input=JSON.parse(m.text);} catch {return short(m.text.replace(/\s+/g," "));}
  const str=(k:string)=>typeof input[k]==="string"?input[k] as string:"";
  switch(m.name){
    case "Bash": return short(str("description") || str("command"));
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return base(str("file_path") || str("notebook_path"));
    case "Grep": return short(`${str("pattern")}${str("path")?` in ${base(str("path"))}`:""}`);
    case "Glob": return short(str("pattern"));
    case "Task": case "Agent": return short(str("description") || str("prompt"));
    case "WebFetch": return short(str("url").replace(/^https?:\/\//,""));
    case "WebSearch": return short(str("query"));
    case "TodoWrite": return "Update todo list";
    case "Skill": return str("skill") || str("command");
    case "AskUserQuestion": {const q=(input.questions as {question?:string}[]|undefined)?.[0]?.question;return short(q || "Question");}
    case "ExitPlanMode": return "Plan ready for review";
  }
  const first=Object.values(input).find(v=>typeof v==="string") as string|undefined;
  return short((first || "").replace(/\s+/g," "));
}

const Tool=memo(function Tool({m}:{m:ChatMessage}) {
  const [open,setOpen]=useState(false);
  return <div className="tool" data-status={m.status} data-open={open}>
    <button type="button" className="tool-line" onClick={()=>setOpen(!open)} aria-expanded={open}>
      <span className="tool-status" aria-label={m.status} />
      <span className="tool-name">{m.name}</span>
      <span className="tool-summary">{toolSummary(m)}</span>
    </button>
    {open && <div className="tool-body"><pre>{m.text}</pre>{m.result && <pre className="tool-result">{m.result}</pre>}</div>}
  </div>;
});

// Long runs of tool calls collapse to the last few so the conversation stays readable.
function ToolRun({tools}:{tools:ChatMessage[]}) {
  const [expanded,setExpanded]=useState(false);
  const hidden=expanded?0:Math.max(0,tools.length-2);
  return <div className="tool-run">
    {hidden>0 && <button type="button" className="tool-more" onClick={()=>setExpanded(true)}>{hidden} more tool {hidden===1?"call":"calls"}</button>}
    {tools.slice(hidden).map(m=><Tool key={m.id} m={m} />)}
  </div>;
}

const Assistant=memo(function Assistant({text}:{text:string}) {
  return <div className="assistant markdown"><Markdown remarkPlugins={[remarkGfm]} components={{a:({node:_,...props})=><a {...props} target="_blank" rel="noreferrer" />,img:({src,alt})=><a href={typeof src==="string"?src:undefined} target="_blank" rel="noreferrer">{alt || "image"}</a>}}>{text}</Markdown></div>;
});

export function Chat({view,pending=[]}:{view:ClaudeView;pending?:string[]}) {
  const blocks:({kind:"tools";tools:ChatMessage[]}|{kind:"message";m:ChatMessage})[]=[];
  for(const m of view.messages){
    if(m.role==="tool"){
      const last=blocks.at(-1);
      if(last?.kind==="tools")last.tools.push(m);else blocks.push({kind:"tools",tools:[m]});
    } else blocks.push({kind:"message",m});
  }
  return <div className="chat">
    {view.notice && <p className="chat-notice">{view.notice}</p>}
    {!view.messages.length && <p className="chat-notice">Waiting for Claude…</p>}
    {blocks.map(b=>b.kind==="tools"
      ?<ToolRun key={b.tools[0].id} tools={b.tools} />
      :b.m.role==="user"
        ?<div key={b.m.id} className="user"><div className="bubble">{b.m.text}</div></div>
        :<Assistant key={b.m.id} text={b.m.text} />)}
    {pending.map((text,i)=><div key={`pending-${i}`} className="user" data-pending="true"><div className="bubble">{text}</div></div>)}
  </div>;
}

// Claude's numbered menus (permissions, plan approval, questions) as big buttons.
// Pressing the option's number in Claude selects it.
export function PromptCard({prompt,disabled,choose}:{prompt:Prompt;disabled:boolean;choose:(key:string)=>void}) {
  const [details,setDetails]=useState(false);
  const [folded,setFolded]=useState(false);
  if(folded)return <Folded text={prompt.question || "Claude is asking"} unfold={()=>setFolded(false)} />;
  return <div className="prompt" role="group" aria-label="Claude is asking">
    <FoldButton fold={()=>setFolded(true)} />
    <div className="prompt-head">
      <p className="prompt-question">{prompt.question || "Claude is asking"}</p>
      <button type="button" className="prompt-toggle" onClick={()=>setDetails(!details)}>{details?"Hide":"Details"}</button>
    </div>
    {details && <pre className="prompt-details">{prompt.text}</pre>}
    <div className="prompt-options">
      {prompt.options.map(o=><button key={o.key} type="button" className="prompt-option" data-selected={o.selected} disabled={disabled} onClick={()=>choose(o.key)}>
        <span className="prompt-key">{o.key}</span>
        <span className="prompt-label"><span>{o.label.replace(/\s*\(esc\)$/,"")}</span>{o.detail && <span className="prompt-detail">{o.detail}</span>}</span>
      </button>)}
    </div>
  </div>;
}
