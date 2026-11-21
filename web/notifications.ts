import { useEffect, useState } from "react";
import { api, type Session } from "./api";

// Notifications and the Home Screen badge for agents that need you. On an iPhone
// these only work in the Home Screen app, after you allow them from a tap.

const ID="afkterm-push-id", DONE="afkterm-push-done";
const read=(key:string)=>{try{return localStorage.getItem(key);}catch{return null;}};
const write=(key:string,value:string|null)=>{try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}catch{/* Private mode. */}};
export const pushId=()=>read(ID) || "";

const supported=()=>"serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const ios=()=>/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
const standalone=()=>matchMedia("(display-mode: standalone)").matches || (navigator as {standalone?:boolean}).standalone===true;
const allowed=()=>"Notification" in window && Notification.permission==="granted";

export type NotifyState="loading"|"unsupported"|"home-screen"|"denied"|"off"|"on";

function initialState():NotifyState {
  if(!supported())return ios() && !standalone()?"home-screen":"unsupported";
  if(Notification.permission==="denied")return "denied";
  return "loading";
}

// Register once at startup, so a tap on a notification can open the app.
export function registerWorker() {
  if(!("serviceWorker" in navigator))return;
  navigator.serviceWorker.register("/sw.js").catch(()=>{});
}

const keyBytes=(base64:string)=>{
  const raw=atob((base64+"=".repeat((4-base64.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
};

export function useNotifications() {
  const [state,setState]=useState<NotifyState>(initialState);
  const [done,setDone]=useState(()=>read(DONE)!=="false");
  const [error,setError]=useState("");
  useEffect(()=>{
    if(state!=="loading")return;
    api.push().then(r=>setState(r.on && allowed()?"on":"off"),()=>setState("off"));
  },[state]);

  // Call straight from a tap: iOS only asks for permission in response to one.
  async function enable(withDone:boolean) {
    setError("");
    try {
      const permission=await Notification.requestPermission();
      if(permission!=="granted"){setState(permission==="denied"?"denied":"off");return;}
      const registration=await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const {key}=await api.push();
      if(!key)throw new Error("Notifications aren't available on this Mac.");
      const subscription=await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(key)});
      const {id}=await api.pushOn(subscription.toJSON() as {endpoint:string;keys:{p256dh:string;auth:string}},withDone);
      write(ID,id);write(DONE,String(withDone));
      setDone(withDone);setState("on");
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
  }
  async function disable() {
    setError("");
    try {
      await api.pushOff();
      const registration=await navigator.serviceWorker.getRegistration();
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch { /* Off on the Mac is what matters. */ }
    write(ID,null);
    setState("off");
  }
  return {state,done,error,enable,disable};
}

// The number on the Home Screen icon: agents that need you or are done. Notifications
// for agents you've since dealt with are cleared from Notification Center.
export function syncAttention(sessions:Session[]) {
  if(!allowed())return;
  const waiting=new Set(sessions.filter(s=>s.attention).map(s=>s.id));
  const nav=navigator as Navigator & {setAppBadge?:(n:number)=>Promise<void>;clearAppBadge?:()=>Promise<void>};
  (waiting.size?nav.setAppBadge?.(waiting.size):nav.clearAppBadge?.())?.catch(()=>{});
  navigator.serviceWorker?.getRegistration().then(r=>r?.getNotifications()).then(list=>{
    for(const n of list ?? [])if(n.tag && !waiting.has(n.tag))n.close();
  }).catch(()=>{});
}

// A tap on a notification while the app is already running.
export function onNotificationOpen(open:(path:string)=>void) {
  if(!("serviceWorker" in navigator))return ()=>{};
  const listen=(e:MessageEvent)=>{
    const data=e.data as {kind?:string;url?:string};
    if(data?.kind==="open" && data.url)open(new URL(data.url).pathname);
  };
  navigator.serviceWorker.addEventListener("message",listen);
  return ()=>navigator.serviceWorker.removeEventListener("message",listen);
}
