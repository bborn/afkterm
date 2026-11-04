import WebSocket from "ws";
import { parse } from "protobufjs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAutomation } from "./bridge";

// A persistent connection to iTerm2's local API (the one its Python scripts use).
// One round trip is ~1ms, versus ~100-300ms+ to start osascript and walk
// AppleScript objects, and iTerm can push "this screen changed" notifications.
// Wire-field subset of iTerm's published proto/api.proto (protocol 1.19+);
// field names are ours, numbers are iTerm's.
const root=parse(`syntax = "proto2";
message ClientOriginatedMessage { optional int64 id = 1; oneof submessage {
  GetBufferRequest getBuffer = 100; NotificationRequest notification = 103; ListSessionsRequest listSessions = 106;
  SendTextRequest sendText = 107; ActivateRequest activate = 114; VariableRequest variable = 115; } }
message ServerOriginatedMessage { optional int64 id = 1; oneof submessage {
  string error = 2; GetBufferResponse getBuffer = 100; NotificationResponse notificationResponse = 103;
  ListSessionsResponse listSessions = 106; SendTextResponse sendText = 107; ActivateResponse activate = 114;
  VariableResponse variable = 115; Notification notification = 1000; } }
message LineRange { optional bool screenContentsOnly = 1; optional int32 trailingLines = 2; }
message GetBufferRequest { optional string session = 1; optional LineRange lineRange = 2; optional bool includeStyles = 3; }
message LineContents { optional string text = 1; optional int32 continuation = 3; }
message GetBufferResponse { optional int32 status = 1; repeated LineContents contents = 3; }
message NotificationRequest { optional string session = 1; optional bool subscribe = 2; optional int32 notificationType = 3; }
message NotificationResponse { optional int32 status = 1; }
message ScreenUpdateNotification { optional string session = 1; }
message Notification { optional ScreenUpdateNotification screenUpdate = 2; }
message ListSessionsRequest {}
message SessionSummary { optional string uniqueIdentifier = 1; optional string title = 4; }
message SplitTreeLink { oneof child { SessionSummary session = 1; SplitTreeNode node = 2; } }
message SplitTreeNode { optional bool vertical = 1; repeated SplitTreeLink links = 2; }
message FloatingPane { optional SessionSummary session = 1; }
message Tab { optional string tabId = 2; optional SplitTreeNode root = 3; repeated SessionSummary minimizedSessions = 6;
  optional string activeSessionId = 7; optional string tabGroupId = 8; optional string tabGroupName = 9;
  optional string tabGroupColor = 10; optional bool tabGroupCollapsed = 11; repeated FloatingPane floatingPanes = 12; }
message Window { repeated Tab tabs = 1; optional string windowId = 2; optional int32 number = 4; optional string selectedTabId = 5; }
message ListSessionsResponse { repeated Window windows = 1; }
message SendTextRequest { optional string session = 1; optional string text = 2; optional bool suppressBroadcast = 3; }
message SendTextResponse { optional int32 status = 1; }
message ActivateApp { optional bool raiseAllWindows = 1; optional bool ignoringOtherApps = 2; }
message ActivateRequest { oneof identifier { string windowId = 1; string tabId = 2; string sessionId = 3; }
  optional bool orderWindowFront = 4; optional bool selectTab = 5; optional bool selectSession = 6; optional ActivateApp activateApp = 7; }
message ActivateResponse { optional int32 status = 1; }
message VariableRequest { oneof scope { string sessionId = 1; string tabId = 4; bool app = 5; string windowId = 6; } repeated string get = 3; }
message VariableResponse { optional int32 status = 1; repeated string values = 2; }
`).root;
export const Request=root.lookupType("ClientOriginatedMessage");
export const Response=root.lookupType("ServerOriginatedMessage");
const SCREEN_UPDATE=2;
const CONTINUATION_SOFT_EOL=2;

export interface SessionSummary { uniqueIdentifier?:string; title?:string }
export interface SplitTreeNode { links?:{session?:SessionSummary;node?:SplitTreeNode}[] }
export interface ApiTab { tabId?:string; root?:SplitTreeNode; minimizedSessions?:SessionSummary[]; activeSessionId?:string; tabGroupId?:string; tabGroupName?:string; tabGroupColor?:string; tabGroupCollapsed?:boolean; floatingPanes?:{session?:SessionSummary}[] }
export interface ApiWindow { tabs?:ApiTab[]; windowId?:string; number?:number; selectedTabId?:string }
type Message = Record<string,any>;

export class ItermApi {
  private socket?:WebSocket;
  private opening?:Promise<WebSocket>;
  private nextId=1;
  private pending=new Map<number,{resolve:(m:Message)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private screenListeners=new Map<string,Set<()=>void>>();

  constructor(
    private socketPath=join(homedir(),"Library/Application Support/iTerm2/private/socket"),
    private credentials=async()=>await runAutomation({method:"api-auth"},AbortSignal.timeout(10000)) as {cookie:string;key:string},
  ) {}

  private open():Promise<WebSocket> {
    if(this.socket?.readyState===WebSocket.OPEN)return Promise.resolve(this.socket);
    this.opening??=(async()=>{
      try {
        const credentials=await this.credentials();
        const socket=await new Promise<WebSocket>((resolve,reject)=>{
          const ws=new WebSocket("ws://localhost/",["api.iterm2.com"],{
            createConnection:()=>connect({path:this.socketPath}),
            headers:{origin:"ws://localhost/","x-iterm2-cookie":credentials.cookie,"x-iterm2-key":credentials.key,"x-iterm2-advisory-name":"afkterm","x-iterm2-library-version":"afkterm 0.2.0","x-iterm2-disable-auth-ui":"true"},
            handshakeTimeout:5000,maxPayload:16*1024*1024,
          });
          ws.once("open",()=>resolve(ws));
          ws.once("error",()=>reject(new Error("Cannot reach iTerm's API. Enable it under iTerm Settings → General → Magic → Enable Python API.")));
        });
        socket.on("message",data=>this.receive(data as Buffer));
        socket.on("close",()=>this.closed(socket));
        socket.on("error",()=>socket.terminate());
        this.socket=socket;
        // Screen subscriptions belong to a connection; restore them after reconnecting.
        for(const session of this.screenListeners.keys())void this.subscribeScreen(session,true).catch(()=>{});
        return socket;
      } finally {this.opening=undefined;}
    })();
    return this.opening;
  }

  private closed(socket:WebSocket) {
    if(this.socket!==socket)return;
    this.socket=undefined;
    for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(new Error("iTerm's API connection closed."));this.pending.delete(id);}
    // Keep screen notifications flowing if anyone still wants them.
    if(this.screenListeners.size)setTimeout(()=>{if(!this.socket && this.screenListeners.size)void this.open().catch(()=>{});},2000);
  }

  private receive(data:Buffer) {
    let message:Message;
    try {message=Response.toObject(Response.decode(data),{longs:Number,defaults:false});} catch {return;}
    const session=message.notification?.screenUpdate?.session;
    if(session){for(const listener of this.screenListeners.get(session) || [])listener();return;}
    const waiter=this.pending.get(message.id);
    if(!waiter)return;
    this.pending.delete(message.id);clearTimeout(waiter.timer);
    if(message.error)waiter.reject(new Error(`iTerm API: ${message.error}`));
    else waiter.resolve(message);
  }

  async call(request:Message,timeout=5000):Promise<Message> {
    const socket=await this.open();
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("iTerm's API did not respond."));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      socket.send(Request.encode(Request.fromObject({id,...request})).finish());
    });
  }

  close() { this.socket?.close(); }

  async listSessions():Promise<ApiWindow[]> {
    return (await this.call({listSessions:{}})).listSessions?.windows || [];
  }

  // Variables are JSON-encoded; missing ones come back as null.
  async variables(scope:{sessionId:string}|{tabId:string},names:string[]):Promise<Record<string,unknown>> {
    const response=(await this.call({variable:{...scope,get:names}})).variable;
    if(response?.status)throw new Error("Session no longer exists. Refresh the session list.");
    return Object.fromEntries(names.map((name,i)=>{
      try {return [name,JSON.parse(response?.values?.[i] ?? "null")];} catch {return [name,null];}
    }));
  }

  // The last `lines` lines of the session (scrollback plus screen), or just the
  // screen, as text. Soft-wrapped rows are joined back into one line.
  async screen(session:string,lines?:number):Promise<string> {
    const response=(await this.call({getBuffer:{session,lineRange:lines?{trailingLines:lines}:{screenContentsOnly:true}}})).getBuffer;
    if(response?.status)throw new Error("Session no longer exists. Refresh the session list.");
    let text="";
    for(const line of response?.contents || [])text+=(line.text || "")+(line.continuation===CONTINUATION_SOFT_EOL?"":"\n");
    return text.replace(/[ \t]+$/gm,"").replace(/\n+$/,"\n");
  }

  async sendText(session:string,text:string) {
    const response=(await this.call({sendText:{session,text}})).sendText;
    if(response?.status)throw new Error("Session no longer exists. Refresh the session list.");
  }

  async activate(sessionId:string) {
    await this.call({activate:{sessionId,orderWindowFront:true,selectTab:true,selectSession:true,activateApp:{raiseAllWindows:false,ignoringOtherApps:true}}});
  }

  // Calls `listener` whenever the session's screen changes. Returns an unsubscribe function.
  onScreenUpdate(session:string,listener:()=>void):()=>void {
    let listeners=this.screenListeners.get(session);
    if(!listeners){listeners=new Set();this.screenListeners.set(session,listeners);void this.subscribeScreen(session,true).catch(()=>{});}
    listeners.add(listener);
    return ()=>{
      const current=this.screenListeners.get(session);
      if(!current?.delete(listener) || current.size)return;
      this.screenListeners.delete(session);
      if(this.socket)void this.subscribeScreen(session,false).catch(()=>{});
    };
  }

  private async subscribeScreen(session:string,subscribe:boolean) {
    await this.call({notification:{session,subscribe,notificationType:SCREEN_UPDATE}});
  }
}

// Sessions of a tab in iTerm's order: split panes, then minimized and floating ones.
export function tabSessions(tab:ApiTab):SessionSummary[] {
  const out:SessionSummary[]=[];
  const visit=(node?:SplitTreeNode,depth=0)=>{
    if(!node || depth>32)return;
    for(const link of node.links || []){if(link.session)out.push(link.session);else visit(link.node,depth+1);}
  };
  visit(tab.root);
  for(const s of tab.minimizedSessions || [])out.push(s);
  for(const f of tab.floatingPanes || [])if(f.session)out.push(f.session);
  return out.filter(s=>s.uniqueIdentifier);
}
