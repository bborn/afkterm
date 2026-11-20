import test from "node:test";
import assert from "node:assert/strict";
import { CANCEL_PX, HOLD_MS, pressEnd, slideCancels } from "../web/push-to-talk";

const press={at:1000,x:300,y:600};

test("a quick press is a tap, a long one sends",()=>{
  assert.equal(pressEnd(press,press.at+50,300,600),"tap");
  assert.equal(pressEnd(press,press.at+HOLD_MS-1,300,600),"tap");
  assert.equal(pressEnd(press,press.at+HOLD_MS,300,600),"send");
  assert.equal(pressEnd(press,press.at+8000,300,600),"send");
});

test("sliding left or up far enough cancels, even on a quick flick",()=>{
  assert.equal(pressEnd(press,press.at+2000,300-CANCEL_PX,600),"cancel");
  assert.equal(pressEnd(press,press.at+2000,300,600-CANCEL_PX),"cancel");
  assert.equal(pressEnd(press,press.at+100,300-CANCEL_PX-20,600),"cancel");
});

test("thumb drift while talking doesn't cancel",()=>{
  assert.equal(pressEnd(press,press.at+2000,300-CANCEL_PX+1,600-CANCEL_PX+1),"send");
  // Right and down are away from nothing: the button sits at the bottom right.
  assert.equal(pressEnd(press,press.at+2000,300+200,600+200),"send");
  assert.equal(slideCancels(press,300-30,600-30),false);
});

test("sliding back before letting go undoes the cancel",()=>{
  assert.equal(slideCancels(press,300-CANCEL_PX,600),true);
  assert.equal(pressEnd(press,press.at+2000,300-10,600),"send");
});
