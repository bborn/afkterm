import WebSocket from "ws";
import { parse } from "protobufjs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSavedGroups } from "./saved-layout";
import { runAutomation } from "./bridge";

// Wire-field subset of iTerm's published API: proto/api.proto, protocol 1.19.
const schema = parse(`syntax = "proto2";
message Session { optional string id = 1; }
message Link { optional Session session = 1; optional Node node = 2; }
message Node { repeated Link links = 2; }
message Tab { optional Node root = 3; optional string id = 2; repeated Session minimized = 6;
 optional string groupId = 8; optional string groupName = 9; optional string groupColor = 10; optional bool collapsed = 11; }
message Window { repeated Tab tabs = 1; }
message Listing { repeated Window windows = 1; }
message Empty {}
message Request { optional int64 id = 1; optional Empty list = 106; }
message Response { optional int64 id = 1; optional string error = 2; optional Listing list = 106; }
`).root;
const Request = schema.lookupType("Request");
const Response = schema.lookupType("Response");
export interface TabGroup { id: string; name: string; color: string; collapsed: boolean }
interface Node { links?: { session?: {id?:string}; node?:Node }[] }
interface Listing { windows?: {tabs?: {root?:Node; minimized?:{id?:string}[]; groupId?:string; groupName?:string; groupColor?:string; collapsed?:boolean}[]}[] }

export function groupColor(value: string): string {
  const match = /^(p3)?#([0-9a-f]{6}|[0-9a-f]{12})$/i.exec(value);
  if (match) {
    const hex = match[2], width = hex.length / 3;
    const components = [0, 1, 2].map(i => parseInt(hex.slice(i * width, (i + 1) * width), 16) / (width === 4 ? 65535 : 255));
    if (match[1]) return `color(display-p3 ${components.map(n => n.toFixed(5)).join(" ")})`;
    return "#" + components.map(n => Math.round(n * 255).toString(16).padStart(2, "0")).join("");
  }
  return "#808080";
}
export function collectGroups(list: Listing): Map<string, TabGroup> {
  const groups = new Map<string,TabGroup>();
  for (const window of list.windows || []) for (const tab of window.tabs || []) {
    if (!tab.groupId) continue;
    const group={id:tab.groupId,name:tab.groupName || "",color:groupColor(tab.groupColor || ""),collapsed:!!tab.collapsed};
    const visit=(node?:Node,depth=0)=>{
      if(depth>32)return;
      for(const link of node?.links || []) {
        if(link.session?.id)groups.set(link.session.id,group);
        if(link.node)visit(link.node,depth+1);
      }
    };
    visit(tab.root);
    for(const session of tab.minimized || [])if(session.id)groups.set(session.id,group);
  }
  return groups;
}

let cached: { expires:number; groups:Map<string,TabGroup> } | undefined;
let inFlight: Promise<Map<string,TabGroup>> | undefined;
export async function readTabGroups(signal: AbortSignal): Promise<Map<string,TabGroup>> {
  if(cached && cached.expires>Date.now())return cached.groups;
  if(inFlight)return inFlight;
  inFlight = fetchGroups(signal).then(async groups=>groups.size ? groups : await readSavedGroups(signal)).catch(async error=>{try{return await readSavedGroups(signal);}catch{throw error;}}).then(groups=>{cached={expires:Date.now()+3000,groups};return groups;}).finally(()=>{inFlight=undefined;});
  return inFlight;
}
async function fetchGroups(signal: AbortSignal): Promise<Map<string,TabGroup>> {
  const credentials = await runAutomation({method:"api-auth"},signal) as {cookie:string;key:string};
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket("ws://localhost/",["api.iterm2.com"],{
      createConnection:()=>connect({path:join(homedir(),"Library/Application Support/iTerm2/private/socket")}),
      headers:{origin:"ws://localhost/","x-iterm2-cookie":credentials.cookie,"x-iterm2-key":credentials.key,"x-iterm2-advisory-name":"afkterm","x-iterm2-library-version":"afkterm 0.2.0","x-iterm2-disable-auth-ui":"true"},
      handshakeTimeout:5000,maxPayload:4*1024*1024,
    });
    let finished=false;
    const finish=(error?:Error,groups?:Map<string,TabGroup>)=>{
      if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener("abort",abort);socket.terminate();
      if(error)reject(error);else resolve(groups!);
    };
    const abort=()=>finish(new Error("iTerm metadata request cancelled"));
    const timer=setTimeout(()=>finish(new Error("iTerm API did not respond with tab groups")),6000);
    socket.on("error",()=>finish(new Error("Cannot read tab groups. Enable the iTerm Python API under Settings → General → Magic and allow afkterm access.")));
    socket.on("close",()=>{if(!finished)finish(new Error("iTerm API closed before returning tab groups"));});
    socket.on("open",()=>socket.send(Request.encode({id:1,list:{}}).finish()));
    socket.on("message",data=>{
      try {
        const response=Response.toObject(Response.decode(data as Buffer),{longs:Number}) as {id?:number;error?:string;list?:Listing};
        if(response.id!==1)return;
        if(response.error)return finish(new Error(response.error));
        if(response.list)finish(undefined,collectGroups(response.list));
        else finish(new Error("iTerm API returned no session list"));
      }catch{finish(new Error("Invalid iTerm API response"));}
    });
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted)abort();
  });
}
