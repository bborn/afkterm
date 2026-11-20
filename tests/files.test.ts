import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, type Backend } from "../server/index";
import { access, fileRules, FileTokens, resolveInput, secretName, statFiles, type FileRules } from "../server/files";
import { parseLogins } from "../server/auth";

const login="sam@example.com", KEY="device-secret";
const headers={"tailscale-user-login":login,"x-afkterm":KEY};

// A made-up home folder, with the places that must never be served.
async function fixture() {
  const home=await mkdtemp(join(tmpdir(),"afkterm-home-"));
  const outside=await mkdtemp(join(tmpdir(),"afkterm-outside-"));
  const files:Record<string,string>={
    "code/app/README.md":"# App\n","code/app/src/main.ts":"one\ntwo\nthree\n","code/app/page.html":"<script>alert(1)</script>",
    "code/app/Makefile":"all:\n\techo hi\n","code/app/.env":"SECRET=1","code/app/.env.local":"SECRET=2","code/app/server.pem":"x","code/app/tls.key":"x",
    "code/app/logo.svg":"<svg xmlns='http://www.w3.org/2000/svg'/>","code/app/blob.bin":"\0\0\0binary",
    ".ssh/id_ed25519":"key",".ssh/config":"Host x",".ssh/id_ed25519.pub":"pub","keys/id_rsa":"key","keys/id_rsa.pub":"pub",
    ".gnupg/pubring.kbx":"x","Library/Keychains/login.keychain-db":"x",".afkterm/config.json":"{\"key\":\"secret\"}",
  };
  for(const [p,body] of Object.entries(files)){await mkdir(join(home,p,".."),{recursive:true});await writeFile(join(home,p),body);}
  await writeFile(join(outside,"passwd"),"root");
  await symlink(join(outside,"passwd"),join(home,"code/app/escape.txt"));
  await symlink(join(home,".ssh/id_ed25519"),join(home,"code/app/innocent.txt"));
  await symlink(join(home,"code/app/Makefile"),join(home,"code/app/.env.example"));
  const rules=fileRules(home,[],[join(home,".afkterm")]);
  return {home,outside,rules,cleanup:async()=>{await rm(home,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}};
}
const allowed=async(path:string,rules:FileRules)=>access(path,rules).then(()=>true,()=>false);

test("secret file names are recognized; public keys are not secret",()=>{
  for(const n of [".env",".env.local",".ENV.production","server.pem","tls.key","id_rsa","id_ed25519"])assert.equal(secretName(n),true,n);
  for(const n of ["id_rsa.pub","environment.ts","keys.json","README.md","monkey"])assert.equal(secretName(n),false,n);
});

test("paths resolve from ~, absolute, or the session's folder",async()=>{
  const f=await fixture();
  try {
    assert.equal(resolveInput("~/code",f.home+"/x",f.rules),join(f.home,"code"));
    assert.equal(resolveInput("src/main.ts",join(f.home,"code/app"),f.rules),join(f.home,"code/app/src/main.ts"));
    assert.equal(resolveInput("../app/README.md",join(f.home,"code/app"),f.rules),join(f.home,"code/app/README.md"));
    assert.equal(resolveInput("/etc/hosts","",f.rules),"/etc/hosts");
    assert.equal(resolveInput("src/main.ts","",f.rules),null);
  } finally {await f.cleanup();}
});

test("only the home and temp folders are served, never secrets, even through symlinks",async()=>{
  const f=await fixture();
  try {
    const at=(p:string)=>join(f.home,p);
    for(const p of ["code/app/README.md","code/app/src","keys/id_rsa.pub"])assert.equal(await allowed(at(p),f.rules),true,p);
    for(const p of [".ssh/config",".ssh/id_ed25519.pub",".ssh",".gnupg/pubring.kbx","Library/Keychains/login.keychain-db",".afkterm/config.json",".afkterm",
      "code/app/.env","code/app/.env.local","code/app/server.pem","code/app/tls.key","keys/id_rsa","code/app/escape.txt","code/app/innocent.txt","code/app/.env.example"])
      assert.equal(await allowed(at(p),f.rules),false,p);
    assert.equal(await allowed(join(f.outside,"passwd"),f.rules),false);
    assert.equal(await allowed("/etc/hosts",f.rules),false);
    // The real defaults cover the temp folders through their /private names too.
    const defaults=fileRules(f.home);
    assert.equal(await allowed(join(f.outside,"passwd"),defaults),true);
    assert.ok(defaults.roots.includes("/private/tmp") && defaults.roots.includes("/tmp"));
    const stat=await statFiles(["src/main.ts","README.md","missing.ts",".env","~/.ssh/config","Makefile","logo.svg","blob.bin","src"],join(f.home,"code/app"),f.rules,new FileTokens());
    assert.deepEqual(Object.keys(stat).sort(),["Makefile","README.md","blob.bin","logo.svg","src","src/main.ts"]);
    assert.deepEqual([stat["src/main.ts"].type,stat["README.md"].type,stat.Makefile.type,stat["logo.svg"].type,stat["blob.bin"].type,stat.src.kind],["text","markdown","text","image","other","dir"]);
    assert.equal(stat.src.url,undefined);
  } finally {await f.cleanup();}
});

async function start(f:{rules:FileRules},cwd:(id:string)=>string|null) {
  const dir=await mkdtemp(join(tmpdir(),"afkterm-static-"));
  await writeFile(join(dir,"index.html"),"<h1>app</h1>");
  const backend:Backend={
    list:async()=>({running:true,truncated:false,sessions:[]}),
    preview:async()=>({text:"",truncated:false,claude:null}),
    inputOptions:async()=>({skills:[],truncated:false}),
    action:async()=>({sessionId:null}),sendClaude:async id=>({sessionId:id}),
    localCwd:async id=>cwd(id),
  };
  const {server}=createApp({backend,auth:{allowedLogins:parseLogins(login),allowLocal:false,key:KEY},staticDir:dir,files:f.rules,
    voice:{available:()=>false,transcribe:async()=>""},speaker:{available:()=>false,speak:async()=>Buffer.alloc(0)}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
}

test("file endpoints need the device secret; file links need a valid signature",async()=>{
  const f=await fixture();
  const app=await start(f,id=>id==="remote"?null:join(f.home,"code/app"));
  try {
    const post=(route:string,body:unknown,h:Record<string,string>=headers,id="local")=>fetch(`${app.base}/api/sessions/${id}/${route}`,{method:"POST",headers:{...h,"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await post("file-stat",{paths:["README.md"]},{"tailscale-user-login":login})).status,401);
    assert.equal((await post("file-stat",{paths:["README.md"]},{"tailscale-user-login":"mallory@example.com","x-afkterm":KEY})).status,403);
    assert.equal((await post("folder",{path:"."},{"tailscale-user-login":login,"x-afkterm":"wrong"})).status,401);
    const {files}=await (await post("file-stat",{paths:["src/main.ts","page.html","logo.svg",".env","nope"]})).json();
    assert.deepEqual(Object.keys(files).sort(),["logo.svg","page.html","src/main.ts"]);
    const url=`${app.base}${files["src/main.ts"].url}`;
    // The link works without the device header (for <img> and <video>), but still needs Tailscale.
    const res=await fetch(url,{headers:{"tailscale-user-login":login}});
    assert.equal(res.status,200);
    assert.equal(await res.text(),"one\ntwo\nthree\n");
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url.replace(/sig=[^&]+/,"sig=forged"),{headers:{"tailscale-user-login":login}})).status,403);
    // A signature covers one path only.
    assert.equal((await fetch(url.replace(encodeURIComponent("src/main.ts"),encodeURIComponent(".env")),{headers:{"tailscale-user-login":login}})).status,403);
    const part=await fetch(url,{headers:{"tailscale-user-login":login,range:"bytes=4-6"}});
    assert.equal(part.status,206);
    assert.equal(part.headers.get("content-range"),"bytes 4-6/14");
    assert.equal(await part.text(),"two");
    assert.equal((await fetch(url,{headers:{"tailscale-user-login":login,range:"bytes=99-"}})).status,416);
    // HTML and SVG can't run script on afkterm's origin.
    const html=await fetch(`${app.base}${files["page.html"].url}`,{headers:{"tailscale-user-login":login}});
    assert.equal(html.headers.get("content-type"),"text/plain; charset=utf-8");
    const svg=await fetch(`${app.base}${files["logo.svg"].url}`,{headers:{"tailscale-user-login":login}});
    assert.equal(svg.headers.get("content-type"),"image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") || "",/^sandbox/);
    const folder=await (await post("folder",{path:"."})).json();
    assert.deepEqual(folder.entries.map((e:{name:string})=>e.name),["src","blob.bin","logo.svg","Makefile","page.html","README.md"]);
    assert.equal(folder.parent.path,join(f.home,"code"));
    assert.equal((await post("folder",{path:"~/.ssh"})).status,403);
    assert.equal((await post("folder",{path:"README.md"})).status,400);
    // A pane on another Herdr machine: its paths aren't on this Mac.
    assert.deepEqual(await (await post("file-stat",{paths:["README.md",join(f.home,"code/app/README.md")]},headers,"remote")).json(),{files:{}});
    assert.equal((await post("folder",{path:"~"},headers,"remote")).status,404);
  } finally {await app.close();await f.cleanup();}
});

test("HEIC photos are served as JPEG, converted on the Mac",{skip:!existsSync("/usr/bin/sips") && "needs macOS sips"},async()=>{
  const f=await fixture();
  const app=await start(f,()=>f.home);
  try {
    // A 1x1 PNG, turned into HEIC with the same tool afkterm uses.
    await writeFile(join(f.home,"dot.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==","base64"));
    execFileSync("/usr/bin/sips",["-s","format","heic",join(f.home,"dot.png"),"--out",join(f.home,"dot.heic")],{stdio:"ignore"});
    const {files}=await (await fetch(`${app.base}/api/sessions/local/file-stat`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({paths:["dot.heic"]})})).json();
    assert.equal(files["dot.heic"].type,"image");
    const res=await fetch(`${app.base}${files["dot.heic"].url}`,{headers:{"tailscale-user-login":login}});
    assert.equal(res.headers.get("content-type"),"image/jpeg");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).subarray(0,2)],[0xff,0xd8]);
  } finally {await app.close();await f.cleanup();}
});
