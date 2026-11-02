import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerQuestion, claudeQuestion, type QuestionTerminal } from "../server/question";
import { liveClaudeState } from "../server/claude-session";

// Screens captured from Claude Code 2.1.316 in tmux while it showed AskUserQuestion.
const screen=(name:string)=>readFileSync(join(import.meta.dirname,"fixtures","ask-user-question",`${name}.txt`),"utf8");
const parse=(name:string)=>{const q=claudeQuestion(screen(name));assert.ok(q,`${name} should parse`);return q;};

test("reads a single-select question with free text and Chat about this",()=>{
  const q=parse("multi-q1");
  assert.deepEqual(q.tabs,[{label:"Color",answered:false},{label:"Toppings",answered:false}]);
  assert.equal(q.submitTab,true);
  assert.equal(q.prompt,"Which color?");
  assert.equal(q.multiSelect,false);
  assert.deepEqual(q.options.map(o=>[o.key,o.label,o.detail]),[["1","Red","warm"],["2","Blue","cool"],["3","Green","natural"]]);
  assert.deepEqual(q.other,{key:"4",text:"",checked:false});
  assert.deepEqual(q.chat,{key:"5"});
  assert.equal(q.cursor,"option:0");
  assert.equal(q.submit,undefined);
});

test("keeps a long question and long descriptions whole, unwrapping the terminal's line breaks",()=>{
  const width=110;
  const wrap=(text:string,indent="")=>{
    const out:string[]=[];let line="";
    for(const w of text.split(" ")){if(line && indent.length+line.length+1+w.length>width){out.push(indent+line);line=w;}else line=line?`${line} ${w}`:w;}
    return [...out,indent+line].join("\n");
  };
  const question="Which color should the header use? "+"The brand guide lists three accents and the design team keeps going back and forth between them. ".repeat(4)+"Pick one.";
  const detail="Warm and loud. "+"It matches the logo and the old landing page, which is most of what people have seen so far. ".repeat(3)+"The end.";
  const long=screen("multi-q1")
    .replace("\nWhich color?\n",`\n${wrap(question)}\n\nShort follow-up line.\n- a list item stays on its own line\n`)
    .replace("     warm",wrap(detail,"     "));
  const q=claudeQuestion(long);
  assert.ok(q);
  assert.ok(long.split("\n").filter(l=>l.startsWith("Which color") || l.startsWith("The brand")).length>1);   // the fixture really wraps
  assert.equal(q.prompt,`${question}\n\nShort follow-up line.\n- a list item stays on its own line`);
  assert.equal(q.options[0].detail,detail);
  assert.ok(question.length>300);
});

test("reads a multiSelect question with its checkboxes and Next/Submit row",()=>{
  const q=parse("multi-q2-checked");
  assert.equal(q.prompt,"Which toppings?");
  assert.equal(q.multiSelect,true);
  assert.deepEqual(q.options.map(o=>[o.label,o.checked]),[["Cheese",true],["Ham",false],["Olives",true]]);
  assert.equal(q.submit,"Submit");
  assert.deepEqual(q.tabs.map(t=>t.answered),[true,true]);   // a checked box marks the tab answered
  const typed=parse("multi-other-typed");
  assert.deepEqual(typed.other,{key:"4",text:"Pretzels",checked:true});
  assert.equal(typed.cursor,"other");
  assert.equal(parse("multi-next").submit,"Submit");   // the last question; earlier ones say "Next"
});

test("reads a single question without tabs",()=>{
  const q=parse("single");
  assert.deepEqual(q.tabs,[{label:"Pet",answered:false}]);
  assert.equal(q.submitTab,false);
  assert.equal(q.options.length,3);
  assert.ok(q.other);
});

test("splits option previews and notes off the options",()=>{
  const q=parse("preview");
  assert.deepEqual(q.options.map(o=>o.label),["Grid","List"]);
  assert.equal(q.other,undefined);
  assert.deepEqual(q.chat,{});
  assert.match(q.preview!,/^\+-/);
  assert.ok(!q.preview!.includes("│"));
  assert.deepEqual(q.notes,{text:"",editing:false});
  const focused=parse("preview-focus2");
  assert.equal(focused.cursor,"option:1");
  assert.match(focused.preview!,/item/);
  const narrow=parse("preview-narrow");
  assert.deepEqual(narrow.options.map(o=>o.label),["Grid","List"]);
  assert.deepEqual(parse("preview-notes-editing").notes,{text:"",editing:true});
  assert.deepEqual(parse("preview-notes-typed").notes,{text:"Tighter",editing:true});
  assert.equal(parse("preview-multi").tabs.length,2);
});

test("reads the review tab",()=>{
  const q=parse("review");
  assert.deepEqual(q.review?.answers,[{question:"Which color?",answer:"Blue"},{question:"Which toppings?",answer:"Cheese, Olives, \"Pineapple, extra crispy\""}]);
  assert.deepEqual(q.options.map(o=>o.label),["Submit answers","Cancel"]);
});

test("reads iTerm screens with a bordered question and NUL-turned-space cells",()=>{
  const text=screen("multi-q1").replace("Which color?","│ Which color?").replace(/ {2}/g,"\0\0").replace(/\0/g," ");
  assert.equal(claudeQuestion(text)?.prompt,"Which color?");
});

test("a question replaces the numbered prompt and arrow-key menu",()=>{
  const state=liveClaudeState(screen("multi-q2"));
  assert.ok(state.question);
  assert.equal(state.prompt,undefined);
  assert.equal(state.menu,false);
  assert.equal(state.working,false);
});

test("ignores ordinary screens",()=>{
  assert.equal(claudeQuestion("❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel"),undefined);
  assert.equal(claudeQuestion("$ ls\nfoo bar\n"),undefined);
});

// A terminal that replays screens: each key sequence moves to the next screen.
function terminal(screens:string[],typed:string[]):QuestionTerminal {
  let i=0;
  return {read:async()=>screens[Math.min(i,screens.length-1)],type:async t=>{typed.push(t);i++;}};
}

test("answers a plain single-select question with its number",async()=>{
  const typed:string[]=[];
  await answerQuestion(terminal([screen("multi-q1")],typed),"Which color?",{op:"select",index:1});
  assert.deepEqual(typed,["2"]);
});

test("toggles multiSelect options by number and submits from the Submit row",async()=>{
  const typed:string[]=[];
  await answerQuestion(terminal([screen("multi-q2")],typed),"Which toppings?",{op:"toggle",index:2});
  assert.deepEqual(typed,["3"]);
  const moved:string[]=[];
  const atSubmit=screen("multi-q2-checked").replace("❯ 1. [✔] Cheese","  1. [✔] Cheese").replace(/^(\s*)Submit$/m,"❯ Submit");
  await answerQuestion(terminal([screen("multi-q2-checked"),atSubmit],moved),"Which toppings?",{op:"next"});
  assert.deepEqual(moved,["\x1b[B".repeat(4),"\r"]);
});

test("moves to an option preview before selecting it with notes",async()=>{
  const typed:string[]=[];
  await answerQuestion(terminal([screen("preview"),screen("preview-focus2"),screen("preview-notes-editing")],typed),"Which layout?",{op:"select",index:1,notes:"Denser"});
  assert.deepEqual(typed,["\x1b[B","n","\x15\x1b[200~Denser\x1b[201~","\r"]);
});

test("refuses to answer a question that has changed",async()=>{
  await assert.rejects(answerQuestion(terminal([screen("multi-q1")],[]),"Which pet?",{op:"select",index:0}),/changed/);
});
