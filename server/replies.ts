import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./contract";
import { envVar } from "./config";

// Quick replies: a few short answers offered as chips when Claude's last message
// asks you something. Simple rules give an answer straight away; if the `claude`
// CLI is installed, Haiku suggests better ones in the background, once per message.

const MAX_REPLIES=4, MAX_LENGTH=60, TIMEOUT=20000;

// The last thing Claude said, if it ends the turn with a question to you.
export function askingMessage(messages:ChatMessage[]):ChatMessage|null {
  const last=messages.findLast(m=>m.role!=="tool");
  if(!last || last.role!=="assistant")return null;
  // The closing paragraph is a question, or a list of options right after one.
  const paragraphs=last.text.replace(/```[\s\S]*?```/g,"").trim().split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
  const asks=(p?:string)=>!!p && /\?[*_)\s"']*$/.test(p);
  const list=(p?:string)=>!!p && p.split("\n").every(l=>/^\s*(?:[-*•]|\d+[.)])\s/.test(l));
  return asks(paragraphs.at(-1)) || list(paragraphs.at(-1)) && asks(paragraphs.at(-2))?last:null;
}

// Without a model: the obvious answers to a yes/no question, or the two sides of "A or B?".
export function ruleReplies(text:string):string[] {
  const sentence=text.replace(/```[\s\S]*?```/g,"").trim().split(/(?<=[.!?:])\s+|\n+/).filter(s=>s.includes("?")).at(-1) ?? "";
  const choice=/\b(?:should I|do you want(?: me)? to|would you (?:like|prefer)(?: me)? to|want me to|shall I)\s+(.{2,40}?),?\s+or\s+(.{2,40}?)\?/i.exec(sentence);
  if(choice){
    const clean=(s:string)=>s.replace(/^(?:to|I)\s+/i,"").replace(/[*_`]/g,"").trim();
    const [a,b]=[clean(choice[1]),clean(choice[2])];
    if(a && b && !/\bor\b/i.test(a))return [cap(a),cap(b),"Not sure"];
  }
  const yesNo=/^(?:should|shall|do|does|did|can|could|would|will|is|are|want)\b/i.test(sentence.replace(/^[^,?]*,\s*/,"").trim())
    || /\b(?:should I|shall I|do you want|want me to|would you like|ok(?:ay)? to|sound good|go ahead|ready to|is that ok(?:ay)?)\b/i.test(sentence);
  if(yesNo)return ["Yes","No","Not sure"];
  return [];
}
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);

// The login agent runs with a bare PATH; Claude Code's installer puts it in ~/.local/bin.
function claudeBinary() {
  const configured=envVar("CLAUDE_BIN");
  return [configured,join(homedir(),".local","bin","claude"),"/opt/homebrew/bin/claude","/usr/local/bin/claude"].find(p=>p && existsSync(p));
}

const SYSTEM=`You suggest quick replies for a person reading a chat with a coding agent on their phone.
Given the end of the conversation, reply with ONLY a JSON array of 2 to ${MAX_REPLIES} short replies the person is likely to send next, most likely first.
Each reply is written as the person, at most 8 words, plain text, no emoji. Use the agent's own options when it offered some. Include an unsure or "tell me more" style reply when it fits.`;

export function parseReplies(output:string):string[] {
  const json=/\[[\s\S]*\]/.exec(output)?.[0];
  if(!json)return [];
  try {
    const list=JSON.parse(json);
    if(!Array.isArray(list))return [];
    return [...new Set(list.filter((s):s is string=>typeof s==="string").map(s=>s.trim()).filter(s=>s && s.length<=MAX_LENGTH))].slice(0,MAX_REPLIES);
  } catch {return [];}
}

function askModel(messages:ChatMessage[]):Promise<string[]> {
  const bin=claudeBinary();
  if(!bin)return Promise.resolve([]);
  const context=messages.filter(m=>m.role!=="tool").slice(-4)
    .map(m=>`${m.role==="user"?"Person":"Agent"}: ${m.text.length>3000?"…"+m.text.slice(-3000):m.text}`).join("\n\n");
  return new Promise(resolve=>{
    // No tools, hooks, MCP servers or saved session: this is a one-off question, not a Claude session.
    const child=execFile(bin,["-p","--model",envVar("REPLIES_MODEL") || "haiku","--no-session-persistence","--tools","","--setting-sources","","--strict-mcp-config","--disable-slash-commands","--system-prompt",SYSTEM],
      {cwd:tmpdir(),timeout:TIMEOUT,maxBuffer:64*1024},(error,stdout)=>resolve(error?[]:parseReplies(stdout)));
    child.stdin?.end(context);
  });
}

// Per message: the model's replies once they're in. `null` means asked and still waiting.
const cache=new Map<string,string[]|null>();
let running=0;
export function quickReplies(messages:ChatMessage[],ask=askModel):string[]|undefined {
  if(/^(?:0|off|false|no)$/i.test(envVar("QUICK_REPLIES") || ""))return undefined;
  const message=askingMessage(messages);
  if(!message)return undefined;
  const known=cache.get(message.id);
  if(known?.length)return known;
  const rules=ruleReplies(message.text);
  if(known===undefined && running<2){
    running++;cache.set(message.id,null);
    if(cache.size>200)cache.delete(cache.keys().next().value!);
    void ask(messages).catch(()=>[]).then(replies=>{running--;cache.set(message.id,replies);});
  }
  return rules.length?rules:undefined;
}
