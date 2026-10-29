import type { ChatMessage, Prompt } from "./contract";

const MAX_TEXT = 12000;
const object = (v: unknown): Record<string,any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,any> : null;
const plain = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map(b=>object(b)?.type==="text" ? object(b)?.text || "" : "").join("\n") : "";
const bounded = (text:string) => text.length>MAX_TEXT ? text.slice(0,MAX_TEXT)+"\n… (truncated)" : text;

export function transcriptMessages(text:string, sessionId:string):ChatMessage[] {
  const records:Record<string,any>[]=[];
  for(const line of text.split("\n")) {
    try {const r=object(JSON.parse(line));if(r && r.sessionId===sessionId && !r.isSidechain)records.push(r);} catch { /* Partial first/last lines are normal for a live tail. */ }
  }
  // Follow the active branch, excluding obsolete turns left by rewinds.
  const byId=new Map(records.filter(r=>typeof r.uuid==="string").map(r=>[r.uuid,r]));
  const last=[...records].reverse().find(r=>(r.type==="user"||r.type==="assistant") && r.uuid);
  const chain=new Set<string>();let cursor=last;
  while(cursor && !chain.has(cursor.uuid)){chain.add(cursor.uuid);cursor=byId.get(cursor.parentUuid);}
  const messages:ChatMessage[]=[];
  const tools=new Map<string,ChatMessage>();
  for(const r of records) {
    if(byId.get(r.uuid)!==r || !chain.has(r.uuid) || r.isMeta || !["user","assistant"].includes(r.type))continue;
    const m=object(r.message);if(!m)continue;
    const blocks=typeof m.content==="string"?[{type:"text",text:m.content}]:Array.isArray(m.content)?m.content:[];
    for(const [i,raw] of blocks.entries()) {
      const b=object(raw);if(!b)continue;
      if(b.type==="text" && typeof b.text==="string" && b.text.trim())messages.push({id:`${r.uuid}:${i}`,role:r.type,text:bounded(b.text)});
      if(b.type==="tool_use" && typeof b.name==="string" && typeof b.id==="string") {
        const row:ChatMessage={id:b.id,role:"tool",text:bounded(JSON.stringify(b.input ?? {},null,2)),name:b.name.slice(0,100),status:"pending"};tools.set(b.id,row);messages.push(row);
      }
      if(b.type==="tool_result" && tools.has(b.tool_use_id)){
        const row=tools.get(b.tool_use_id)!;row.status=b.is_error?"error":"completed";row.result=bounded(plain(b.content));
      }
    }
  }
  let length=0;
  return messages.slice(-120).reverse().filter(m=>{length+=m.text.length+(m.result?.length||0);return length<=180000;}).reverse();
}

// iTerm reports cells nothing was ever written to as NUL. Claude Code's menus
// move the cursor over gaps instead of printing spaces, so turn them back into spaces.
export const screenText=(text:string)=>text.replaceAll("\0"," ");

const MENU_OPTION=/^(?:([❯›>])\s*)?([1-9])[.)]\s+(.+?)\s*$/;
const clean=(line:string)=>line.replace(/^[\s│┃|]+|[\s│┃|]+$/g,"");

// A numbered Claude menu (permission, plan approval, question) near the bottom of the screen.
export function liveClaudePrompt(text:string):Prompt|undefined {
  const lines=text.split("\n").slice(-60).map(clean);
  let end=lines.length-1;
  while(end>=0 && !MENU_OPTION.test(lines[end]))end--;
  if(end<0 || lines.length-1-end>8)return undefined;
  const separator=(line:string)=>/^[─━═-]{3,}/.test(line);
  let start=end;
  // Walk upward to the first option. Options carry wrapped or description lines,
  // and Claude may draw a separator before trailing options ("Chat about this").
  for(let i=end;i>=0 && end-i<40;i--){
    if(MENU_OPTION.test(lines[i]))start=i;
    else if(!lines[i])break;
    else if(separator(lines[i]) && !lines.slice(Math.max(0,i-6),i).some(l=>MENU_OPTION.test(l)))break;
  }
  const options:Prompt["options"]=[];
  for(const line of lines.slice(start,end+1)){
    const m=MENU_OPTION.exec(line);
    if(m)options.push({key:m[2],label:m[3],selected:!!m[1]});
    else if(options.length && line && !separator(line)){const o=options.at(-1)!;o.detail=o.detail?`${o.detail} ${line}`:line;}
  }
  if(options.length<2 || !options.some(o=>o.selected) || options.some((o,i)=>o.key!==String(i+1)))return undefined;
  let q=start-1;
  while(q>=0 && !lines[q])q--;
  const questionStart=Math.max(0,lines.slice(0,q+1).findLastIndex(l=>!l || separator(l))+1);
  const question=lines.slice(questionStart,q+1).join("\n").trim().slice(0,2000);
  // Context for "Details": what Claude wants to do, back to the top of the box (blank lines included).
  let contextStart=questionStart;
  while(contextStart>0 && questionStart-contextStart<20 && !/^[╭┌─━═]/.test(lines[contextStart-1]))contextStart--;
  const context=lines.slice(contextStart,end+1).join("\n").replace(/\n{3,}/g,"\n\n").trim().slice(0,3000);
  return {question,options:options.map(o=>({...o,label:o.label.slice(0,300),...(o.detail?{detail:o.detail.slice(0,300)}:{})})),text:context};
}

// Claude's spinner line ("esc to interrupt") is on screen while a turn is running.
export function claudeWorking(text:string):boolean {
  return text.split("\n").slice(-20).some(line=>/esc to interrupt/i.test(line));
}

// The mode Claude shows above its input, e.g. "⏸ plan mode on (shift+tab to cycle)".
// Returns undefined when Claude's input area isn't on screen (e.g. a menu is open).
export function claudeMode(text:string):string|undefined {
  const lines=text.split("\n").slice(-12);
  for(let i=lines.length-1;i>=0;i--){
    const m=/([a-z][a-z -]*?)\s+on\b[^\n]*shift\+tab/i.exec(lines[i]);
    if(m)return m[1].trim().toLowerCase();
  }
  if(lines.some(l=>/\?\s*for shortcuts|shift\+tab to cycle/i.test(l)))return "default";
  return undefined;
}

// A select menu (Enter to select / arrows to navigate) is waiting for keys.
export function claudeMenu(text:string):boolean {
  return text.split("\n").slice(-8).some(l=>/enter to (select|confirm)|↑\/↓|arrow keys to navigate|esc to (cancel|go back)/i.test(l));
}
