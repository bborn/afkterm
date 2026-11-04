import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ClaudeView } from "./contract";
import { processClaudeConfigDir } from "./claude-config";
import { transcriptMessages, liveClaudePrompt, claudeWorking, claudeMode, claudeMenu } from "./claude-view";
import { claudeQuestion } from "./question";

// What the screen says Claude is waiting on. An AskUserQuestion dialog gets its own
// card, so it isn't also offered as a numbered prompt or an arrow-key menu.
export function liveClaudeState(text:string) {
  const question=claudeQuestion(text);
  if(question)return {question,prompt:undefined,working:false,mode:claudeMode(text),menu:false};
  return {prompt:liveClaudePrompt(text),working:claudeWorking(text),mode:claudeMode(text),menu:claudeMenu(text)};
}

const registrySchema=z.object({pid:z.number().int().positive(),sessionId:z.string().uuid(),cwd:z.string().startsWith("/").max(4096),procStart:z.string()});
export interface Process {pid:number;tty:string;foreground:number;group:number;started:string;command:string}
export function foregroundClaude(output:string,tty:string):Process|null {
  const rows=output.split("\n").flatMap(line=>{
    const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/.exec(line);
    return m?[{pid:Number(m[1]),tty:m[3],foreground:Number(m[4]),group:Number(m[5]),started:m[6].replace(/\s+/g," "),command:m[7]}]:[];
  });
  const matches=rows.filter(p=>p.tty===tty.replace(/^\/dev\//,"") && p.pid===p.foreground && p.group===p.foreground && /(?:^|\/)claude$/.test(p.command));
  return matches.length===1?matches[0]:null;
}
async function tail(path:string):Promise<{text:string;partial:boolean;version:string}> {
  const file=await open(path,"r");
  try {
    const stat=await file.stat();if(!stat.isFile())throw Error("Not a transcript");
    const version=`${stat.size}:${stat.mtimeMs}`;
    const cached=parsed.get(path);
    if(cached?.version===version)return {text:"",partial:cached.partial,version};
    const start=Math.max(0,stat.size-2*1024*1024);
    const buffer=Buffer.alloc(Math.min(stat.size,2*1024*1024));
    const {bytesRead}=await file.read(buffer,0,buffer.length,start);
    let text=buffer.subarray(0,bytesRead).toString("utf8");
    if(start)text=text.slice(text.indexOf("\n")+1);
    return {text,partial:start>0,version};
  } finally {await file.close();}
}
// The live view re-reads every second; skip re-parsing a transcript that has not changed.
const parsed=new Map<string,{version:string;partial:boolean;messages:ClaudeView["messages"]}>();
const configRoots=new Map<string,string>();
export async function claudeConfigForProcess(process:Process,signal:AbortSignal) {
  const key=`${process.pid}:${process.started}`;
  const cached=configRoots.get(key);if(cached)return cached;
  const root=await processClaudeConfigDir(process.pid,signal);
  configRoots.set(key,root);
  if(configRoots.size>128)configRoots.delete(configRoots.keys().next().value!);
  return root;
}
export async function readClaudeTranscript(process:Process,root:string,signal:AbortSignal,found?:(path:string)=>void):Promise<ClaudeView|null> {
  const metadata=registrySchema.parse(JSON.parse(await readFile(join(root,"sessions",`${process.pid}.json`),"utf8")));
  if(metadata.pid!==process.pid || metadata.procStart.replace(/\s+/g," ").trim()!==process.started)return null;
  signal.throwIfAborted();
  const projects=join(root,"projects");
  const preferred=metadata.cwd.replace(/[^a-zA-Z0-9]/g,"-");
  let data,path=join(projects,preferred,`${metadata.sessionId}.jsonl`);
  try {data=await tail(path);}
  catch {
    const dirs=(await readdir(projects,{withFileTypes:true})).filter(d=>d.isDirectory()).slice(0,2000);
    for(const dir of dirs){signal.throwIfAborted();try{path=join(projects,dir.name,`${metadata.sessionId}.jsonl`);data=await tail(path);break;}catch{}}
  }
  if(!data)return null;
  found?.(path);
  let messages=parsed.get(path)?.version===data.version?parsed.get(path)!.messages:null;
  if(!messages){
    messages=transcriptMessages(data.text,metadata.sessionId);
    parsed.delete(path);parsed.set(path,{version:data.version,partial:data.partial,messages});
    if(parsed.size>32)parsed.delete(parsed.keys().next().value!);
  }
  if(!messages.length)return null;
  return {source:"transcript",identity:metadata.sessionId,messages,working:false,menu:false,notice:data.partial || messages.length>=120?"Showing recent conversation history.":undefined};
}
const psFields="pid=,ppid=,tty=,tpgid=,pgid=,lstart=,comm=";
// Listing every process on macOS takes ~0.5s; restricting ps to the terminals we
// care about takes ~20-90ms.
async function psForTtys(ttys:string[],signal:AbortSignal) {
  const names=[...new Set(ttys.filter(tty=>/^\/dev\/tty\w+$/.test(tty)).map(tty=>tty.slice(5)))];
  if(!names.length)return "";
  const {stdout}=await promisify(execFile)("/bin/ps",[...names.flatMap(name=>["-t",name]),"-o",psFields],{env:{...globalThis.process.env,TZ:"UTC"},signal,timeout:2000,maxBuffer:2*1024*1024});
  return stdout;
}
// Terminals (as /dev/ttysNNN) whose foreground process is Claude, from one ps call.
export async function claudeTtys(ttys:string[],signal:AbortSignal):Promise<Set<string>> {
  const stdout=await psForTtys(ttys,signal);
  return new Set(ttys.filter(tty=>foregroundClaude(stdout,tty)));
}
// The transcript file last read for each terminal, so the live view can watch it.
const transcripts=new Map<string,string>();
export const transcriptPathFor=(tty:string)=>transcripts.get(tty);
export async function claudeSession(tty:string,text:string,signal:AbortSignal):Promise<ClaudeView|null> {
  if(!/^\/dev\/tty[\w]+$/.test(tty))return null;
  let process:Process|null;
  try {process=foregroundClaude(await psForTtys([tty],signal),tty);}
  catch {return null;}
  if(!process){transcripts.delete(tty);return null;}
  return claudeViewFor(process,text,signal,path=>transcripts.set(tty,path));
}
// The chat view for a known Claude process: its transcript if one can be found,
// otherwise what the screen shows.
export async function claudeViewFor(process:Process,text:string,signal:AbortSignal,found?:(path:string)=>void):Promise<ClaudeView> {
  const fallback:ClaudeView={source:"screen",identity:`${process.pid}:${process.started}`,messages:[],notice:"Saved Claude history is unavailable for this session. Showing terminal output.",...liveClaudeState(text)};
  try {
    const root=await claudeConfigForProcess(process,signal);
    const view=await readClaudeTranscript(process,root,signal,found);
    return view?{...view,...liveClaudeState(text)}:fallback;
  } catch {return fallback;}
}
// A process's start time as `ps -o lstart=` prints it in UTC (the form Claude
// writes to its session registry), or null once it has exited.
export async function processStarted(pid:number,signal:AbortSignal):Promise<string|null> {
  try {
    const {stdout}=await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","lstart="],{env:{...globalThis.process.env,TZ:"UTC"},signal,timeout:2000});
    return stdout.replace(/\s+/g," ").trim() || null;
  } catch {return null;}
}
