import test from "node:test";
import assert from "node:assert/strict";
import { foregroundClaude } from "../server/claude-session";
import { transcriptMessages } from "../server/claude-view";

const sid="session-one";
const entry=(uuid:string,parentUuid:string|null,type:string,content:unknown,extra={})=>JSON.stringify({uuid,parentUuid,type,sessionId:sid,message:{content},...extra});
test("matches the foreground Claude group leader on the exact terminal",()=>{
  const ps=`1 0 ttys001 30 1 Wed Sep 16 01:02:03 2026 -zsh
30 1 ttys001 30 30 Wed Sep 16 01:02:04 2026 /usr/bin/claude
31 30 ttys001 30 30 Wed Sep 16 01:02:04 2026 claude
40 1 ttys002 40 40 Wed Sep 16 01:02:04 2026 claude`;
  assert.equal(foregroundClaude(ps,"/dev/ttys001")?.pid,30);
  assert.equal(foregroundClaude(ps,"/dev/ttys002")?.pid,40);
  assert.equal(foregroundClaude(ps,"/dev/ttys003"),null);
  assert.equal(foregroundClaude(ps.replaceAll("ttys001 30","ttys001 1"),"/dev/ttys001"),null);
});
test("transcripts retain message roles, Markdown and tool outcomes without treating tool results as user turns",()=>{
  const text=[entry("a",null,"user","Help me"),entry("b","a","assistant",[{type:"thinking",thinking:"private"},{type:"text",text:"## Result\n**Works**"},{type:"tool_use",id:"tool",name:"Read",input:{file_path:"a.ts"}}]),entry("c","b","user",[{type:"tool_result",tool_use_id:"tool",content:"file body",is_error:false}]),entry("d","c","assistant",[{type:"text",text:"Done."}])].join("\n");
  const rows=transcriptMessages(text,sid);
  assert.deepEqual(rows.map(m=>m.role),["user","assistant","tool","assistant"]);
  assert.equal(rows[1].text,"## Result\n**Works**");
  assert.equal(rows[2].result,"file body");assert.equal(rows[2].status,"completed");
  assert.ok(!JSON.stringify(rows).includes("private"));
});
test("excludes unrelated sessions, sidechains and rewound branches; tolerates partial writes",()=>{
  const lines=["{partial",entry("a",null,"user","question"),entry("old","a","assistant","obsolete"),entry("new","a","assistant","current"),entry("wrong","new","assistant","other session",{sessionId:"other"}),entry("side","new","assistant","subagent",{isSidechain:true}),'{"unfinished":'];
  assert.deepEqual(transcriptMessages(lines.join("\n"),sid).map(m=>m.text),["question","current"]);
});
test("live permission prompts become tappable options",async()=>{
  const {liveClaudePrompt}=await import("../server/claude-view");
  const prompt=liveClaudePrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No")!;
  assert.equal(prompt.question,"Do you want to proceed?");
  assert.deepEqual(prompt.options,[{key:"1",label:"Yes",selected:true},{key:"2",label:"No",selected:false}]);
  assert.equal(liveClaudePrompt("The docs ask: Do you want to proceed?"),undefined);
});
test("boxed prompts with wrapped options parse cleanly",async()=>{
  const {liveClaudePrompt}=await import("../server/claude-view");
  const screen=["⏺ Bash(rm -rf build)","","╭──────────────────────────╮","│ Bash command             │","│                          │","│   rm -rf build           │","│                          │","│ Do you want to proceed?  │","│ ❯ 1. Yes                 │","│   2. Yes, and don't ask  │","│      again for rm        │","│   3. No (esc)            │","╰──────────────────────────╯"].join("\n");
  const prompt=liveClaudePrompt(screen)!;
  assert.equal(prompt.question,"Do you want to proceed?");
  assert.deepEqual(prompt.options.map(o=>[o.label,o.detail]),[["Yes",undefined],["Yes, and don't ask","again for rm"],["No (esc)",undefined]]);
  assert.match(prompt.text,/rm -rf build/);
});
test("AskUserQuestion menus parse when iTerm reports untouched cells as NUL",async()=>{
  const {liveClaudePrompt,screenText}=await import("../server/claude-view");
  const screen=[" ☐ current-prod ","  ","│\x00Should I update current-prod now?","│\x00Hatchbox doesn't deploy until you trigger it."," ","❯\x001. Yes, merge and push (Recommended)","\x00\x00\x00\x00\x00I merge main into current-prod and push it."," \x002. I'll push it myself","\x00\x00\x00\x00\x00I give you the exact commands and stop here.","  3. Type something.","─".repeat(40),"  4. Chat about this","","Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
  const prompt=liveClaudePrompt(screenText(screen))!;
  assert.equal(prompt.question,"Should I update current-prod now?\nHatchbox doesn't deploy until you trigger it.");
  assert.deepEqual(prompt.options.map(o=>[o.key,o.label,o.selected,o.detail]),[
    ["1","Yes, merge and push (Recommended)",true,"I merge main into current-prod and push it."],
    ["2","I'll push it myself",false,"I give you the exact commands and stop here."],
    ["3","Type something.",false,undefined],
    ["4","Chat about this",false,undefined],
  ]);
});
test("numbered lists in Claude's output are not mistaken for a menu",async()=>{
  const {liveClaudePrompt}=await import("../server/claude-view");
  assert.equal(liveClaudePrompt("Here's the plan:\n1. Add tests\n2. Fix bug\n\n> "),undefined);
  assert.equal(liveClaudePrompt("Pick one\n❯ 1. A\n  2. B\n"+"\n".repeat(3)+"output\n".repeat(20)),undefined);
});
test("detects a running Claude turn from its spinner line",async()=>{
  const {claudeWorking}=await import("../server/claude-view");
  assert.equal(claudeWorking("⏺ Reading\n\n✻ Thinking… (12s · esc to interrupt)\n> "),true);
  assert.equal(claudeWorking("Done.\n> "),false);
});
test("AskUserQuestion menus with descriptions and a separated trailing option",async()=>{
  const {liveClaudePrompt}=await import("../server/claude-view");
  const screen=["⏺ Both fixes are ready.","","─".repeat(60),"←  ☐ Database  ☐ Deploy  ✔ Submit  →","","│ Which database should the new service use?","│ • The rest of the app runs on Postgres.","","❯ 1. Postgres","     Same as everything else.","  2. SQLite","     Simpler to run locally.","  3. Skip","     Leave it for now.","  4. Type something.","─".repeat(60),"  5. Chat about this","","Enter to select · Tab/Arrow keys to navigate · Esc to cancel",""].join("\n");
  const prompt=liveClaudePrompt(screen)!;
  assert.deepEqual(prompt.options.map(o=>o.key),["1","2","3","4","5"]);
  assert.equal(prompt.options[0].label,"Postgres");
  assert.equal(prompt.options[0].detail,"Same as everything else.");
  assert.equal(prompt.options[4].label,"Chat about this");
  assert.equal(prompt.question,"Which database should the new service use?\n• The rest of the app runs on Postgres.");
  assert.match(prompt.text,/☐ Database/);
});
test("reads Claude's permission mode from its status line",async()=>{
  const {claudeMode}=await import("../server/claude-view");
  assert.equal(claudeMode("> \n  ⏸ plan mode on (shift+tab to cycle)"),"plan mode");
  assert.equal(claudeMode("> \n  ⏵⏵ accept edits on (shift+tab to cycle)"),"accept edits");
  assert.equal(claudeMode("> \n  ⏵⏵ bypass permissions on (shift+tab to cycle)"),"bypass permissions");
  assert.equal(claudeMode("> \n  ? for shortcuts"),"default");
  assert.equal(claudeMode("just some output"),undefined);
});
test("notices select menus that need arrow keys",async()=>{
  const {claudeMenu}=await import("../server/claude-view");
  assert.equal(claudeMenu(" Select model\n ❯ Opus\n   Sonnet\n\n Enter to confirm · Esc to exit"),true);
  assert.equal(claudeMenu("Enter to select · Tab/Arrow keys to navigate · Esc to cancel"),true);
  assert.equal(claudeMenu("> \n  ? for shortcuts"),false);
});
