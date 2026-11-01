import { stat } from "node:fs/promises";
import { z } from "zod";
import { runAutomation } from "./bridge";
import { claudeSession, claudeTtys, transcriptPathFor } from "./claude-session";
import { screenText } from "./claude-view";
import { inputSkills } from "./input-skills";
import { groupColor, readTabGroups, type TabGroup } from "./metadata";
import { readSavedGroups } from "./saved-layout";
import { ItermApi, tabSessions } from "./iterm-api";
import { uploadPath } from "./uploads";
import { answerQuestion } from "./question";
import { actionResult, inputOptionsSchema, listSchema, previewSchema, type Action, type ClaudeSend, type Key, type Session, type SessionList } from "./contract";

// The operations the web app can perform against iTerm2 on this Mac.
// Reads, typing and focus go through iTerm's API over one persistent connection;
// AppleScript is the fallback, and still handles tab/window management.
const api=new ItermApi();
const SHELLS=new Set(["zsh","bash","fish","sh","tcsh","csh","ksh","nu","login","-zsh","-bash","-fish"]);
const KEYS:Record<Key,string>={"enter":"\r","tab":"\t","shift-tab":"\x1b[Z","escape":"\x1b","ctrl-c":"\x03","ctrl-d":"\x04","up":"\x1b[A","down":"\x1b[B","right":"\x1b[C","left":"\x1b[D","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9"};
const SCREEN_LINES=600;
const ttys=new Map<string,string>();
const str=(v:unknown)=>typeof v==="string"?v:"";

async function listViaApi(signal:AbortSignal):Promise<SessionList> {
  const windows=await api.listSessions();
  // Older iTerm builds (e.g. 3.7.0) leave tab groups out of the listing; read them
  // from iTerm's saved layout instead.
  const apiHasGroups=windows.some(w=>w.tabs?.some(t=>t.tabGroupId));
  const savedGroups=apiHasGroups?null:layoutGroups().then(g=>({ok:true as const,g}),(error:unknown)=>({ok:false as const,error}));
  const rows:{session:Omit<Session,"name"|"tty"|"cwd"|"profile"|"processing"|"atPrompt"|"claude"|"tabName">;tabId:string}[]=[];
  windows.forEach((window,wi)=>(window.tabs || []).forEach((tab,ti)=>tabSessions(tab).forEach((s,si)=>{
    rows.push({tabId:tab.tabId || "",session:{
      id:s.uniqueIdentifier!,windowId:wi+1,windowName:`Window ${wi+1}`,tabIndex:ti+1,paneIndex:si+1,
      selected:window.selectedTabId===tab.tabId && tab.activeSessionId===s.uniqueIdentifier,
      group:tab.tabGroupId?{id:tab.tabGroupId,name:tab.tabGroupName || "",color:groupColor(tab.tabGroupColor || ""),collapsed:!!tab.tabGroupCollapsed}:null,
    }});
  })));
  const capped=rows.slice(0,1000);
  // Requests are pipelined on the one connection, so these take a few ms in total.
  const [titles,vars]=await Promise.all([
    Promise.all([...new Set(capped.map(r=>r.tabId))].map(async tabId=>[tabId,str((await api.variables({tabId},["title"]).catch(()=>({title:""}))).title)] as const)).then(e=>new Map(e)),
    Promise.all(capped.map(r=>api.variables({sessionId:r.session.id},["name","tty","path","jobName","profileName"]).catch(()=>null))),
  ]);
  signal.throwIfAborted();
  const sessions=capped.map((r,i)=>{
    const v=vars[i] || {};
    const job=str(v.jobName);
    const tty=str(v.tty);
    if(tty)ttys.set(r.session.id,tty);
    return {...r.session,name:str(v.name),tabName:titles.get(r.tabId) || "",tty,cwd:str(v.path),profile:str(v.profileName),
      atPrompt:!job || SHELLS.has(job),processing:!!job && !SHELLS.has(job),claude:job==="claude"};
  });
  // jobName is enough for the badge in the usual case; ps catches other launchers.
  const [claude,grouped]=await Promise.all([claudeTtys(sessions.filter(s=>!s.claude && !s.atPrompt).map(s=>s.tty),signal).catch(()=>new Set<string>()),savedGroups]);
  const result:SessionList={running:true,truncated:rows.length>capped.length,sessions:sessions.map(s=>({...s,claude:s.claude || claude.has(s.tty),group:grouped?.ok?grouped.g.get(s.id) || null:s.group}))};
  if(grouped && !grouped.ok)result.metadataError=grouped.error instanceof Error ? grouped.error.message : String(grouped.error);
  return result;
}

// Reading the saved layout takes ~0.3-1s, so serve the last result and refresh it
// in the background. Groups lag edits until iTerm saves its layout anyway.
let layout:{at:number;groups?:Map<string,TabGroup>;refresh?:Promise<Map<string,TabGroup>>}={at:0};
function layoutGroups():Promise<Map<string,TabGroup>> {
  const refresh=()=>layout.refresh??=readSavedGroups(AbortSignal.timeout(10000))
    .then(groups=>{layout={at:Date.now(),groups};return groups;})
    .finally(()=>{layout.refresh=undefined;});
  if(!layout.groups)return refresh();
  if(Date.now()-layout.at>5000)void refresh().catch(()=>{});
  return Promise.resolve(layout.groups);
}

async function listViaAppleScript(signal:AbortSignal) {
  const groups=readTabGroups(signal).then(g=>({ok:true as const,g}),(error:unknown)=>({ok:false as const,error}));
  let result=listSchema.parse(await runAutomation({method:"list"},signal));
  if(!result.running)return result;
  const [claude,grouped]=await Promise.all([claudeTtys(result.sessions.map(s=>s.tty),signal).catch(()=>null),groups]);
  if(claude)result={...result,sessions:result.sessions.map(s=>({...s,claude:claude.has(s.tty)}))};
  if(!grouped.ok)return {...result,metadataError:grouped.error instanceof Error ? grouped.error.message : String(grouped.error)};
  return {...result,sessions:result.sessions.map(session=>({...session,group:grouped.g.get(session.id) || null}))};
}

export async function list(signal:AbortSignal):Promise<SessionList> {
  try {return listSchema.parse(await listViaApi(signal));}
  catch {return listViaAppleScript(signal);}
}

async function ttyFor(sessionId:string) {
  const cached=ttys.get(sessionId);
  if(cached)return cached;
  const tty=str((await api.variables({sessionId},["tty"])).tty);
  ttys.set(sessionId,tty);
  return tty;
}

export async function preview(sessionId:string,signal:AbortSignal) {
  let raw:{text:string;truncated:boolean;tty:string};
  try {
    const [text,tty]=await Promise.all([api.screen(sessionId,SCREEN_LINES),ttyFor(sessionId)]);
    raw={text:text.slice(-64000),truncated:text.length>64000,tty};
  } catch(error) {
    if(/no longer exists/.test(String(error)))throw error;
    raw=z.object({text:z.string(),truncated:z.boolean(),tty:z.string()}).parse(await runAutomation({method:"preview",sessionId},signal));
    ttys.set(sessionId,raw.tty);
  }
  raw.text=screenText(raw.text);
  return previewSchema.parse({text:raw.text,truncated:raw.truncated,claude:await claudeSession(raw.tty,raw.text,signal)});
}
// The Claude transcript behind a session, if its last preview found one.
export function transcriptPath(sessionId:string) {
  const tty=ttys.get(sessionId);
  return tty?transcriptPathFor(tty):undefined;
}
// iTerm pushes a notification whenever the session's screen changes.
export function onScreenUpdate(sessionId:string,listener:()=>void) {
  return api.onScreenUpdate(sessionId,listener);
}

async function context(sessionId:string,signal:AbortSignal) {
  try {
    const v=await api.variables({sessionId},["path","tty"]);
    return {cwd:str(v.path),tty:str(v.tty)};
  } catch(error) {
    if(/no longer exists/.test(String(error)))throw error;
    return z.object({cwd:z.string(),tty:z.string()}).parse(await runAutomation({method:"input-context",sessionId},signal));
  }
}

export async function inputOptions(sessionId:string,signal:AbortSignal) {
  const {cwd}=await context(sessionId,signal);
  if(!cwd.startsWith("/"))return {skills:[],truncated:false};
  return inputOptionsSchema.parse(await inputSkills(cwd,signal));
}

async function type(sessionId:string,text:string,signal:AbortSignal) {
  try {await api.sendText(sessionId,text);}
  catch(error) {
    if(/no longer exists/.test(String(error)))throw error;
    await runAutomation({method:"action",action:{kind:"send",sessionId,text,enter:false}},signal);
  }
  return {sessionId};
}

// One answer at a time per terminal: each step reads the screen to see where the cursor is.
const answering=new Map<string,Promise<unknown>>();
async function question(input:Extract<Action,{kind:"question"}>,signal:AbortSignal) {
  const id=input.sessionId;
  const previous=answering.get(id) ?? Promise.resolve();
  const run=previous.catch(()=>{}).then(()=>answerQuestion({
    read:async()=>{
      signal.throwIfAborted();
      try {return screenText(await api.screen(id,SCREEN_LINES));}
      catch(error) {
        if(/no longer exists/.test(String(error)))throw error;
        return screenText(z.object({text:z.string()}).parse(await runAutomation({method:"preview",sessionId:id},signal)).text);
      }
    },
    type:async text=>{await type(id,text,signal);},
  },input.prompt,input.answer));
  answering.set(id,run);
  try {await run;}
  finally {if(answering.get(id)===run)answering.delete(id);}
  return {sessionId:id};
}

export async function action(input:Action,signal:AbortSignal) {
  if(input.kind==="question")return question(input,signal);
  if(input.kind==="send")return type(input.sessionId,input.text+(input.enter?"\r":""),signal);
  if(input.kind==="key")return type(input.sessionId,KEYS[input.key],signal);
  if(input.kind==="focus"){
    try {await api.activate(input.sessionId);return {sessionId:input.sessionId};} catch { /* fall through */ }
  }
  return actionResult.parse(await runAutomation({method:"action",action:input},signal));
}

// Paste the message (plus attachment paths) into Claude as one bracketed paste, then Enter.
export async function sendClaude(sessionId:string,input:ClaudeSend,signal:AbortSignal) {
  const {tty}=await context(sessionId,signal);
  if(!await claudeSession(tty,"",signal))throw Error("Claude is no longer running in this terminal. Your draft was kept.");
  const paths:string[]=[];
  for(const file of input.files){
    const path=uploadPath(sessionId,file);
    if(!(await stat(path).catch(()=>null))?.isFile())throw Error("Attachment unavailable; attach it again.");
    paths.push(path);
  }
  const text=[input.text,...paths.map(path=>`Attached file: ${path}`)].filter(Boolean).join("\n");
  if(!text || text.length>16000)throw Error("Message must contain between 1 and 16,000 characters.");
  return type(sessionId,`\x1b[200~${text}\x1b[201~\r`,signal);
}
