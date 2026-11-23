import { memo, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ClaudeView, Prompt } from "./api";
import { Folded, FoldButton } from "./question";
import { FileLinks, fileLinkComponents, rehypeFileLinks, useFileLinks } from "./file-viewer";
import { pathsIn } from "./file-paths";
import { AttachmentTile, kindOf, splitAttachments } from "./attachments";

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

// The file or folder a tool call works on, and the line a Read starts at.
export function toolPath(m:ChatMessage):{path:string;line?:number}|undefined {
  if(!m.name || !/^(Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob)$/.test(m.name))return;
  let input:Record<string,unknown>;
  try {input=JSON.parse(m.text);} catch {return;}
  const path=[input.file_path,input.notebook_path,input.path].find(v=>typeof v==="string" && v) as string|undefined;
  return path?{path,line:m.name==="Read" && typeof input.offset==="number" && input.offset>0?input.offset:undefined}:undefined;
}

const Tool=memo(function Tool({m}:{m:ChatMessage}) {
  const [open,setOpen]=useState(false);
  const links=useFileLinks();
  const target=toolPath(m);
  const file=target && links?.info(target.path);
  return <div className="tool" data-status={m.status} data-open={open}>
    <div className="tool-line">
      <button type="button" className="tool-toggle" onClick={()=>setOpen(!open)} aria-expanded={open}>
        <span className="tool-status" aria-label={m.status} />
        <span className="tool-name">{m.name}</span>
        {!file && <span className="tool-summary">{toolSummary(m)}</span>}
      </button>
      {file && target && <button type="button" className="tool-summary file-link" onClick={()=>links!.open({raw:target.path,...target})}>{toolSummary(m)}</button>}
    </div>
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
  // Reading the links context re-renders this when the Mac answers which paths exist.
  const links=useFileLinks();
  return <div className="assistant markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={links?[rehypeFileLinks(p=>!!links.info(p))]:[]} components={fileLinkComponents(links)}>{text}</Markdown></div>;
});

// Your message, with what you attached as tiles under it instead of file paths.
const UserMessage=memo(function UserMessage({text,pending}:{text:string;pending?:boolean}) {
  const links=useFileLinks();
  const {text:words,files}=splitAttachments(text);
  return <div className="user" data-pending={pending || undefined}>
    {words && <div className="bubble">{words}</div>}
    {files.length>0 && <div className="tiles tiles-sent">{files.map((f,i)=>{
      const info=f.path?links?.info(f.path):undefined;
      return <AttachmentTile key={i} name={f.name} src={info?.url && kindOf(f.name)==="image"?info.url:undefined}
        open={info && f.path?()=>links!.open({raw:f.path!,path:f.path!}):undefined} />;
    })}</div>}
  </div>;
});

export function Chat({view,pending=[],sessionId}:{view:ClaudeView;pending?:string[];sessionId?:string}) {
  const paths=useMemo(()=>[...new Set(view.messages.flatMap(m=>m.role==="assistant"?pathsIn(m.text)
    :m.role==="tool"?[toolPath(m)?.path ?? ""].filter(Boolean)
    :m.role==="user"?splitAttachments(m.text).files.flatMap(f=>f.path?[f.path]:[]):[]))],[view.messages]);
  const chat=<ChatMessages view={view} pending={pending} />;
  return sessionId?<FileLinks sessionId={sessionId} paths={paths}>{chat}</FileLinks>:chat;
}

function ChatMessages({view,pending}:{view:ClaudeView;pending:string[]}) {
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
        ?<UserMessage key={b.m.id} text={b.m.text} />
        :<Assistant key={b.m.id} text={b.m.text} />)}
    {pending.map((text,i)=><UserMessage key={`pending-${i}`} text={text} pending />)}
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
