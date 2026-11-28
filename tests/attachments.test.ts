import test from "node:test";
import assert from "node:assert/strict";
import { kindOf, namedFile, splitAttachments } from "../web/attachments";

test("attachment lines become files, with the name you picked",()=>{
  const sent=splitAttachments("Why does this keep happening?\nAttached file: /Users/b/.afkterm/attachments/0e0b/2e624372-f1e8-4c20-a510-e01ee121c274-IMG_0243.png\nAttached file: /tmp/report.pdf");
  assert.equal(sent.text,"Why does this keep happening?");
  assert.deepEqual(sent.files.map(f=>f.name),["IMG_0243.png","report.pdf"]);
  assert.equal(sent.files[0].path,"/Users/b/.afkterm/attachments/0e0b/2e624372-f1e8-4c20-a510-e01ee121c274-IMG_0243.png");
  // A message still on its way, with only a file.
  assert.deepEqual(splitAttachments("📎 notes.md"),{text:"",files:[{name:"notes.md"}]});
  // Words that merely mention it stay words.
  assert.equal(splitAttachments("see Attached file: below").files.length,0);
});

test("file kinds come from the extension",()=>{
  assert.deepEqual(["a.PNG","b.pdf","c.tsx","d.csv","e.zip","f.mov","g","h.md"].map(kindOf),["image","pdf","code","sheet","archive","video","file","text"]);
});

test("pasted and dragged images get a name you can tell apart",()=>{
  const at=new Date(2026,10,27,14,3,9);
  assert.equal(namedFile(new File(["x"],"image.png",{type:"image/png"}),at).name,"Screenshot 2026-11-27 at 14.03.09.png");
  assert.equal(namedFile(new File(["x"],"",{type:"image/jpeg"}),at).name,"Screenshot 2026-11-27 at 14.03.09.jpg");
  const kept=new File(["x"],"IMG_0042.PNG",{type:"image/png"});
  assert.equal(namedFile(kept,at),kept);
});
