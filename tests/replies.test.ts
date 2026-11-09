import test from "node:test";
import assert from "node:assert/strict";
import { askingMessage, parseReplies, quickReplies, ruleReplies } from "../server/replies";
import type { ChatMessage } from "../server/contract";

const said=(id:string,text:string,role:ChatMessage["role"]="assistant"):ChatMessage=>({id,role,text});

test("only offers replies when Claude's last message asks something",()=>{
  assert.equal(askingMessage([said("1","Done. Tests pass.")]),null);
  assert.equal(askingMessage([said("1","Should I push?"),said("2","yes","user")]),null);
  assert.equal(askingMessage([said("1","Fixed it.\n\nWant me to **open a PR**?"),{id:"t",role:"tool",text:"{}",name:"Bash"}])?.id,"1");
  assert.equal(askingMessage([said("1","Why does this fail?\n\nI looked into it and fixed the cause.")]),null);
});

test("rules: yes/no questions and A-or-B choices",()=>{
  assert.deepEqual(ruleReplies("All green. Should I commit and push?"),["Yes","No","Not sure"]);
  assert.deepEqual(ruleReplies("For the Black Friday offer, should I create the coupon now?"),["Yes","No","Not sure"]);
  assert.deepEqual(ruleReplies("Should I squash the commits or keep them separate?"),["Squash the commits","Keep them separate","Not sure"]);
  assert.deepEqual(ruleReplies("Which file holds the config?"),[]);
});

test("reads the model's JSON list and drops anything unusable",()=>{
  assert.deepEqual(parseReplies('Sure:\n["Yes, push it", "Wait", 3, "", "Yes, push it", "'+"x".repeat(80)+'"]'),["Yes, push it","Wait"]);
  assert.deepEqual(parseReplies("no json here"),[]);
});

test("rules first, then the model's replies once they arrive, asked once per message",async()=>{
  const messages=[said("q1","Should I deploy?")];let asked=0;
  const ask=async()=>{asked++;return ["Deploy it","Not yet"];};
  assert.deepEqual(quickReplies(messages,ask),["Yes","No","Not sure"]);
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(quickReplies(messages,ask),["Deploy it","Not yet"]);
  assert.equal(asked,1);
  // A model that fails leaves the rule replies in place.
  const other=[said("q2","Should I retry?")];
  quickReplies(other,async()=>{throw Error("no claude");});
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(quickReplies(other,async()=>[]),["Yes","No","Not sure"]);
});
