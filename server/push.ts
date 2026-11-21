import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { z } from "zod";
import { CONFIG_DIR } from "./config";
import type { Session } from "./contract";

// Notifications on a phone that added afkterm to its Home Screen, sent through
// the phone's push service (Apple's, on an iPhone). The Mac signs each one with
// its own key and encrypts it for that phone only.

export const PUSH_FILE=join(CONFIG_DIR,"push.json");
// A phone that asked for anything in this long is looking at afkterm already.
const ACTIVE_MS=20000;

export const subscriptionSchema=z.object({
  endpoint:z.string().url().max(1000).refine(u=>u.startsWith("https://"),"Push endpoints must use https"),
  keys:z.object({p256dh:z.string().max(200),auth:z.string().max(100)}),
});
export const pushOnSchema=z.object({subscription:subscriptionSchema,done:z.boolean()});
const fileSchema=z.object({
  vapid:z.object({publicKey:z.string(),privateKey:z.string()}),
  phones:z.array(z.object({id:z.string(),done:z.boolean(),subscription:subscriptionSchema})).default([]),
});
type State=z.infer<typeof fileSchema>;
type Seen={attention:Session["attention"];turn:number|null};
export type Alert={session:Session;kind:"blocked"|"done"};

// What changed since the last look: an agent that started needing you, or one
// that finished a new turn. The first look only remembers, so a restart is quiet.
export function alerts(before:Map<string,Seen>|null,sessions:Session[]):Alert[] {
  if(!before)return [];
  const out:Alert[]=[];
  for(const s of sessions){
    const was=before.get(s.id);
    if(s.attention==="blocked" && was?.attention!=="blocked")out.push({session:s,kind:"blocked"});
    if(s.attention==="done" && (was?.attention!=="done" || was.turn!==s.turn))out.push({session:s,kind:"done"});
  }
  return out;
}

export const badgeCount=(sessions:Session[])=>sessions.filter(s=>s.attention).length;

export function message({session:s,kind}:Alert,badge:number) {
  const name=s.tabName || s.name;
  return {
    title:name,
    body:kind==="blocked"?(s.ask || "Needs you"):"Done",
    tag:s.id,
    url:`/s/${encodeURIComponent(s.id)}`,
    badge,
  };
}

type Send=(subscription:z.infer<typeof subscriptionSchema>,payload:string,options:webpush.RequestOptions)=>Promise<unknown>;

export class Push {
  private state:State;
  private last:Map<string,Seen>|null=null;
  private active=new Map<string,number>();
  constructor(private file=PUSH_FILE,private send:Send=webpush.sendNotification,private subject="https://github.com/bborn/afkterm") {
    let state:State|null=null;
    try {state=fileSchema.parse(JSON.parse(readFileSync(file,"utf8")));} catch { /* First use. */ }
    this.state=state ?? {vapid:webpush.generateVAPIDKeys(),phones:[]};
    if(!state)this.save();
  }
  get publicKey(){return this.state.vapid.publicKey;}
  get phones(){return this.state.phones.length;}

  // One entry per phone: turning it on again replaces the old one.
  on(subscription:z.infer<typeof subscriptionSchema>,done:boolean) {
    const old=this.state.phones.find(p=>p.subscription.endpoint===subscription.endpoint);
    const id=old?.id ?? randomBytes(12).toString("base64url");
    this.state.phones=[...this.state.phones.filter(p=>p.id!==id),{id,done,subscription}];
    this.save();
    return id;
  }
  off(id:string){this.state.phones=this.state.phones.filter(p=>p.id!==id);this.save();}
  has(id:string){return this.state.phones.some(p=>p.id===id);}
  // The phone made a request, so afkterm is open on it right now.
  touch(id:string|undefined,now=Date.now()){if(id)this.active.set(id,now);}

  // Compare with the last look and tell each phone that isn't already looking.
  async check(sessions:Session[],now=Date.now()) {
    const found=alerts(this.last,sessions);
    this.last=new Map(sessions.map(s=>[s.id,{attention:s.attention,turn:s.turn}]));
    if(!found.length)return 0;
    const badge=badgeCount(sessions);
    let sent=0;
    for(const phone of this.state.phones){
      const seen=this.active.get(phone.id);
      if(seen!==undefined && now-seen<ACTIVE_MS)continue;
      for(const alert of found){
        if(alert.kind==="done" && !phone.done)continue;
        try {
          await this.send(phone.subscription,JSON.stringify(message(alert,badge)),{
            vapidDetails:{subject:this.subject,publicKey:this.state.vapid.publicKey,privateKey:this.state.vapid.privateKey},
            TTL:3600, urgency:alert.kind==="blocked"?"high":"normal",
            // A newer alert for the same agent replaces one the phone hasn't received yet.
            topic:createHash("sha256").update(alert.session.id).digest("base64url").slice(0,32),
          });
          sent++;
        } catch(error) {
          const status=(error as {statusCode?:number}).statusCode;
          // The phone turned notifications off or removed the app.
          if(status===404 || status===410){this.off(phone.id);break;}
          console.log(`push: couldn't notify a phone (${status ?? (error instanceof Error?error.message:String(error))})`);
        }
      }
    }
    return sent;
  }

  private save() {
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    writeFileSync(this.file,JSON.stringify(this.state,null,2)+"\n",{mode:0o600});
    chmodSync(this.file,0o600);   // holds the signing key
  }
}
