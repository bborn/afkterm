import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeViewFor, liveClaudeState, processStarted } from "./claude-session";
import { screenText } from "./claude-view";
import { inputSkills } from "./input-skills";
import { uploadPath } from "./uploads";
import { answerQuestion } from "./question";
import { Hc, HcError } from "./hc";
import { envVar } from "./config";
import { inputOptionsSchema, listSchema, previewSchema, type Action, type ClaudeSend, type Key, type Session, type SessionList } from "./contract";

// The same operations as ./iterm, against the Herdr desktop app. Terminals, screens
// and typing go through herdr-core's socket; spaces, tabs and panes come from the
// app (`herdr-app ls` and `herdr-app do`), since herdr-core only knows terminals.
const hc=new Hc();
// herdr-core answers one call at a time per connection, so slow history reads get
// their own: otherwise they hold up a newly opened pane, the list and typing.
const history=new Hc();
const SCREEN_LINES=600;
const SHELLS=new Set(["zsh","bash","fish","sh","tcsh","csh","ksh","nu","login","-zsh","-bash","-fish"]);
// herdr-core's key names (see `hc schema`, terminal.keys).
const KEYS:Record<Key,string>={"enter":"enter","tab":"tab","shift-tab":"shift+tab","escape":"esc","ctrl-c":"ctrl+c","ctrl-d":"ctrl+d","up":"up","down":"down","left":"left","right":"right","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9"};
// Herdr spaces have no color of their own; give each a steady one from this set.
const COLORS=["#5e9ce6","#d9734a","#4caf7a","#b07cd8","#d6a73c","#d65c8a","#4bb3b8","#8a8f98"];

interface Terminal {
  address:string;state:string;cols:number;rows:number;cwd:string|null;title:string;name:string|null;
  foreground:{pid:number;name:string;argv:string[];cwd:string|null}|null;
  status:{app?:string;state?:string}|null;labels:Record<string,string>;
}
interface AppTerminal {terminal:string;pane:string;status:string|null;app:string|null;name:string|null}
interface AppTab {id:string;name:string;active:boolean;terminals:AppTerminal[]}
interface AppSpace {id:string;name:string;folder:string|null;machine:string|null;active:boolean;tabs:AppTab[]}
interface Place {space:string;tab:string;pane:string}

const places=new Map<string,Place>();
const transcripts=new Map<string,string>();
const str=(v:unknown)=>typeof v==="string"?v:"";
const isRemote=(address:string)=>address.includes("/");
export const isClaude=(t:Pick<Terminal,"status"|"foreground">)=>t.status?.app==="claude-code" || /(?:^|\/)claude$/.test(t.foreground?.argv?.[0] ?? "");

async function exists(path:string) {
  try {await access(path,constants.X_OK);return true;} catch {return false;}
}
// launchd starts us with a bare PATH, so find the app by absolute path.
let app:Promise<string|null>|undefined;
export function herdrApp() {
  return app??=(async()=>{
    for(const path of [envVar("HERDR_APP"),join(homedir(),".local","bin","herdr-app"),"/Applications/Herdr.app/Contents/MacOS/Herdr",join(homedir(),"Applications","Herdr.app","Contents","MacOS","Herdr")])
      if(path && await exists(path))return path;
    return null;
  })().then(path=>{if(!path)app=undefined;return path;});
}

async function runApp(args:string[],signal?:AbortSignal):Promise<any> {
  const path=await herdrApp();
  if(!path)throw new HcError("Herdr isn't installed on this Mac.","unavailable");
  try {
    const {stdout}=await promisify(execFile)(path,args,{signal,timeout:10000,maxBuffer:8*1024*1024});
    const text=stdout.trim();
    if(!text)return null;
    try {return JSON.parse(text);} catch {return text;}
  } catch(error:any) {
    const detail=str(error?.stderr).trim() || str(error?.stdout).trim() || String(error?.message ?? error);
    throw new HcError(detail.replace(/^error:\s*/i,"").split("\n")[0] || "Herdr couldn't do that.");
  }
}
const appCommand=(command:string,args:Record<string,unknown>,signal?:AbortSignal)=>runApp(["do",command,JSON.stringify(args)],signal);

async function appLayout(signal:AbortSignal):Promise<AppSpace[]|null> {
  try {
    const result=await runApp(["ls"],signal);
    return Array.isArray(result?.spaces)?result.spaces:null;
  } catch {return null;}
}

// What Herdr calls a tab: the name someone gave it, or, while it still has its
// automatic number, its lead agent's title (as Herdr's agents panel does).
export function tabLabel(tab:AppTab,byAddress:Map<string,Terminal>) {
  if(!/^\d+$/.test(tab.name))return tab.name;
  const terminals=tab.terminals.map(e=>byAddress.get(e.terminal)).filter((t):t is Terminal=>!!t);
  const lead=terminals.find(isClaude) ?? terminals[0];
  const title=(lead?.title || "").trim();
  const telling=title && title!==lead?.foreground?.name && !/^[~/]/.test(title) && !title.includes("@");
  return telling?title:tab.name;
}

// One row per pane, in the order the app shows them. Each space is a group;
// Herdr has one window.
export function sessionsFrom(terminals:Terminal[],spaces:AppSpace[]|null):Session[] {
  const byAddress=new Map(terminals.map(t=>[t.address,t]));
  const sessions:Session[]=[];
  const base=(t:Terminal)=>{
    const shell=!t.foreground || SHELLS.has(t.foreground.name);
    const claude=isClaude(t);
    return {
      id:t.address,name:t.title || t.name || "",tty:"",
      profile:t.status?.app || t.foreground?.name || "",cwd:t.foreground?.cwd || t.cwd || "",
      processing:t.status?.state==="working" || (!shell && !claude),atPrompt:shell && !claude,claude,
      windowId:1,windowName:"Herdr",
    };
  };
  if(spaces){
    let tabIndex=0;
    spaces.forEach((space,si)=>{
      const group={id:space.id,name:space.name+(space.machine?` · ${space.machine}`:""),color:COLORS[si%COLORS.length],collapsed:false};
      for(const tab of space.tabs){
        tabIndex++;
        tab.terminals.forEach((entry,pi)=>{
          const t=byAddress.get(entry.terminal);
          if(!t || t.state!=="live")return;
          places.set(t.address,{space:space.id,tab:tab.id,pane:entry.pane});
          const row=base(t);
          sessions.push({...row,name:row.name || entry.name || "",tabName:tabLabel(tab,byAddress),group,tabIndex,paneIndex:pi+1,
            selected:space.active && tab.active && pi===0});
        });
      }
    });
    return sessions;
  }
  // The app isn't running: herdr-core still knows where each terminal belongs.
  const groups=new Map<string,Session["group"]>();
  const tabs=new Map<string,{index:number;panes:number}>();
  for(const t of terminals){
    if(t.state!=="live")continue;
    const where=t.labels.where || "";
    const space=t.labels["herdr.space"] || where.split(" / ")[0];
    const tab=t.labels["herdr.tab"] || where.split(" / ").slice(1).join(" / ");
    if(!space)continue; // a worker nobody placed
    if(!groups.has(space))groups.set(space,{id:space,name:where.split(" / ")[0] || space,color:COLORS[groups.size%COLORS.length],collapsed:false});
    const key=`${space}\n${tab}`;
    const slot=tabs.get(key) ?? {index:tabs.size+1,panes:0};
    slot.panes++;tabs.set(key,slot);
    sessions.push({...base(t),tabName:where.split(" / ").slice(1).join(" / ") || tab,group:groups.get(space)!,tabIndex:slot.index,paneIndex:slot.panes,selected:false});
  }
  return sessions;
}

export async function list(signal:AbortSignal):Promise<SessionList> {
  let terminals:Terminal[];
  try {terminals=(await hc.call<{terminals:Terminal[]}>("terminal.list",{})).terminals;}
  catch(error) {
    if(error instanceof HcError && error.kind==="unavailable")return {running:false,sessions:[],truncated:false};
    throw error;
  }
  const spaces=await appLayout(signal);
  signal.throwIfAborted();
  // terminal.list covers this Mac; ask for panes on other machines one by one.
  const known=new Set(terminals.map(t=>t.address));
  const missing=(spaces ?? []).flatMap(s=>s.tabs.flatMap(t=>t.terminals.map(e=>e.terminal))).filter(a=>!known.has(a)).slice(0,100);
  if(missing.length)terminals=[...terminals,...(await Promise.all(missing.map(terminal=>hc.call<Terminal>("terminal.get",{terminal},5000).catch(()=>null)))).filter((t):t is Terminal=>!!t)];
  const sessions=sessionsFrom(terminals,spaces);
  const result:SessionList={running:true,truncated:sessions.length>1000,sessions:sessions.slice(0,1000)};
  if(!spaces)result.metadataError="Herdr isn't open, so tabs are named from what herdr-core remembers.";
  return listSchema.parse(result);
}

async function facts(terminal:string):Promise<Terminal> {
  try {return await hc.call<Terminal>("terminal.get",{terminal});}
  catch(error) {
    if(error instanceof HcError && error.kind==="not_found")throw Error("This session no longer exists.");
    throw error;
  }
}
// History of a full-screen app (Claude) is read by scrolling it, which takes
// seconds whenever its screen changed; lines:0 is the screen alone, in ~1ms.
async function screen(terminal:string,lines=SCREEN_LINES) {
  return str((await (lines?history:hc).call<{text:string}>("terminal.read",{terminal,lines})).text);
}

// Claude's chat view, from its saved transcript when it runs on this Mac.
async function claudeView(t:Terminal,text:string,signal:AbortSignal) {
  if(!isClaude(t)){transcripts.delete(t.address);return null;}
  const pid=t.foreground?.pid;
  const started=pid && !isRemote(t.address)?await processStarted(pid,signal):null;
  if(!pid || !started)return {source:"screen" as const,identity:t.address,messages:[],...liveClaudeState(text)};
  return claudeViewFor({pid,tty:"",foreground:pid,group:pid,started,command:"claude"},text,signal,path=>transcripts.set(t.address,path));
}

export async function preview(sessionId:string,signal:AbortSignal,lines=SCREEN_LINES) {
  const [t,raw]=await Promise.all([facts(sessionId),screen(sessionId,lines)]);
  const text=screenText(raw.slice(-64000));
  return previewSchema.parse({text,truncated:raw.length>64000,claude:await claudeView(t,text,signal)});
}
// The first paint of a pane: everything but the terminal's history.
export const quickPreview=(sessionId:string,signal:AbortSignal)=>preview(sessionId,signal,0);
export const transcriptPath=(sessionId:string)=>transcripts.get(sessionId);

// herdr-core reports fact changes (title, status, turn); screen output itself
// isn't pushed, so the live view also keeps polling.
export function onScreenUpdate(sessionId:string,listener:()=>void) {
  return hc.onEvent(event=>{if(event.terminal===sessionId)listener();});
}

export async function inputOptions(sessionId:string,signal:AbortSignal) {
  if(isRemote(sessionId))return {skills:[],truncated:false};
  const t=await facts(sessionId);
  const cwd=t.foreground?.cwd || t.cwd || "";
  if(!cwd.startsWith("/"))return {skills:[],truncated:false};
  return inputOptionsSchema.parse(await inputSkills(cwd,signal));
}

// The app's tab and pane for a terminal: from the last listing, or a fresh one.
async function place(sessionId:string,signal:AbortSignal):Promise<Place> {
  let found=places.get(sessionId);
  if(!found){await list(signal);found=places.get(sessionId);}
  if(!found)throw Error("Open Herdr on this Mac to manage its tabs.");
  return found;
}

const answering=new Map<string,Promise<unknown>>();
async function question(input:Extract<Action,{kind:"question"}>,signal:AbortSignal) {
  const id=input.sessionId;
  const previous=answering.get(id) ?? Promise.resolve();
  const run=previous.catch(()=>{}).then(()=>answerQuestion({
    // The dialog is on screen, and each step changes it: skip the slow history read.
    read:async()=>{signal.throwIfAborted();return screenText(await screen(id,0));},
    type:text=>hc.type(id,text),
  },input.prompt,input.answer));
  answering.set(id,run);
  try {await run;}
  finally {if(answering.get(id)===run)answering.delete(id);}
  return {sessionId:id};
}

const terminalOf=(result:any):string|null=>typeof result?.terminal==="string"?result.terminal:null;

export async function action(input:Action,signal:AbortSignal):Promise<{sessionId:string|null}> {
  switch(input.kind){
  case "question":return question(input,signal);
  case "key":
    await hc.call("terminal.keys",{terminal:input.sessionId,keys:[KEYS[input.key]]});
    return {sessionId:input.sessionId};
  case "send":
    // The phone is the person at the keyboard, so type the text as they would.
    await hc.type(input.sessionId,input.text+(input.enter?"\r":""));
    return {sessionId:input.sessionId};
  case "focus":
    await appCommand("pane.focus",{terminal:input.sessionId},signal);
    return {sessionId:input.sessionId};
  case "rename":{
    const {tab}=await place(input.sessionId,signal);
    await appCommand("tab.rename",{id:tab,name:input.name},signal);
    return {sessionId:input.sessionId};
  }
  case "close":{
    const found=places.get(input.sessionId);
    if(found)await appCommand("pane.close",{pane:found.pane},signal);
    else await hc.call("terminal.kill",{terminal:input.sessionId});
    places.delete(input.sessionId);
    return {sessionId:null};
  }
  case "close-tab":{
    const {tab}=await place(input.sessionId,signal);
    await appCommand("tab.close",{id:tab,confirmed:true},signal);
    places.delete(input.sessionId);
    return {sessionId:null};
  }
  case "split":{
    const {pane}=await place(input.sessionId,signal);
    const result=await appCommand("pane.split",{pane,direction:input.direction==="vertical"?"right":"down"},signal);
    return {sessionId:terminalOf(result)};
  }
  case "new-tab":{
    const {space}=await place(input.sessionId,signal);
    return {sessionId:terminalOf(await appCommand("tab.new",{space},signal))};
  }
  case "new-window":
    return {sessionId:terminalOf(await appCommand("space.new",{},signal))};
  }
}

// Paste the message (plus attachment paths) into Claude, then Enter. Attachments
// are saved on this Mac; a remote Claude gets its own copy through herdr-core.
export async function sendClaude(sessionId:string,input:ClaudeSend,signal:AbortSignal) {
  const t=await facts(sessionId);
  if(t.state!=="live" || !isClaude(t))throw Error("Claude is no longer running in this terminal. Your draft was kept.");
  const paths:string[]=[];
  for(const file of input.files){
    const local=uploadPath(sessionId,file);
    if(!(await stat(local).catch(()=>null))?.isFile())throw Error("Attachment unavailable; attach it again.");
    if(!isRemote(sessionId)){paths.push(local);continue;}
    const sent=await hc.call<{path:string}>("terminal.put",{terminal:sessionId,name:file.name,data:(await readFile(local)).toString("base64")},60000);
    paths.push(sent.path);
  }
  const text=[input.text,...paths.map(path=>`Attached file: ${path}`)].filter(Boolean).join("\n");
  if(!text || text.length>16000)throw Error("Message must contain between 1 and 16,000 characters.");
  await hc.type(sessionId,`\x1b[200~${text}\x1b[201~\r`);
  return {sessionId};
}

export const hostName=()=>hostname().replace(/\.local$/,"");
export const appName=()=>"Herdr";
