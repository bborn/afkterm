import test from "node:test";
import assert from "node:assert/strict";
import { attention } from "../server/herdr";

const t=(state:string|null,turn:number,seen?:string)=>({status:state?{state}:null,labels:seen===undefined?{}:{"herdr.seen":seen},turn});

test("Herdr's shared rule: blocked needs you, done until someone looks at that turn",()=>{
  assert.equal(attention(t("blocked",3,"3")),"blocked");
  assert.equal(attention(t("error",0)),"blocked");
  assert.equal(attention(t("working",5,"2")),null);
  assert.equal(attention(t("done",6,"5")),"done");
  assert.equal(attention(t("idle",6,"5")),"done");
  assert.equal(attention(t("done",6,"6")),null);
  // Without the label no client has said what it saw.
  assert.equal(attention(t("done",6)),null);
  assert.equal(attention(t(null,6,"1")),null);
});
