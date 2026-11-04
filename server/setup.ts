import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runAutomation } from "./bridge";
import { ItermApi } from "./iterm-api";
import { Hc } from "./hc";
import { LOG_FILE, type Config } from "./config";

const run=promisify(execFile);
export const LABEL="dev.iterm-web";
export const PLIST=join(homedir(),"Library","LaunchAgents",`${LABEL}.plist`);
const domain=()=>`gui/${userInfo().uid}`;

export type Check={name:string;ok:boolean;fatal?:boolean;detail:string};

// ---- Tailscale ----

export async function tailscaleBinary():Promise<string|null> {
  for(const candidate of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale","/opt/homebrew/bin/tailscale","/usr/local/bin/tailscale"])
    if(existsSync(candidate))return candidate;
  try {return (await run("/usr/bin/which",["tailscale"])).stdout.trim() || null;} catch {return null;}
}

export interface TailscaleState { running:boolean; dnsName:string; login:string; tagged:boolean }
export async function tailscaleState(bin:string):Promise<TailscaleState> {
  const status=JSON.parse((await run(bin,["status","--json"],{timeout:10000,maxBuffer:16*1024*1024})).stdout);
  const self=status.Self || {};
  return {
    running:status.BackendState==="Running",
    dnsName:String(self.DNSName || "").replace(/\.$/,""),
    login:String(status.User?.[String(self.UserID)]?.LoginName || ""),
    tagged:Array.isArray(self.Tags) && self.Tags.length>0,
  };
}

export interface ServeState { target?:string; funnel:boolean }
// What Tailscale Serve does with https://<dnsName>:<port>, if anything.
export async function serveState(bin:string,dnsName:string,httpsPort:number):Promise<ServeState> {
  let status:any={};
  try {status=JSON.parse((await run(bin,["serve","status","--json"],{timeout:10000})).stdout || "{}");} catch { /* Nothing served. */ }
  const key=`${dnsName}:${httpsPort}`;
  const target=status.Web?.[key]?.Handlers?.["/"]?.Proxy;
  return {target:typeof target==="string"?target:undefined,funnel:!!status.AllowFunnel?.[key]};
}

export async function enableServe(bin:string,httpsPort:number,port:number) {
  await run(bin,["serve","--bg",`--https=${httpsPort}`,`http://127.0.0.1:${port}`],{timeout:20000});
}
export async function disableServe(bin:string,httpsPort:number) {
  await run(bin,["serve",`--https=${httpsPort}`,"off"],{timeout:20000}).catch(()=>{});
}

// ---- Checks ----

export async function checks(config:Config):Promise<{checks:Check[];tailscale?:TailscaleState;bin?:string}> {
  const out:Check[]=[];
  const add=(c:Check)=>{out.push(c);return c;};
  const [major,minor]=process.versions.node.split(".").map(Number);
  add({name:"Node.js",ok:major>20 || (major===20 && minor>=12),fatal:true,detail:`v${process.versions.node}${major<20?" (needs 20.12 or newer)":""}`});
  if(process.platform!=="darwin"){
    add({name:"macOS",ok:false,fatal:true,detail:"iterm-web runs only on macOS."});
    return {checks:out};
  }
  if(config.backend==="herdr")await herdrChecks(add);
  else await itermChecks(add);
  return tailscaleChecks(config,out,add);
}

async function herdrChecks(add:(c:Check)=>Check) {
  const {herdrApp}=await import("./herdr");
  const app=await herdrApp();
  add({name:"Herdr",ok:!!app,fatal:true,detail:app?"installed":"Install Herdr from https://herdr.dev"});
  const hc=new Hc();
  try {
    const {terminals}=await hc.call<{terminals:unknown[]}>("terminal.list",{},8000);
    add({name:"herdr-core",ok:true,detail:`running (${terminals.length} terminals)`});
  } catch(error) {
    add({name:"herdr-core",ok:false,detail:`${error instanceof Error?error.message:String(error)} iterm-web will show your terminals once it is running.`});
  } finally {hc.close();}
}

async function itermChecks(add:(c:Check)=>Check) {
  const iterm=["/Applications/iTerm.app",join(homedir(),"Applications/iTerm.app")].some(existsSync);
  add({name:"iTerm2",ok:iterm,fatal:true,detail:iterm?"installed":"Install iTerm2 from https://iterm2.com"});
  if(iterm){
    try {
      const list=await runAutomation({method:"list"},AbortSignal.timeout(20000)) as {running:boolean;sessions:unknown[]};
      add({name:"Automation permission",ok:true,detail:list.running?`can control iTerm2 (${list.sessions.length} sessions)`:"granted (iTerm2 is not running right now)"});
    } catch(error) {
      add({name:"Automation permission",ok:false,fatal:true,detail:error instanceof Error?error.message:String(error)});
    }
    const api=new ItermApi();
    try {
      await Promise.race([api.listSessions(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("timed out")),8000))]);
      add({name:"iTerm2 Python API",ok:true,detail:"enabled (fast updates)"});
    } catch {
      add({name:"iTerm2 Python API",ok:false,detail:"off. iterm-web still works, but slower. Turn it on in iTerm2 → Settings → General → Magic → Enable Python API."});
    } finally {api.close();}
  }
}

async function tailscaleChecks(config:Config,out:Check[],add:(c:Check)=>Check):Promise<{checks:Check[];tailscale?:TailscaleState;bin?:string}> {
  const bin=await tailscaleBinary();
  if(!bin){add({name:"Tailscale",ok:false,fatal:true,detail:"Install Tailscale from https://tailscale.com/download/mac and sign in."});return {checks:out};}
  let tailscale:TailscaleState|undefined;
  try {tailscale=await tailscaleState(bin);} catch(error) {add({name:"Tailscale",ok:false,fatal:true,detail:`Could not read status: ${error instanceof Error?error.message:error}`});return {checks:out,bin};}
  add({name:"Tailscale",ok:tailscale.running && !!tailscale.dnsName,fatal:true,detail:tailscale.running?`${tailscale.dnsName} (${tailscale.login || "no login"})`:"not connected. Open Tailscale and sign in."});
  if(tailscale.tagged)add({name:"Tailscale identity",ok:false,fatal:true,detail:"This Mac is a tagged device, so Tailscale can't tell iterm-web who is connecting. Use an untagged (user-owned) device."});
  if(tailscale.running && tailscale.dnsName){
    const serve=await serveState(bin,tailscale.dnsName,config.httpsPort);
    const ours=serve.target===`http://127.0.0.1:${config.port}`;
    if(serve.target && !ours)add({name:`Port ${config.httpsPort}`,ok:false,fatal:true,detail:`already serves ${serve.target}. Pick another with --https-port.`});
    if(serve.funnel)add({name:"Funnel",ok:false,fatal:true,detail:`Funnel is on for port ${config.httpsPort}, which would publish your terminals to the internet. Run: tailscale funnel --https=${config.httpsPort} off`});
  }
  return {checks:out,tailscale,bin};
}

// ---- Login agent ----

const xml=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
export function writeAgent(cliPath:string) {
  mkdirSync(dirname(PLIST),{recursive:true});
  mkdirSync(dirname(LOG_FILE),{recursive:true});
  const args=[process.execPath,cliPath,"start"].map(a=>`<string>${xml(a)}</string>`).join("");
  writeFileSync(PLIST,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`);
}
export async function loadAgent() {
  await run("/bin/launchctl",["bootout",`${domain()}/${LABEL}`]).catch(()=>{});
  await run("/bin/launchctl",["bootstrap",domain(),PLIST]);
}
export async function restartAgent() {
  await run("/bin/launchctl",["kickstart","-k",`${domain()}/${LABEL}`]);
}
export async function removeAgent() {
  await run("/bin/launchctl",["bootout",`${domain()}/${LABEL}`]).catch(()=>{});
  rmSync(PLIST,{force:true});
}
export async function agentState():Promise<string> {
  try {
    const {stdout}=await run("/bin/launchctl",["print",`${domain()}/${LABEL}`]);
    return /state = (\w+)/.exec(stdout)?.[1] || "unknown";
  } catch {return "not installed";}
}

// Talk to the running server the way Tailscale Serve and a paired phone would.
export async function local(config:Config,path:string,init:RequestInit={}) {
  const res=await fetch(`http://127.0.0.1:${config.port}${path}`,{...init,headers:{"x-iterm-web":config.key || "","tailscale-user-login":config.allowedLogins[0] || "",...init.headers},signal:AbortSignal.timeout(30000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export async function health(config:Config):Promise<{ok:boolean;detail:string}> {
  try {await local(config,"/api/me");return {ok:true,detail:"responding"};}
  catch(error) {return {ok:false,detail:error instanceof Error?error.message:String(error)};}
}
