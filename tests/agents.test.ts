import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyMessages, agyTranscriptFrom, codexMessages, codexRollout } from "../server/agents";
import { agentOf } from "../server/herdr";

const line=(r:object)=>JSON.stringify(r);

test("knows Claude, Codex and Antigravity from Herdr's status or the program's name",()=>{
  assert.equal(agentOf({status:{app:"antigravity"},foreground:null}),"antigravity");
  assert.equal(agentOf({status:{app:"claude-code"},foreground:null}),"claude");
  assert.equal(agentOf({status:null,foreground:{pid:1,name:"codex",argv:["/opt/homebrew/bin/codex"],cwd:null}}),"codex");
  assert.equal(agentOf({status:null,foreground:{pid:1,name:"agy",argv:["agy"],cwd:null}}),"antigravity");
  assert.equal(agentOf({status:null,foreground:{pid:1,name:"zsh",argv:["-zsh"],cwd:null}}),null);
});

test("Antigravity: your words, its replies, and each tool call with its result",()=>{
  const text=[
    "{partial",
    line({step_index:0,type:"USER_INPUT",status:"DONE",content:"<USER_REQUEST>\nShip the fix\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>"}),
    line({step_index:1,type:"PLANNER_RESPONSE",status:"DONE",thinking:"private",tool_calls:[
      {name:"run_command",args:{CommandLine:"\"npm test\"",toolSummary:"\"Run the tests\""}},
      {name:"read_file",args:{Path:"\"/repo/a.ts\"",StartLine:"10"}},
    ]}),
    line({step_index:2,type:"GENERIC",status:"DONE",content:"Created At: x\nCompleted At: y\nCommand exited with code 0."}),
    line({step_index:3,type:"SYSTEM_MESSAGE",status:"DONE",content:"<SYSTEM_MESSAGE>work efficiently</SYSTEM_MESSAGE>"}),
    line({step_index:4,type:"GENERIC",status:"RUNNING",content:""}),
    line({step_index:5,type:"PLANNER_RESPONSE",status:"DONE",content:"**Done.** Tests pass."}),
  ].join("\n");
  const rows=agyMessages(text);
  assert.deepEqual(rows.map(m=>[m.role,m.name ?? ""]),[["user",""],["tool","Bash"],["tool","Read"],["assistant",""]]);
  assert.equal(rows[0].text,"Ship the fix");
  assert.deepEqual(JSON.parse(rows[1].text),{command:"npm test",description:"Run the tests"});
  assert.equal(rows[1].result,"Command exited with code 0.");assert.equal(rows[1].status,"completed");
  assert.deepEqual(JSON.parse(rows[2].text),{file_path:"/repo/a.ts",offset:10});assert.equal(rows[2].status,"pending");
  assert.ok(!JSON.stringify(rows).includes("private") && !JSON.stringify(rows).includes("efficiently"));
});

test("Antigravity: the conversation comes from the presence lock it holds open",()=>{
  const id="87a635bd-76ba-4dc7-9175-77960814d1b5";
  assert.deepEqual(agyTranscriptFrom(["/x/.gemini/antigravity-cli/presence",`/x/.gemini/antigravity-cli/presence/${id}.lock`]),
    {id,path:`/x/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`});
  assert.equal(agyTranscriptFrom(["/x/.gemini/antigravity-cli/presence"]),null);
});

const item=(item:object)=>line({type:"event_msg",payload:{type:"item_completed",item}});
test("Codex: messages, commands, file changes and tool calls from finished items",()=>{
  const text=[
    line({type:"session_meta",payload:{cwd:"/repo"}}),
    line({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"# AGENTS.md instructions"}]}}),
    item({type:"UserMessage",id:"u1",content:[{type:"text",text:"Why is CI red?"}]}),
    item({type:"Reasoning",id:"r1",summary_text:[]}),
    item({type:"AgentMessage",id:"a1",content:[{type:"Text",text:"Checking the logs."}],phase:"commentary"}),
    item({type:"CommandExecution",id:"c1",command:["/bin/zsh","-lc","gh run view"],cwd:"file:///repo",status:"completed",aggregated_output:"failed: lint",exit_code:1}),
    item({type:"FileChange",id:"f1",changes:{"/repo/a.rb":{type:"update",unified_diff:"-a\n+b"}},status:"completed"}),
    item({type:"McpToolCall",id:"m1",appName:"GitHub",actionName:"search_prs",arguments:{query:"is:open"},status:"failed",result:{content:[{type:"text",text:"API error"}]}}),
    item({type:"AgentMessage",id:"a2",content:[{type:"Text",text:"Lint fails on a.rb; fixed."}],phase:"final_answer"}),
  ].join("\n");
  const rows=codexMessages(text);
  assert.deepEqual(rows.map(m=>[m.role,m.name ?? "",m.status ?? ""]),[["user","",""],["assistant","",""],["tool","Bash","error"],["tool","Edit","completed"],["tool","GitHub search_prs","error"],["assistant","",""]]);
  assert.deepEqual(JSON.parse(rows[2].text),{command:"gh run view",cwd:"/repo"});
  assert.equal(rows[2].result,"failed: lint");
  assert.equal(JSON.parse(rows[3].text).file_path,"/repo/a.rb");
  assert.equal(rows[4].result,"API error");
});

test("Codex: the open rollout, else the newest one for the folder since the process started",async()=>{
  const root=mkdtempSync(join(tmpdir(),"afkterm-codex-"));
  const now=new Date(2026,10,24,12).getTime();
  const dir=join(root,"sessions","2026","11","24");mkdirSync(dir,{recursive:true});
  const file=(id:string,cwd:string,at:number)=>{
    const path=join(dir,`rollout-2026-11-24T10-00-00-${id}.jsonl`);
    writeFileSync(path,line({type:"session_meta",payload:{cwd}})+"\n");utimesSync(path,at/1000,at/1000);return path;
  };
  const a="01a1f6f8-a052-7980-99bb-1cd35e84e7a8", b="01a1f6f8-a052-7980-99bb-1cd35e84e7a9", c="01a1f6f8-a052-7980-99bb-1cd35e84e7aa";
  file(a,"/repo",now-60*60000);
  const newest=file(b,"/repo",now-5*60000);
  file(c,"/other",now-60000);
  assert.deepEqual(await codexRollout([],"/repo",now-30*60000,root,now),{id:b,path:newest});
  assert.equal(await codexRollout([],"/repo",now-2*60000,root,now),null,"nothing written since it started");
  const held=join(root,"sessions/2026/11/20",`rollout-2026-11-20T09-00-00-${a}.jsonl`);
  assert.deepEqual(await codexRollout([held],"/repo",now,root,now),{id:a,path:held});
});
