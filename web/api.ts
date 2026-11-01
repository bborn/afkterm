import { useEffect, useRef, useState } from "react";
import type { Action, ClaudeSend, InputOptions, LiveMessage, Preview, SessionList, Upload } from "../server/contract";

export type { Action, ChatMessage, ClaudeView, InputSkill, Preview, Prompt, Question, QuestionAnswer, Session, SessionList, Upload } from "../server/contract";

// The device secret this phone got by pairing (see `iterm-web pair`).
const KEY="iterm-web-key";
const deviceKey=()=>{try{return localStorage.getItem(KEY) || "";}catch{return "";}};
export const UNPAIRED="iterm-web:unpaired";

async function request<T>(path:string,init:RequestInit={}):Promise<T> {
  const res=await fetch(path,{...init,headers:{"x-iterm-web":deviceKey() || "unpaired",...(init.body && typeof init.body==="string"?{"content-type":"application/json"}:{}),...init.headers}});
  const data=await res.json().catch(()=>({error:`Request failed (${res.status})`}));
  if(data.pairing)window.dispatchEvent(new Event(UNPAIRED));
  if(!res.ok)throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

// Trade a one-time code for the device secret.
export async function pair(code:string) {
  const {key}=await request<{key:string}>("/api/pair",{method:"POST",body:JSON.stringify({code}),headers:{"x-iterm-web":"pair"}});
  localStorage.setItem(KEY,key);
}
// A pairing link looks like https://<mac>:<port>/#pair=123456.
export function pairCodeFromUrl() {
  const m=/[#&]pair=(\d{6})/.exec(location.hash);
  return m?m[1]:null;
}
const enc=encodeURIComponent;
type SessionAction=Exclude<Action,{kind:"new-window"}> extends infer A?A extends unknown?Omit<A,"sessionId">:never:never;

export const api={
  me:()=>request<{login:string;host:string;voice?:boolean}>("/api/me"),
  sessions:()=>request<SessionList>("/api/sessions"),
  preview:(id:string)=>request<Preview>(`/api/sessions/${enc(id)}/preview`),
  skills:(id:string)=>request<InputOptions>(`/api/sessions/${enc(id)}/skills`),
  action:(id:string,action:SessionAction)=>request<{sessionId:string|null}>(`/api/sessions/${enc(id)}/action`,{method:"POST",body:JSON.stringify(action)}),
  newWindow:()=>request<{sessionId:string|null}>("/api/new-window",{method:"POST"}),
  sendClaude:(id:string,input:ClaudeSend)=>request<{sessionId:string|null}>(`/api/sessions/${enc(id)}/claude`,{method:"POST",body:JSON.stringify(input)}),
  transcribe:(audio:Blob)=>request<{text:string}>("/api/transcribe",{method:"POST",body:audio,headers:{"content-type":"application/octet-stream"}}),
  upload:(id:string,file:File)=>request<Upload>(`/api/sessions/${enc(id)}/uploads`,{method:"POST",body:file,headers:{"content-type":"application/octet-stream","x-file-name":enc(file.name)}}),
};

// Last-known data, so screens render instantly and refresh in the background.
const memory=new Map<string,unknown>();
export function cached<T>(key:string):T|null {
  if(memory.has(key))return memory.get(key) as T;
  try {const raw=localStorage.getItem(`cache:${key}`);return raw?JSON.parse(raw) as T:null;} catch {return null;}
}
const dirty=new Set<string>();
let flushTimer:ReturnType<typeof setTimeout>|undefined;
function flush() {
  flushTimer=undefined;
  for(const key of dirty){
    try {
      const raw=JSON.stringify(memory.get(key));
      if(raw.length>400000)continue;
      localStorage.setItem(`cache:${key}`,raw);
      // Keep only the most recent few session previews on disk.
      if(key.startsWith("preview:")){
        const order=(JSON.parse(localStorage.getItem("cache-order") || "[]") as string[]).filter(k=>k!==key);
        order.unshift(key);
        for(const old of order.splice(6))localStorage.removeItem(`cache:${old}`);
        localStorage.setItem("cache-order",JSON.stringify(order));
      }
    } catch { /* Storage full or unavailable; the memory cache still works. */ }
  }
  dirty.clear();
}
document.addEventListener("visibilitychange",()=>{if(document.hidden)flush();});
// Memory updates immediately; disk writes are batched so large previews don't cause jank.
export function remember(key:string,value:unknown) {
  memory.set(key,value);dirty.add(key);
  flushTimer??=setTimeout(flush,3000);
}

export const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);

export function useVisible() {
  const [visible,setVisible]=useState(!document.hidden);
  useEffect(()=>{
    const update=()=>setVisible(!document.hidden);
    document.addEventListener("visibilitychange",update);
    window.addEventListener("pageshow",update);
    return ()=>{document.removeEventListener("visibilitychange",update);window.removeEventListener("pageshow",update);};
  },[]);
  return visible;
}

// The session list, refreshed every few seconds while the app is on screen.
export function useSessions(interval=4000) {
  const visible=useVisible();
  const [data,setData]=useState<SessionList|null>(()=>cached<SessionList>("sessions"));
  const [error,setError]=useState("");
  const [tick,setTick]=useState(0);
  useEffect(()=>{
    if(!visible)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const read=async()=>{
      try {const result=await api.sessions();remember("sessions",result);if(!stopped){setData(result);setError("");}}
      catch(e){if(!stopped)setError(errorMessage(e));}
      if(!stopped)timer=setTimeout(read,interval);
    };
    void read();
    return ()=>{stopped=true;clearTimeout(timer);};
  },[visible,interval,tick]);
  return {data,error,refresh:()=>setTick(t=>t+1)};
}

// A live view of one session: the server pushes a new preview whenever the
// screen or Claude transcript changes. Reconnects after drops and app switches.
export function useLiveSession(sessionId:string) {
  const visible=useVisible();
  const [preview,setPreview]=useState<Preview|null>(()=>cached<Preview>(`preview:${sessionId}`));
  const [error,setError]=useState("");
  const [connected,setConnected]=useState(false);
  const [updatedAt,setUpdatedAt]=useState(0);
  const retry=useRef(0);
  useEffect(()=>{
    if(!visible)return;
    let socket:WebSocket|null=null,timer:ReturnType<typeof setTimeout>|undefined,stopped=false;
    const connect=()=>{
      socket=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/api/live?session=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(deviceKey())}`);
      socket.onopen=()=>{retry.current=0;setConnected(true);};
      socket.onmessage=event=>{
        const message=JSON.parse(event.data) as LiveMessage;
        if(message.type==="preview"){setPreview(message.preview);setError("");remember(`preview:${sessionId}`,message.preview);}
        else setError(message.message);
        setUpdatedAt(message.at);
      };
      socket.onclose=()=>{
        setConnected(false);
        if(stopped)return;
        const delay=Math.min(10000,500*2**retry.current++);
        timer=setTimeout(connect,delay);
      };
    };
    connect();
    return ()=>{stopped=true;clearTimeout(timer);socket?.close();setConnected(false);};
  },[sessionId,visible]);
  return {preview,error,connected,updatedAt};
}

export function useStoredState<T>(key:string,initial:T):[T,(value:T)=>void] {
  const [value,setValue]=useState<T>(()=>{
    try {const raw=localStorage.getItem(key);return raw===null?initial:JSON.parse(raw) as T;} catch {return initial;}
  });
  useEffect(()=>{
    try {const raw=localStorage.getItem(key);setValue(raw===null?initial:JSON.parse(raw) as T);} catch {setValue(initial);}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key]);
  return [value,(next:T)=>{setValue(next);try{localStorage.setItem(key,JSON.stringify(next));}catch{}}];
}
