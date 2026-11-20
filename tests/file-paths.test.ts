import test from "node:test";
import assert from "node:assert/strict";
import { pathsIn, splitPaths, wholePath } from "../web/file-paths";

const refs=(text:string)=>splitPaths(text).filter(p=>typeof p!=="string");

test("finds absolute, home, relative and bare file paths with line numbers",()=>{
  assert.deepEqual(refs("Saved to /tmp/out/chart.png and ~/notes/todo.md, see src/app.ts:42 or ./run.sh:3:7."),[
    {raw:"/tmp/out/chart.png",path:"/tmp/out/chart.png",line:undefined},
    {raw:"~/notes/todo.md",path:"~/notes/todo.md",line:undefined},
    {raw:"src/app.ts:42",path:"src/app.ts",line:42},
    {raw:"./run.sh:3:7",path:"./run.sh",line:3},
  ]);
  assert.deepEqual(refs("Open README.md. Then ../web/ and .github/workflows/ci.yml").map(r=>r.path),["README.md","../web/",".github/workflows/ci.yml"]);
});

test("leaves URLs, numbers and plain words alone",()=>{
  assert.deepEqual(refs("See https://github.com/a/b.md, version 1.2.3, 10:30, it costs 3.5x and hello"),[]);
  assert.equal(splitPaths("a src/x.ts b").map(p=>typeof p==="string"?p:`[${p.raw}]`).join(""),"a [src/x.ts] b");
});

test("inline code is a link only when it's a whole path; fenced code is skipped",()=>{
  assert.deepEqual(wholePath(" web/chat.tsx:10 "),{raw:"web/chat.tsx:10",path:"web/chat.tsx",line:10});
  assert.equal(wholePath("npm run build"),null);
  assert.deepEqual(pathsIn("Edit `server/files.ts`\n\n```\ncat secret/thing.txt\n```\nand logo.png"),["server/files.ts","logo.png"]);
});
