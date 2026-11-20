import test from "node:test";
import assert from "node:assert/strict";
import { dropTarget, moved, shiftFor } from "../web/tab-order";

const blocks=[{tab:1,top:0,height:60},{tab:2,top:60,height:120},{tab:3,top:180,height:60}];

test("a dragged tab lands where its middle is, counting multi-pane tabs as one",()=>{
  assert.equal(dropTarget(blocks,0,0),0);
  assert.equal(dropTarget(blocks,0,100),1);
  assert.equal(dropTarget(blocks,0,200),2);
  assert.equal(dropTarget(blocks,2,-80),2);
  assert.equal(dropTarget(blocks,2,-100),1);
  assert.equal(dropTarget(blocks,2,-200),0);
});

test("the tabs in between make room, and the order follows",()=>{
  assert.deepEqual([0,1,2].map(i=>shiftFor(i,0,2,60)),[0,-60,-60]);
  assert.deepEqual([0,1,2].map(i=>shiftFor(i,2,0,60)),[60,60,0]);
  assert.deepEqual(moved([1,2,3],0,2),[2,3,1]);
  assert.deepEqual(moved([1,2,3],2,0),[3,1,2]);
});
