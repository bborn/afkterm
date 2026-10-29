import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type Backend } from "../server/index";
import { authorize, Pairing, parseLogins, sameOriginSocket } from "../server/auth";
import { LiveSessions } from "../server/live";
import type { Action, Preview } from "../server/contract";
import type { Transcriber } from "../server/voice";

const login="sam@example.com";
const KEY="device-secret";
const auth={allowedLogins:parseLogins(`${login}, other@example.com`),allowLocal:false};

test("only allowed Tailscale logins are authorized; local requests need opt-in",()=>{
  assert.deepEqual(authorize({"tailscale-user-login":"Sam@Example.com"},auth),{ok:true,login:"Sam@Example.com"});
  assert.equal(authorize({"tailscale-user-login":"mallory@example.com"},auth).ok,false);
  assert.equal(authorize({},auth).ok,false);
  assert.equal(authorize({},{...auth,allowLocal:true}).ok,true);
});
test("requests through Tailscale Funnel are always refused",()=>{
  assert.equal(authorize({"tailscale-funnel-request":"?1"},{...auth,allowLocal:true}).ok,false);
  assert.equal(authorize({"tailscale-funnel-request":"?1","tailscale-user-login":login},auth).ok,false);
});
test("unexpected Host headers (DNS rebinding) are refused",()=>{
  const strict={...auth,hosts:new Set(["mac.tailnet.ts.net:9443","127.0.0.1:47823"])};
  assert.equal(authorize({host:"mac.tailnet.ts.net:9443","tailscale-user-login":login},strict).ok,true);
  assert.equal(authorize({host:"attacker.example:47823","tailscale-user-login":login},strict).ok,false);
});
test("sockets must come from the app's own origin",()=>{
  assert.equal(sameOriginSocket({origin:"https://mac.ts.net:9443",host:"mac.ts.net:9443"},auth),true);
  assert.equal(sameOriginSocket({origin:"https://mac.ts.net:9443",host:"127.0.0.1:47823"},{...auth,hosts:new Set(["mac.ts.net:9443"])}),true);
  assert.equal(sameOriginSocket({origin:"https://evil.example",host:"evil.example"},{...auth,hosts:new Set(["mac.ts.net:9443"])}),false);
  assert.equal(sameOriginSocket({origin:"https://evil.example",host:"mac.ts.net:9443"},auth),false);
  assert.equal(sameOriginSocket({host:"mac.ts.net:9443"},auth),false);
});
test("pairing codes are single use, expire, and lock after too many guesses",()=>{
  const p=new Pairing(1000,3);
  const code=p.create();
  assert.equal(p.redeem("000000"===code?"111111":"000000"),false);
  assert.equal(p.redeem(code),true);
  assert.equal(p.redeem(code),false);
  const c2=p.create();
  for(let i=0;i<3;i++)p.redeem(c2==="999999"?"000000":"999999");
  assert.equal(p.redeem(c2),false);
  const expired=new Pairing(-1);const c3=expired.create();
  assert.equal(expired.redeem(c3),false);
});

function fakeBackend() {
  const actions:Action[]=[];let reads=0;
  const backend:Backend={
    list:async()=>({running:true,truncated:false,sessions:[]}),
    preview:async()=>{reads++;return {text:`screen ${actions.length}`,truncated:false,claude:null};},
    inputOptions:async()=>({skills:[],truncated:false}),
    action:async a=>{actions.push(a);return {sessionId:"sessionId" in a?a.sessionId:null};},
    sendClaude:async id=>({sessionId:id}),
  };
  return {backend,actions,reads:()=>reads};
}
async function start(backend:Backend,voice?:Transcriber) {
  const dir=await mkdtemp(join(tmpdir(),"iterm-web-static-"));
  await writeFile(join(dir,"index.html"),"<h1>app</h1>");
  const {server}=createApp({backend,auth:{...auth,key:KEY},staticDir:dir,voice:voice ?? {available:()=>false,transcribe:async()=>""}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
}
const headers={"tailscale-user-login":login,"x-iterm-web":KEY};

test("API requires identity and the device secret; actions are validated and scoped to the URL's session",async()=>{
  const f=fakeBackend();const app=await start(f.backend);
  try {
    assert.equal((await fetch(`${app.base}/api/sessions`)).status,401);
    const unpaired=await fetch(`${app.base}/api/sessions`,{headers:{"tailscale-user-login":login,"x-iterm-web":"1"}});
    assert.equal(unpaired.status,401);
    assert.equal((await unpaired.json()).pairing,true);
    assert.equal((await fetch(`${app.base}/api/sessions`,{headers:{...headers,"tailscale-user-login":"mallory@example.com"}})).status,403);
    const ok=await fetch(`${app.base}/api/sessions`,{headers});
    assert.equal(ok.status,200);
    assert.equal(ok.headers.get("x-frame-options"),"DENY");
    assert.match(ok.headers.get("content-security-policy") || "",/frame-ancestors 'none'.*|img-src 'self' data: blob:/);
    const post=(body:unknown)=>fetch(`${app.base}/api/sessions/abc/action`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await post({kind:"key",key:"shift-tab",sessionId:"other"})).status,200);
    assert.deepEqual(f.actions,[{kind:"key",key:"shift-tab",sessionId:"abc"}]);
    assert.equal((await post({kind:"close"})).status,400);
    assert.equal((await post({kind:"key",key:"rm -rf"})).status,400);
    assert.equal((await post({kind:"new-window"})).status,400);
    assert.equal(f.actions.length,1);
    const page=await fetch(`${app.base}/s/abc`,{headers:{"tailscale-user-login":login}});
    assert.equal(await page.text(),"<h1>app</h1>");
    assert.equal((await fetch(`${app.base}/s/abc`)).status,401);
  } finally {await app.close();}
});

test("voice recordings are transcribed on the Mac, and only for paired devices",async()=>{
  const heard:Buffer[]=[];
  const app=await start(fakeBackend().backend,{available:()=>true,transcribe:async audio=>{heard.push(audio);return "fix the tests";}});
  try {
    const post=(h:Record<string,string>)=>fetch(`${app.base}/api/transcribe`,{method:"POST",headers:h,body:new Uint8Array([1,2,3])});
    assert.equal((await post({"tailscale-user-login":login,"x-iterm-web":"wrong"})).status,401);
    assert.equal(heard.length,0);
    const res=await post(headers);
    assert.deepEqual(await res.json(),{text:"fix the tests"});
    assert.deepEqual([...heard[0]],[1,2,3]);
    assert.equal((await (await fetch(`${app.base}/api/me`,{headers})).json()).voice,true);
  } finally {await app.close();}
  const off=await start(fakeBackend().backend);
  try {
    assert.equal((await fetch(`${off.base}/api/transcribe`,{method:"POST",headers,body:"x"})).status,501);
    assert.equal((await (await fetch(`${off.base}/api/me`,{headers})).json()).voice,false);
  } finally {await off.close();}
});

test("a pairing code from the Mac gets a new device the secret, once",async()=>{
  const f=fakeBackend();const app=await start(f.backend);
  try {
    const {code}=await (await fetch(`${app.base}/api/pair-code`,{method:"POST",headers})).json();
    assert.match(code,/^\d{6}$/);
    const redeem=(c:string,h:Record<string,string>={"x-iterm-web":"pair"})=>fetch(`${app.base}/api/pair`,{method:"POST",headers:{"tailscale-user-login":login,"content-type":"application/json",...h},body:JSON.stringify({code:c})});
    assert.equal((await redeem(code,{})).status,403);                     // cross-site: no custom header
    const res=await redeem(code);
    assert.equal(res.status,200);
    assert.equal((await res.json()).key,KEY);
    assert.equal((await redeem(code)).status,403);                        // single use
    assert.equal((await fetch(`${app.base}/api/pair-code`,{method:"POST",headers:{"tailscale-user-login":login,"x-iterm-web":"pair"}})).status,401);
  } finally {await app.close();}
});

test("live socket needs the secret, pushes the screen and refreshes promptly after input",async()=>{
  const f=fakeBackend();const app=await start(f.backend);
  try {
    const url=`${app.base.replace("http","ws")}/api/live?session=abc&key=${KEY}`;
    for(const [u,origin] of [[url,"https://evil.example"],[url.replace(KEY,"wrong"),app.base]]){
      const rejected=new WebSocket(u,{headers:{"tailscale-user-login":login,origin}});
      await new Promise<void>(resolve=>{rejected.on("error",()=>resolve());rejected.on("unexpected-response",()=>resolve());});
    }
    const ws=new WebSocket(url,{headers:{"tailscale-user-login":login,origin:app.base}});
    const messages:{type:string;preview?:Preview}[]=[];
    ws.on("message",data=>messages.push(JSON.parse(String(data))));
    await new Promise(r=>ws.on("open",r));
    const until=async(check:()=>boolean)=>{for(let i=0;i<100 && !check();i++)await new Promise(r=>setTimeout(r,20));assert.ok(check());};
    await until(()=>messages.length===1);
    assert.equal(messages[0].preview?.text,"screen 0");
    await fetch(`${app.base}/api/sessions/abc/action`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({kind:"key",key:"enter"})});
    await until(()=>messages.length===2);
    assert.equal(messages[1].preview?.text,"screen 1");
    ws.close();
  } finally {await app.close();}
});

test("live sessions share one loop per session, skip unchanged screens, and stop when nobody watches",async()=>{
  let reads=0;let text="a";
  const live=new LiveSessions(async()=>{reads++;return {text,truncated:false,claude:null};},{active:10,idle:10});
  const a:string[]=[],b:string[]=[];
  const offA=live.subscribe("s",{send:m=>a.push(m)});
  await new Promise(r=>setTimeout(r,60));
  const offB=live.subscribe("s",{send:m=>b.push(m)});
  assert.equal(a.length,1);assert.equal(b.length,1);
  text="b";
  await new Promise(r=>setTimeout(r,60));
  assert.equal(a.length,2);assert.equal(b.length,2);
  offA();offB();
  assert.equal(live.size,0);
  const before=reads;
  await new Promise(r=>setTimeout(r,60));
  assert.ok(reads-before<=1);
});

test("a write to the watched transcript triggers an immediate read",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"iterm-web-watch-"));
  const path=join(dir,"t.jsonl");await writeFile(path,"a\n");
  let text="a";
  const live=new LiveSessions(async()=>({text,truncated:false,claude:null}),{active:60000,idle:60000,watchPath:()=>path});
  const got:string[]=[];
  const off=live.subscribe("s",{send:m=>got.push(JSON.parse(m).preview.text)});
  try {
    for(let i=0;i<50 && !got.length;i++)await new Promise(r=>setTimeout(r,10));
    text="b";await writeFile(path,"a\nb\n");
    for(let i=0;i<100 && got.length<2;i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(got,["a","b"]);
  } finally {off();await rm(dir,{recursive:true,force:true});}
});
