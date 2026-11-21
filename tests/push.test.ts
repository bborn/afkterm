import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSchema, type Session } from "../server/contract";
import { Push } from "../server/push";

const agent=(id:string,attention:Session["attention"],turn=1,ask="")=>sessionSchema.parse({
  id,name:id,tabName:`🛠️ ${id}`,windowId:1,windowName:"",tabIndex:1,paneIndex:1,tty:"",profile:"",cwd:"/",
  processing:false,atPrompt:true,selected:false,claude:true,attention,ask,turn,
});
const sub=(n:number)=>({endpoint:`https://web.push.apple.com/${n}`,keys:{p256dh:"k",auth:"a"}});

function setup() {
  const file=join(mkdtempSync(join(tmpdir(),"afkterm-push-")),"push.json");
  const sent:{endpoint:string;body:{title:string;body:string;badge:number;url:string}}[]=[];
  let fail:number|null=null;
  const push=new Push(file,async(s,payload)=>{
    if(fail!==null)throw Object.assign(new Error("gone"),{statusCode:fail});
    sent.push({endpoint:s.endpoint,body:JSON.parse(payload)});
  });
  return {file,push,sent,failWith:(status:number|null)=>{fail=status;}};
}

test("tells a phone when an agent starts needing you or finishes a new turn, once",async()=>{
  const {push,sent}=setup();
  push.on(sub(1),true);
  await push.check([agent("Sales",null),agent("Eng","blocked")]);
  assert.equal(sent.length,0,"the first look after a restart is quiet");
  await push.check([agent("Sales","done",2),agent("Eng","blocked",1,"answer: Ship it?")]);
  assert.deepEqual(sent.map(s=>[s.body.title,s.body.body,s.body.badge]),[["🛠️ Sales","Done",2]]);
  await push.check([agent("Sales","done",2),agent("Eng",null)]);
  await push.check([agent("Sales","done",3),agent("Eng","blocked",1,"answer: Ship it?")]);
  assert.deepEqual(sent.slice(1).map(s=>s.body.body),["Done","answer: Ship it?"]);
  assert.equal(sent[2].body.url,"/s/Eng");
});

test("phones that only want blocked agents, or have afkterm open, aren't told",async()=>{
  const {push,sent}=setup();
  const quiet=push.on(sub(1),false);
  const open=push.on(sub(2),true);
  await push.check([agent("A",null),agent("B",null)]);
  push.touch(open,1000);
  await push.check([agent("A","done",2),agent("B","blocked")],5000);
  assert.deepEqual(sent.map(s=>[s.endpoint,s.body.title]),[[sub(1).endpoint,"🛠️ B"]]);
  assert.ok(push.has(quiet));
});

test("a phone that removed the app is forgotten, and the key stays private",async()=>{
  const {file,push,failWith}=setup();
  const id=push.on(sub(1),true);
  assert.equal(push.on(sub(1),false),id,"turning it on again keeps one entry");
  await push.check([agent("A",null)]);
  failWith(410);
  await push.check([agent("A","blocked")]);
  assert.equal(push.phones,0);
  assert.equal(statSync(file).mode & 0o777,0o600);
  const again=new Push(file,async()=>{});
  assert.equal(again.publicKey,JSON.parse(readFileSync(file,"utf8")).vapid.publicKey);
});
