import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// herdr-core's API: JSON-RPC 2.0, one message per line on its unix socket.
// `hc schema` documents every method.
export const hcSocket=()=>process.env.ITERM_WEB_HC_SOCKET || join(homedir(),".local","state","herdr-core","default","default.sock");

export class HcError extends Error {
  constructor(message:string,public kind?:string){super(message);}
}
export type HcEvent={type:string;terminal?:string;data?:unknown;seq?:number};
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};

export class Hc {
  private socket?:Socket;
  private connecting?:Promise<Socket>;
  private pending=new Map<number,Pending>();
  private next=1;
  private buffer="";
  private listeners=new Set<(event:HcEvent)=>void>();
  private subscribed=false;
  private retry?:ReturnType<typeof setTimeout>;
  private stream?:Hc;
  constructor(private path=hcSocket(),private events=false){}

  private connect():Promise<Socket> {
    if(this.socket && !this.socket.destroyed)return Promise.resolve(this.socket);
    return this.connecting??=new Promise<Socket>((resolve,reject)=>{
      const socket=createConnection(this.path);
      socket.setEncoding("utf8");
      socket.once("error",error=>{this.connecting=undefined;reject(new HcError(/ENOENT|ECONNREFUSED/.test(String(error))?"Herdr isn't running on this Mac. Open Herdr, then retry.":String(error),"unavailable"));});
      socket.on("data",chunk=>this.receive(String(chunk)));
      socket.on("close",()=>this.closed(socket));
      socket.once("connect",()=>{
        this.socket=socket;this.connecting=undefined;
        this.send(socket,"hello",{generation:1}).then(()=>{
          resolve(socket);
          if(this.listeners.size)this.subscribe();
        },reject);
      });
    });
  }

  private send(socket:Socket,method:string,params:unknown,timeout=15000):Promise<any> {
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new HcError("Herdr did not respond. Check that the app is running, then retry.","timeout"));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      socket.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
    });
  }

  private receive(chunk:string) {
    this.buffer+=chunk;
    let newline:number;
    while((newline=this.buffer.indexOf("\n"))>=0){
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
      if(!line.trim())continue;
      let message:any;
      try {message=JSON.parse(line);} catch {continue;}
      if(message.method==="event"){for(const listener of this.listeners)listener(message.params as HcEvent);continue;}
      const pending=typeof message.id==="number"?this.pending.get(message.id):undefined;
      if(!pending)continue;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(new HcError(String(message.error.message || "herdr-core error"),message.error.data?.kind));
      else pending.resolve(message.result);
    }
  }

  private closed(socket:Socket) {
    if(this.socket!==socket)return;
    this.socket=undefined;this.buffer="";this.subscribed=false;
    for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(new HcError("Lost the connection to Herdr. Retry.","unavailable"));this.pending.delete(id);}
    // Keep event listeners alive across a core restart.
    if(this.listeners.size && !this.retry)this.retry=setTimeout(()=>{this.retry=undefined;this.connect().catch(()=>this.closed(socket));},2000);
  }

  private subscribe() {
    if(this.subscribed || !this.socket)return;
    this.subscribed=true;
    this.send(this.socket,"events.subscribe",{}).catch(()=>{this.subscribed=false;});
  }

  async call<T=any>(method:string,params:Record<string,unknown>={},timeout?:number):Promise<T> {
    return this.send(await this.connect(),method,params,timeout);
  }

  // Every fact change on every terminal (status, title, turn, size...).
  // A subscribed connection only streams events and answers no more calls, so
  // events get a connection of their own.
  onEvent(listener:(event:HcEvent)=>void):()=>void {
    if(!this.events)return (this.stream??=new Hc(this.path,true)).onEvent(listener);
    this.listeners.add(listener);
    if(this.socket)this.subscribe();else void this.connect().catch(()=>{});
    return ()=>{this.listeners.delete(listener);};
  }

  close() {
    clearTimeout(this.retry);this.listeners.clear();
    this.socket?.destroy();this.stream?.close();
  }

  // Type bytes into a terminal as a person would. `terminal.send` and
  // `terminal.keys` can't do this: send always presses Enter, and keys only knows
  // unshifted key names. So attach on a framed connection of our own at the
  // terminal's current size (so nothing is resized), write, and detach.
  async type(terminal:string,text:string,timeout=10000):Promise<void> {
    const facts=await this.call<{cols:number;rows:number;state:string}>("terminal.get",{terminal});
    if(facts.state!=="live")throw new HcError("This terminal has finished.","finished");
    await typeRaw(this.path,terminal,facts.cols,facts.rows,Buffer.from(text,"utf8"),timeout);
  }
}

// Frames: channel (u32 LE), kind (u8), payload length (u32 LE), payload.
// Channel 0 carries JSON-RPC; an attach gets a channel of its own.
const DATA=0, CLOSE=2, HEADER=9;
export function frame(channel:number,kind:number,payload:Buffer) {
  const header=Buffer.alloc(HEADER);
  header.writeUInt32LE(channel,0);header.writeUInt8(kind,4);header.writeUInt32LE(payload.length,5);
  return Buffer.concat([header,payload]);
}

function typeRaw(path:string,terminal:string,cols:number,rows:number,bytes:Buffer,timeout:number):Promise<void> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path);
    let buffer=Buffer.alloc(0), hello=false, done=false;
    const finish=(error?:Error)=>{
      if(done)return;done=true;clearTimeout(timer);
      if(error){socket.destroy();reject(error);return;}
      socket.end(()=>resolve());
    };
    const timer=setTimeout(()=>finish(new HcError("Herdr did not respond. If you sent input, check the session before sending it again.","timeout")),timeout);
    socket.once("error",error=>finish(new HcError(String(error),"unavailable")));
    socket.once("connect",()=>socket.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"hello",params:{generation:1,framed:true}})+"\n"));
    socket.on("data",chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(!hello){
        const newline=buffer.indexOf(10);
        if(newline<0)return;
        const reply=JSON.parse(buffer.subarray(0,newline).toString("utf8"));
        buffer=buffer.subarray(newline+1);
        if(reply.error)return finish(new HcError(String(reply.error.message),reply.error.data?.kind));
        hello=true;
        socket.write(frame(0,DATA,Buffer.from(JSON.stringify({jsonrpc:"2.0",id:2,method:"terminal.attach",params:{terminal,cols,rows}}))));
      }
      while(buffer.length>=HEADER){
        const channel=buffer.readUInt32LE(0), length=buffer.readUInt32LE(5);
        if(buffer.length<HEADER+length)return;
        const payload=buffer.subarray(HEADER,HEADER+length);
        buffer=buffer.subarray(HEADER+length);
        if(channel!==0)continue; // the screen stream; we only write
        const reply=JSON.parse(payload.toString("utf8"));
        if(reply.id!==2)continue;
        if(reply.error)return finish(new HcError(String(reply.error.message),reply.error.data?.kind));
        const stream=Number(reply.result.channel);
        socket.write(frame(stream,DATA,bytes));
        socket.write(frame(stream,CLOSE,Buffer.alloc(0)),()=>finish());
        return;
      }
    });
  });
}
