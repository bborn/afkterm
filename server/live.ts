import { watch as watchFile, type FSWatcher } from "node:fs";
import type { LiveMessage, Preview } from "./contract";

type Client = { send(data:string):void };
type Reader = (sessionId:string,signal:AbortSignal)=>Promise<Preview>;
interface Options {
  active?:number;   // ms between reads while the screen is changing or Claude is working
  idle?:number;     // ms between reads once it has been quiet for a while
  quietAfter?:number;
  // A file whose changes mean the session changed (Claude's transcript).
  watchPath?:(sessionId:string)=>string|undefined;
  // A push source of change events (iTerm screen updates). Returns an unsubscribe.
  onChange?:(sessionId:string,changed:()=>void)=>()=>void;
  minGap?:number;   // never read more often than this, however many change events arrive
  // A cheaper read for the first message, when a full one can take seconds
  // (herdr-core scrolls Claude's screen to read its history). A full read follows at once.
  quick?:Reader;
}
interface Watch {
  clients:Set<Client>; last?:string; lastKey?:string; timer?:ReturnType<typeof setTimeout>;
  running:boolean; again:boolean; controller:AbortController; changedAt:number; working:boolean;
  file?:{path:string;watcher:FSWatcher}; debounce?:ReturnType<typeof setTimeout>;
  readAt:number; dueAt?:number; unlisten?:()=>void;
}

// One polling loop per watched session, shared by every client viewing it.
// Clients only receive a message when the screen or conversation changed.
// Reads are fast while something is happening and slow down when it is quiet;
// a write to Claude's transcript triggers an immediate read.
export class LiveSessions {
  private watches=new Map<string,Watch>();
  private active:number; private idle:number; private quietAfter:number; private minGap:number;
  constructor(private read:Reader,private options:Options={}) {
    this.active=options.active ?? 400;
    this.idle=options.idle ?? 1500;
    this.quietAfter=options.quietAfter ?? 10000;
    this.minGap=options.minGap ?? 250;
  }

  subscribe(sessionId:string,client:Client):()=>void {
    let watch=this.watches.get(sessionId);
    if(!watch){
      watch={clients:new Set(),running:false,again:false,controller:new AbortController(),changedAt:Date.now(),working:false,readAt:0};
      this.watches.set(sessionId,watch);
      try {watch.unlisten=this.options.onChange?.(sessionId,()=>this.changed(sessionId));} catch { /* Polling still works. */ }
    }
    watch.clients.add(client);
    if(watch.last)client.send(watch.last);
    if(!watch.running && !watch.timer)void this.tick(sessionId);
    return ()=>{
      const current=this.watches.get(sessionId);
      if(!current)return;
      current.clients.delete(client);
      if(current.clients.size)return;
      clearTimeout(current.timer);clearTimeout(current.debounce);current.controller.abort();current.file?.watcher.close();current.unlisten?.();
      this.watches.delete(sessionId);
    };
  }

  // Read again right away, e.g. after input was sent, so the change shows promptly.
  poke(sessionId:string) {
    const watch=this.watches.get(sessionId);
    if(!watch)return;
    watch.changedAt=Date.now();
    if(watch.running){watch.again=true;return;}
    clearTimeout(watch.timer);watch.timer=undefined;
    void this.tick(sessionId);
  }

  // A pushed change event: read soon, but no more often than minGap.
  private changed(sessionId:string) {
    const watch=this.watches.get(sessionId);
    if(!watch)return;
    watch.changedAt=Date.now();
    if(watch.running){watch.again=true;return;}
    const wait=Math.max(0,watch.readAt+this.minGap-Date.now());
    if(watch.timer && watch.dueAt!==undefined && watch.dueAt<=Date.now()+wait)return;
    this.schedule(sessionId,watch,wait);
  }

  get size() { return this.watches.size; }
  watching(sessionId:string) { return this.watches.has(sessionId); }

  private async tick(sessionId:string) {
    const watch=this.watches.get(sessionId);
    if(!watch)return;
    watch.running=true;watch.timer=undefined;
    let message:LiveMessage;
    const quick=!watch.readAt?this.options.quick:undefined;
    try {
      const preview=await (quick ?? this.read)(sessionId,AbortSignal.any([watch.controller.signal,AbortSignal.timeout(15000)]));
      watch.working=!!preview.claude?.working;
      message={type:"preview",preview,at:Date.now()};
    } catch(error) {
      message={type:"error",message:error instanceof Error ? error.message : String(error),at:Date.now()};
    }
    watch.running=false;watch.readAt=Date.now();
    if(this.watches.get(sessionId)!==watch)return;
    // A failed quick read isn't worth showing; the full read comes next either way.
    if(quick && message.type==="error"){this.schedule(sessionId,watch,0);return;}
    // Compare without the timestamp so unchanged screens are not re-sent.
    const {at:_,...body}=message;
    const key=JSON.stringify(body);
    if(key!==watch.lastKey){
      watch.lastKey=key;watch.changedAt=Date.now();
      watch.last=JSON.stringify(message);
      for(const client of watch.clients)client.send(watch.last);
    }
    this.followFile(sessionId,watch);
    const busy=watch.working || Date.now()-watch.changedAt<this.quietAfter;
    const delay=quick?0:watch.again?this.minGap:busy?this.active:this.idle;
    watch.again=false;
    this.schedule(sessionId,watch,delay);
  }

  private schedule(sessionId:string,watch:Watch,delay:number) {
    clearTimeout(watch.timer);
    watch.dueAt=Date.now()+delay;
    watch.timer=setTimeout(()=>void this.tick(sessionId),delay);
  }

  private followFile(sessionId:string,watch:Watch) {
    const path=this.options.watchPath?.(sessionId);
    if(path===watch.file?.path)return;
    watch.file?.watcher.close();watch.file=undefined;
    if(!path)return;
    try {
      const watcher=watchFile(path,()=>{
        clearTimeout(watch.debounce);
        watch.debounce=setTimeout(()=>this.changed(sessionId),30);
      });
      watcher.on("error",()=>{watcher.close();if(watch.file?.watcher===watcher)watch.file=undefined;});
      watch.file={path,watcher};
    } catch { /* Fall back to polling. */ }
  }
}
