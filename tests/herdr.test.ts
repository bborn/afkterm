import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hc, frame } from "../server/hc";
import { isClaude, sessionsFrom, tabLabel } from "../server/herdr";

const terminal=(address:string,extra:Record<string,unknown>={})=>({
  address,state:"live",cols:120,rows:40,cwd:"/work",title:"",name:null,labels:{},status:null,
  foreground:{pid:1,name:"zsh",argv:["/bin/zsh"],cwd:"/work"},...extra,
} as any);

test("lists panes in the app's order, one group per space",()=>{
  const claude=terminal("t2",{title:"Fix login",status:{app:"claude-code",state:"working"},foreground:{pid:2,name:"2.1.318",argv:["claude"],cwd:"/repo"}});
  const sessions=sessionsFrom([terminal("t1"),claude,terminal("t3",{state:"finished"}),terminal("t9")],[
    {id:"sp1",name:"work",folder:"/work",machine:null,active:true,tabs:[
      {id:"tb1",name:"shell",active:true,terminals:[{terminal:"t1",pane:"p1",status:null,app:null,name:null},{terminal:"t2",pane:"p2",status:"working",app:"claude-code",name:null}]},
      {id:"tb2",name:"old",active:false,terminals:[{terminal:"t3",pane:"p3",status:null,app:null,name:null}]},
    ]},
    {id:"sp2",name:"box",folder:null,machine:"mona",active:false,tabs:[{id:"tb3",name:"logs",active:true,terminals:[{terminal:"t9",pane:"p9",status:null,app:null,name:"tail"}]}]},
  ]);
  assert.deepEqual(sessions.map(s=>[s.id,s.tabName,s.tabIndex,s.paneIndex,s.selected]),[["t1","shell",1,1,true],["t2","shell",1,2,false],["t9","logs",3,1,false]]);
  assert.equal(sessions[1].claude,true);
  assert.equal(sessions[1].processing,true);
  assert.equal(sessions[1].atPrompt,false);
  assert.equal(sessions[1].cwd,"/repo");
  assert.equal(sessions[0].atPrompt,true);
  assert.equal(sessions[2].name,"tail");
  assert.equal(sessions[2].group?.name,"box · mona");
  assert.notEqual(sessions[0].group?.color,sessions[2].group?.color);
});

test("falls back to herdr-core's labels when the app isn't open",()=>{
  const sessions=sessionsFrom([
    terminal("t1",{labels:{where:"work / shell"}}),
    terminal("t2",{labels:{where:"work / shell"}}),
    terminal("t3",{labels:{where:"home / notes"}}),
    terminal("t4"), // a worker nobody placed
  ],null);
  assert.deepEqual(sessions.map(s=>[s.id,s.group?.name,s.tabName,s.tabIndex,s.paneIndex]),[["t1","work","shell",1,1],["t2","work","shell",1,2],["t3","home","notes",2,1]]);
});

test("recognizes Claude by its status or its command",()=>{
  assert.equal(isClaude({status:{app:"claude-code"},foreground:null}),true);
  assert.equal(isClaude({status:null,foreground:{pid:1,name:"2.1.318",argv:["/usr/local/bin/claude"],cwd:null}}),true);
  assert.equal(isClaude({status:null,foreground:{pid:1,name:"zsh",argv:["zsh"],cwd:null}}),false);
});

test("frames carry channel, kind and length little-endian",()=>{
  assert.deepEqual([...frame(3,2,Buffer.from("hi"))],[3,0,0,0,2,2,0,0,0,104,105]);
});

// A pretend herdr-core: answers JSON-RPC lines, and on a framed connection
// accepts one attach and records what was typed on its channel.
function fakeCore() {
  const dir=mkdtempSync(join(tmpdir(),"hc-"));
  const path=join(dir,"core.sock");
  const typed:Buffer[]=[];const attaches:unknown[]=[];let closed=false;
  const server=createServer(socket=>{
    let buffer=Buffer.alloc(0),framed=false,subscribed=false;
    const reply=(id:number,result:unknown)=>{
      const body=Buffer.from(JSON.stringify({jsonrpc:"2.0",id,result}));
      socket.write(framed?frame(0,0,body):Buffer.concat([body,Buffer.from("\n")]));
    };
    socket.on("data",chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      for(;;){
        if(!framed){
          const newline=buffer.indexOf(10);if(newline<0)return;
          const message=JSON.parse(buffer.subarray(0,newline).toString());buffer=buffer.subarray(newline+1);
          if(message.method==="hello"){
            socket.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{framed:!!message.params.framed}})+"\n");
            framed=!!message.params.framed;continue;
          }
          // Like herdr-core, a subscribed connection streams events and answers nothing else.
          if(subscribed)continue;
          if(message.method==="events.subscribe"){reply(message.id,{terminals:[]});subscribed=true;continue;}
          if(message.method==="terminal.get")reply(message.id,{address:message.params.terminal,state:"live",cols:200,rows:50});
          continue;
        }
        if(buffer.length<9)return;
        const channel=buffer.readUInt32LE(0),kind=buffer.readUInt8(4),length=buffer.readUInt32LE(5);
        if(buffer.length<9+length)return;
        const payload=buffer.subarray(9,9+length);buffer=buffer.subarray(9+length);
        if(channel===0){const message=JSON.parse(payload.toString());attaches.push(message.params);reply(message.id,{channel:7});}
        else if(channel===7 && kind===0)typed.push(Buffer.from(payload));
        else if(channel===7 && kind===2)closed=true;
      }
    });
  });
  return {path,typed,attaches,closed:()=>closed,
    listen:()=>new Promise<void>(resolve=>server.listen(path,resolve)),
    close:()=>{server.close();rmSync(dir,{recursive:true,force:true});}};
}

test("types text by attaching at the terminal's own size, then detaching",async()=>{
  const core=fakeCore();await core.listen();
  const hc=new Hc(core.path);
  try {
    await hc.type("t5","Hi? (ok!) é\r");
    await new Promise(r=>setTimeout(r,50));
    assert.deepEqual(core.attaches,[{terminal:"t5",cols:200,rows:50}]);
    assert.equal(Buffer.concat(core.typed).toString("utf8"),"Hi? (ok!) é\r");
    assert.equal(core.closed(),true);
  } finally {hc.close();core.close();}
});

test("names a numbered tab after its agent, like Herdr does",()=>{
  const byAddress=new Map([
    ["t1",terminal("t1",{title:"~/work"})],
    ["t2",terminal("t2",{title:"Fix login",status:{app:"claude-code"}})],
  ]);
  const tab=(name:string,ids:string[])=>({id:"tb",name,active:false,terminals:ids.map(terminal=>({terminal,pane:"p",status:null,app:null,name:null}))});
  assert.equal(tabLabel(tab("3",["t1","t2"]),byAddress),"Fix login");
  assert.equal(tabLabel(tab("3",["t1"]),byAddress),"3");
  assert.equal(tabLabel(tab("api",["t2"]),byAddress),"api");
});

test("events get their own connection, so calls keep working",async()=>{
  const core=fakeCore();await core.listen();
  const hc=new Hc(core.path);
  try {
    const stop=hc.onEvent(()=>{});
    await new Promise(r=>setTimeout(r,50));
    assert.equal((await hc.call("terminal.get",{terminal:"t1"},2000)).cols,200);
    stop();
  } finally {hc.close();core.close();}
});
