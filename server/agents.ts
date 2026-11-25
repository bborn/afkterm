import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Agent, ChatMessage, ClaudeView } from "./contract";
import { liveClaudeState } from "./claude-session";
import { quickReplies } from "./replies";

// Chat for agents other than Claude Code: Antigravity (`agy`) and Codex. Each keeps
// its conversation in a JSON-lines file on this Mac; the running process tells us
// which one. Questions, menus and whether it's working still come from the screen.

const MAX_TEXT=12000, MAX_MESSAGES=120, MAX_TOTAL=180000, TAIL=2*1024*1024;
const object=(v:unknown):Record<string,any>|null=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,any>:null;
const str=(v:unknown)=>typeof v==="string"?v:"";
const bounded=(text:string)=>text.length>MAX_TEXT?text.slice(0,MAX_TEXT)+"\n… (truncated)":text;
const json=(input:Record<string,unknown>)=>bounded(JSON.stringify(input,null,2));
const fromUrl=(p:string)=>p.replace(/^file:\/\//,"");
const records=(text:string)=>text.split("\n").flatMap(line=>{try{const r=object(JSON.parse(line));return r?[r]:[];}catch{return [];}});
function recent(messages:ChatMessage[]) {
  let length=0;
  return messages.slice(-MAX_MESSAGES).reverse().filter(m=>{length+=m.text.length+(m.result?.length||0);return length<=MAX_TOTAL;}).reverse();
}

// ── Antigravity ────────────────────────────────────────────────────────────────
// brain/<conversation>/.system_generated/logs/transcript.jsonl, one step per line:
// USER_INPUT (your message inside <USER_REQUEST>), PLANNER_RESPONSE (its text and
// tool calls, whose arguments are JSON-encoded strings) and GENERIC (one tool
// result each, in the order of the calls).

// Antigravity's tools under the names the chat view knows (see web/chat.tsx).
function agyTool(name:string,args:Record<string,unknown>):{name:string;input:Record<string,unknown>} {
  const a=(k:string)=>str(args[k]);
  const summary=a("toolSummary");
  switch(name){
  case "run_command":return {name:"Bash",input:{command:a("CommandLine"),...(summary?{description:summary}:{}),...(a("Cwd")?{cwd:a("Cwd")}:{})}};
  case "read_file":case "view_file":{
    const start=Number(args.StartLine);
    return {name:"Read",input:{file_path:a("Path") || a("AbsolutePath"),...(start>0?{offset:start}:{})}};
  }
  case "edit_file":return {name:"Edit",input:{file_path:a("Path"),old_string:a("Target"),new_string:a("Replacement")}};
  case "replace_file_content":case "multi_replace_file_content":return {name:"Edit",input:{file_path:a("TargetFile"),old_string:a("TargetContent"),new_string:a("ReplacementContent")}};
  case "write_file":case "write_to_file":return {name:"Write",input:{file_path:a("Path") || a("TargetFile"),content:a("Content") || a("CodeContent")}};
  case "grep_search":return {name:"Grep",input:{pattern:a("Query"),path:a("SearchPath")}};
  case "list_dir":return {name:"List",input:{path:a("DirectoryPath"),...(summary?{description:summary}:{})}};
  case "search_web":return {name:"WebSearch",input:{query:a("query")}};
  case "read_url_content":return {name:"WebFetch",input:{url:a("Url")}};
  case "invoke_subagent":return {name:"Agent",input:{description:a("Role") || a("TypeName"),prompt:a("Prompt")}};
  }
  // Something else: keep its own name, and lead with its summary when it has one.
  const {toolSummary:_s,toolAction:_a,...rest}=args;
  return {name:name.replace(/_/g," ").replace(/^./,c=>c.toUpperCase()),input:summary?{description:summary,...rest}:rest};
}
const agyArgs=(raw:unknown)=>{
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(object(raw) ?? {})){
    if(typeof v!=="string"){out[k]=v;continue;}
    try {out[k]=JSON.parse(v);} catch {out[k]=v;}
  }
  return out;
};
// Your words, without the context Antigravity wraps around them.
export function agyUserText(content:string) {
  const request=/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if(request)return request[1].trim();
  return content.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g,"").trim();
}
const agyResult=(content:string)=>content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/,"").trim();

export function agyMessages(text:string):ChatMessage[] {
  const messages:ChatMessage[]=[];
  let waiting:ChatMessage[]=[];
  for(const r of records(text)){
    const id=`step:${r.step_index ?? messages.length}`;
    const content=str(r.content);
    if(r.type==="USER_INPUT"){
      const words=agyUserText(content);
      if(words)messages.push({id,role:"user",text:bounded(words)});
      waiting=[];
    } else if(r.type==="PLANNER_RESPONSE"){
      if(content.trim())messages.push({id,role:"assistant",text:bounded(content.trim())});
      waiting=[];
      for(const [i,call] of (Array.isArray(r.tool_calls)?r.tool_calls:[]).entries()){
        const c=object(call);if(!c || !str(c.name))continue;
        const tool=agyTool(str(c.name),agyArgs(c.args));
        const row:ChatMessage={id:`${id}:${i}`,role:"tool",name:tool.name.slice(0,100),text:json(tool.input),status:"pending"};
        messages.push(row);waiting.push(row);
      }
    } else if(r.type==="GENERIC"){
      const row=waiting.shift();
      if(!row)continue;
      row.result=bounded(agyResult(content));
      row.status=r.error || r.status==="ERROR"?"error":r.status==="DONE"?"completed":"pending";
    }
  }
  return recent(messages);
}

// ── Codex ──────────────────────────────────────────────────────────────────────
// sessions/YYYY/MM/DD/rollout-…-<id>.jsonl. Each finished item of a turn is an
// `item_completed` event: your message, its messages, commands, file changes and
// other tool calls.

const codexText=(content:unknown)=>(Array.isArray(content)?content:[]).map(c=>object(c)).filter(c=>c && /^(text|Text|output_text|input_text|inputText)$/.test(str(c.type))).map(c=>str(c!.text)).join("\n").trim();
const codexStatus=(s:unknown):ChatMessage["status"]=>s==="failed" || s==="declined" || s==="error"?"error":s==="completed" || s===undefined?"completed":"pending";
// `zsh -lc "npm test"` is just `npm test`.
const codexCommand=(command:unknown)=>{
  const argv=Array.isArray(command)?command.map(String):typeof command==="string"?(()=>{try{const v=JSON.parse(command);return Array.isArray(v)?v.map(String):[command];}catch{return [command];}})():[];
  const flag=argv.findIndex(a=>/^-l?c$/.test(a));
  return flag>=0 && argv[flag+1]?argv[flag+1]:argv.join(" ");
};

export function codexMessages(text:string):ChatMessage[] {
  const messages:ChatMessage[]=[];
  for(const r of records(text)){
    const p=object(r.payload);
    if(r.type!=="event_msg" || p?.type!=="item_completed")continue;
    const item=object(p.item);if(!item)continue;
    const id=str(item.id) || `item:${messages.length}`;
    switch(item.type){
    case "UserMessage":{const t=codexText(item.content);if(t)messages.push({id,role:"user",text:bounded(t)});break;}
    case "AgentMessage":{const t=codexText(item.content);if(t)messages.push({id,role:"assistant",text:bounded(t)});break;}
    case "CommandExecution":
      messages.push({id,role:"tool",name:"Bash",text:json({command:codexCommand(item.command),...(item.cwd?{cwd:fromUrl(str(item.cwd))}:{})}),
        status:item.exit_code && item.exit_code!==0?"error":codexStatus(item.status),result:bounded(str(item.aggregated_output))});
      break;
    case "FileChange":{
      const changes=Object.entries(object(item.changes) ?? {});
      for(const [i,[path,change]] of changes.entries()){
        const c=object(change);
        messages.push({id:`${id}:${i}`,role:"tool",name:c?.type==="add"?"Write":"Edit",text:json({file_path:path,...(c?.unified_diff?{diff:str(c.unified_diff)}:c?.content?{content:str(c.content)}:{})}),status:codexStatus(item.status)});
      }
      break;
    }
    case "McpToolCall":{
      const result=object(item.result);
      messages.push({id,role:"tool",name:`${str(item.appName) || str(item.server)} ${str(item.actionName) || str(item.tool)}`.trim().slice(0,100) || "Tool",
        text:json(object(item.arguments) ?? {}),status:codexStatus(item.status),...(result?{result:bounded(codexText(result.content) || JSON.stringify(result))}:{})});
      break;
    }
    case "DynamicToolCall":
      messages.push({id,role:"tool",name:str(item.tool).slice(0,100) || "Tool",text:json(object(item.arguments) ?? {}),
        status:item.success===false?"error":codexStatus(item.status),result:bounded(codexText(item.content_items))});
      break;
    case "Extension":
      if(item.kind==="web.search")messages.push({id,role:"tool",name:"WebSearch",text:json({query:str(item.query) || str(object(item.action)?.query)}),status:"completed"});
      break;
    case "ImageView":
      if(item.path)messages.push({id,role:"tool",name:"Read",text:json({file_path:fromUrl(str(item.path))}),status:"completed"});
      break;
    }
  }
  return recent(messages);
}

// ── Finding a process's conversation ───────────────────────────────────────────

const run=promisify(execFile);
async function openFiles(pid:number,signal:AbortSignal) {
  try {
    const {stdout}=await run("/usr/sbin/lsof",["-a","-p",String(pid),"-Fn"],{signal,timeout:3000,maxBuffer:4*1024*1024});
    return stdout.split("\n").filter(l=>l.startsWith("n/")).map(l=>l.slice(1));
  } catch(error:any) {
    // lsof exits 1 when some of its output is missing, which is fine.
    return str(error?.stdout).split("\n").filter(l=>l.startsWith("n/")).map(l=>l.slice(1));
  }
}

// Antigravity holds presence/<conversation>.lock open for the conversation on screen.
export function agyTranscriptFrom(files:string[]) {
  for(const file of files){
    const m=/^(.*)\/presence\/([0-9a-f-]{36})\.lock$/.exec(file);
    if(m)return {id:m[2],path:join(m[1],"brain",m[2],".system_generated","logs","transcript.jsonl")};
  }
  return null;
}

// Codex may keep its rollout open; if not, it's the newest one for this folder
// written since the process started (a resumed session keeps its old file).
const ROLLOUT=/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-([0-9a-f-]{36})\.jsonl$/;
async function firstLine(path:string) {
  const file=await open(path,"r");
  try {const buffer=Buffer.alloc(64*1024);const {bytesRead}=await file.read(buffer,0,buffer.length,0);return buffer.subarray(0,bytesRead).toString("utf8").split("\n")[0];}
  finally {await file.close();}
}
export async function codexRollout(files:string[],cwd:string,started:number,root=join(homedir(),".codex"),now=Date.now()) {
  const held=files.find(f=>ROLLOUT.test(f));
  if(held)return {id:ROLLOUT.exec(held)![1],path:held};
  let best:{id:string;path:string;mtime:number}|null=null;
  for(let day=0;day<14;day++){
    const d=new Date(now-day*86400000);
    const dir=join(root,"sessions",String(d.getFullYear()),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0"));
    let names:string[];
    try {names=(await readdir(dir)).filter(n=>n.endsWith(".jsonl"));} catch {continue;}
    for(const name of names){
      const path=join(dir,name);
      const m=ROLLOUT.exec(path);if(!m)continue;
      const info=await stat(path).catch(()=>null);
      if(!info || info.mtimeMs<started-60000 || (best && info.mtimeMs<=best.mtime))continue;
      try {
        const meta=object(object(JSON.parse(await firstLine(path)))?.payload);
        if(str(meta?.cwd)!==cwd)continue;
      } catch {continue;}
      best={id:m[1],path,mtime:info.mtimeMs};
    }
  }
  return best && {id:best.id,path:best.path};
}

async function tail(path:string) {
  const file=await open(path,"r");
  try {
    const info=await file.stat();
    const version=`${info.size}:${info.mtimeMs}`;
    const start=Math.max(0,info.size-TAIL);
    const buffer=Buffer.alloc(Math.min(info.size,TAIL));
    const {bytesRead}=await file.read(buffer,0,buffer.length,start);
    let text=buffer.subarray(0,bytesRead).toString("utf8");
    if(start)text=text.slice(text.indexOf("\n")+1);
    return {text,partial:start>0,version};
  } finally {await file.close();}
}

// Looking up the conversation runs lsof, so reuse the answer for a few seconds;
// re-parse the file only when it changed.
const located=new Map<string,{at:number;found:{id:string;path:string}|null}>();
const parsed=new Map<string,{version:string;partial:boolean;messages:ChatMessage[]}>();
const LOCATE_FRESH=5000;

export const AGENT_NAMES:Record<Agent,string>={claude:"Claude",codex:"Codex",antigravity:"Antigravity"};

export async function agentView(agent:Exclude<Agent,"claude">,process:{pid:number;cwd:string;started:number}|null,identity:string,text:string,working:boolean,signal:AbortSignal,found?:(path:string)=>void):Promise<ClaudeView> {
  const live=liveClaudeState(text);
  // Herdr knows when the agent is working even when its screen says it differently.
  const state={...live,working:live.working || working && !live.prompt && !live.question,mode:undefined};
  const name=AGENT_NAMES[agent];
  const fallback:ClaudeView={agent,source:"screen",identity,messages:[],notice:`Saved ${name} history is unavailable for this session. Showing terminal output.`,...state};
  if(!process)return fallback;
  try {
    const key=`${agent}:${process.pid}`;
    let hit=located.get(key);
    if(!hit || Date.now()-hit.at>LOCATE_FRESH){
      const files=await openFiles(process.pid,signal);
      hit={at:Date.now(),found:agent==="antigravity"?agyTranscriptFrom(files):await codexRollout(files,process.cwd,process.started)};
      located.set(key,hit);
      if(located.size>64)located.delete(located.keys().next().value!);
    }
    if(!hit.found)return fallback;
    const {path,id}=hit.found;
    const info=await stat(path);
    const version=`${info.size}:${info.mtimeMs}`;
    let cached=parsed.get(path);
    if(cached?.version!==version){
      const data=await tail(path);
      cached={version:data.version,partial:data.partial,messages:agent==="antigravity"?agyMessages(data.text):codexMessages(data.text)};
      parsed.delete(path);parsed.set(path,cached);
      if(parsed.size>32)parsed.delete(parsed.keys().next().value!);
    }
    if(!cached.messages.length)return {...fallback,notice:`Waiting for ${name}…`};
    found?.(path);
    const idle=!state.working && !state.prompt && !state.question && !state.menu;
    return {agent,source:"transcript",identity:id,messages:cached.messages,...state,
      notice:cached.partial || cached.messages.length>=MAX_MESSAGES?"Showing recent conversation history.":undefined,
      ...(idle?{replies:quickReplies(cached.messages)}:{})};
  } catch {return fallback;}
}
