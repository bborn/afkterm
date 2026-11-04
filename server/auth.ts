import type { IncomingHttpHeaders } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface AuthConfig {
  allowedLogins:Set<string>;
  allowLocal:boolean;          // demo mode only: accept requests without a Tailscale login
  key?:string;                 // device secret every API call must carry (unset in demo mode)
  hosts?:Set<string>;          // accepted Host headers (unset in demo mode)
}
export type AuthResult = { ok:true; login:string } | { ok:false; status:number; reason:string };

const header=(headers:IncomingHttpHeaders,name:string)=>{const v=headers[name];return Array.isArray(v)?v[0]:v;};

// Tailscale Serve adds Tailscale-User-Login to every request it proxies from the
// tailnet. The server listens on loopback only, so requests either come through
// Serve (and carry the identity) or from something running on this Mac.
export function authorize(headers:IncomingHttpHeaders,config:AuthConfig):AuthResult {
  // Funnel publishes a Serve port to the whole internet. Never answer those requests.
  if(header(headers,"tailscale-funnel-request"))return {ok:false,status:403,reason:"afkterm does not accept requests through Tailscale Funnel. Turn Funnel off for this port."};
  // A web page on this Mac can point its own domain at 127.0.0.1 (DNS rebinding);
  // its requests then carry that domain as Host.
  if(config.hosts && !config.hosts.has((header(headers,"host") || "").toLowerCase()))return {ok:false,status:421,reason:"Unexpected host."};
  const login=header(headers,"tailscale-user-login");
  if(login){
    if(config.allowedLogins.has(login.toLowerCase()))return {ok:true,login};
    return {ok:false,status:403,reason:`${login} is not allowed to use this Mac's terminals.`};
  }
  if(config.allowLocal)return {ok:true,login:"local"};
  return {ok:false,status:401,reason:"Open afkterm through its Tailscale URL."};
}

// Every API call carries the device secret in a custom header. That also stops
// cross-site requests: a page on another site can't add custom headers without a
// CORS preflight, which afkterm never answers.
export const API_HEADER="x-afkterm";
const LEGACY_HEADER="x-iterm-web";  // sent by pages loaded before the rename
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export function hasKey(value:string|null|undefined,config:AuthConfig) {
  if(!config.key)return true;
  return !!value && same(value,config.key);
}
export function apiKey(headers:IncomingHttpHeaders) { return header(headers,API_HEADER) ?? header(headers,LEGACY_HEADER); }

// Live connections must also come from afkterm's own page.
export function sameOriginSocket(headers:IncomingHttpHeaders,config:AuthConfig) {
  const origin=header(headers,"origin");
  if(!origin)return false;
  let host:string;
  try {host=new URL(origin).host.toLowerCase();} catch {return false;}
  if(config.hosts)return config.hosts.has(host);
  return host===(header(headers,"host") || "").toLowerCase();
}

export function parseLogins(value:string|undefined) {
  return new Set((value || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
}

export const newKey=()=>randomBytes(24).toString("base64url");

// Short-lived codes that a new device exchanges for the device secret.
export class Pairing {
  private code?:{value:string;expires:number;attempts:number};
  constructor(private ttl=10*60*1000,private maxAttempts=5) {}
  create() {
    this.code={value:String(randomInt(0,1_000_000)).padStart(6,"0"),expires:Date.now()+this.ttl,attempts:0};
    return this.code.value;
  }
  redeem(value:string):boolean {
    const code=this.code;
    if(!code || Date.now()>code.expires)return false;
    if(++code.attempts>this.maxAttempts){this.code=undefined;return false;}
    if(!same(value.replace(/\D/g,""),code.value))return false;
    this.code=undefined;
    return true;
  }
}
