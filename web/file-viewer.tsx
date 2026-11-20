import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, errorMessage, type FileInfo, type Folder } from "./api";
import { splitPaths, wholePath, type PathRef } from "./file-paths";
import { BackIcon, CloseIcon } from "./icons";

// Links in Markdown open in a new tab; images become links, since the page may only load its own files.
export const markdownComponents:Components={
  a:({node:_,...props})=><a {...props} target="_blank" rel="noreferrer" />,
  img:({src,alt})=><a href={typeof src==="string"?src:undefined} target="_blank" rel="noreferrer">{alt || "image"}</a>,
};

// Which candidate paths exist, per session, kept across views. Misses are asked
// again after a while, since Claude often names a file just before writing it.
const known=new Map<string,{info:FileInfo|null;at:number}>();
const MISS_TTL=15000;
const slot=(sessionId:string,path:string)=>`${sessionId}\n${path}`;

interface Links { info:(path:string)=>FileInfo|undefined; open:(ref:PathRef)=>void }
const LinksContext=createContext<Links|null>(null);
export const useFileLinks=()=>useContext(LinksContext);

// Asks the Mac about every path on screen in one request, and hosts the viewer.
export function FileLinks({sessionId,paths,children}:{sessionId:string;paths:string[];children:ReactNode}) {
  const [version,setVersion]=useState(0);
  const [viewing,setViewing]=useState<Entry|null>(null);
  const wanted=paths.join("\n");
  useEffect(()=>{
    const ask=paths.filter(p=>{const k=known.get(slot(sessionId,p));return !k || (!k.info && Date.now()-k.at>MISS_TTL);}).slice(-200);
    if(!ask.length)return;
    // Wait for the transcript to settle so a burst of updates is one request.
    const timer=setTimeout(()=>void api.fileStat(sessionId,ask).then(({files})=>{
      const at=Date.now();
      for(const p of ask)known.set(slot(sessionId,p),{info:files[p] ?? null,at});
      setVersion(v=>v+1);
    }).catch(()=>{}),150);
    return ()=>clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sessionId,wanted]);
  const links=useMemo<Links>(()=>({
    info:path=>known.get(slot(sessionId,path))?.info ?? undefined,
    open:ref=>{const info=known.get(slot(sessionId,ref.path))?.info;if(info)setViewing({info,line:ref.line});},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }),[sessionId,version]);
  return <LinksContext.Provider value={links}>
    {children}
    {/* On the page itself: inside the chat, a moved or clipped parent can push the bar and its Close button off screen. */}
    {viewing && createPortal(<FileViewer sessionId={sessionId} start={viewing} close={()=>setViewing(null)} />,document.body)}
  </LinksContext.Provider>;
}

// A rehype step that turns known paths in text and whole-path inline code into
// links carrying data-file. Code blocks and existing links are left alone.
type Node={type:string;tagName?:string;value?:string;properties?:Record<string,unknown>;children?:Node[]};
const textOf=(n:Node):string=>n.type==="text"?n.value ?? "":(n.children ?? []).map(textOf).join("");
export function rehypeFileLinks(exists:(path:string)=>boolean) {
  const link=(r:PathRef,children:Node[]):Node=>({type:"element",tagName:"a",properties:{href:"#",dataFile:r.raw},children});
  const walk=(node:Node)=>{
    if(!node.children || node.tagName==="a" || node.tagName==="pre")return;
    node.children=node.children.flatMap(child=>{
      if(child.type==="text"){
        const parts=splitPaths(child.value ?? "");
        if(!parts.some(p=>typeof p!=="string" && exists(p.path)))return [child];
        return parts.map(p=>typeof p==="string"?{type:"text",value:p}:exists(p.path)?link(p,[{type:"text",value:p.raw}]):{type:"text",value:p.raw});
      }
      if(child.tagName==="code"){const r=wholePath(textOf(child));return r && exists(r.path)?[link(r,[child])]:[child];}
      walk(child);return [child];
    });
  };
  return ()=>(tree:Node)=>walk(tree);
}
// The `a` renderer for chat Markdown: file links open the viewer, others a new tab.
export function fileLinkComponents(links:Links|null):Components {
  return {...markdownComponents,a:({node,children,...props})=>{
    const raw=node?.properties?.dataFile;
    const ref=typeof raw==="string"?wholePath(raw):null;
    if(ref && links)return <a href="#" className="file-link" onClick={e=>{e.preventDefault();links.open(ref);}}>{children}</a>;
    return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
  }};
}

// The end of a long path is the part that tells files apart.
const tilde=(p:string)=>{const t=p.replace(/^\/Users\/[^/]+/,"~");return t.length>44?"…"+t.slice(-43):t;};
export const formatSize=(n:number)=>n<1024?`${n} bytes`:n<1024**2?`${(n/1024).toFixed(n<10240?1:0)} KB`:n<1024**3?`${(n/1024**2).toFixed(1)} MB`:`${(n/1024**3).toFixed(1)} GB`;
const LABELS={image:"Image",text:"Text",markdown:"Markdown",pdf:"PDF",video:"Video",audio:"Audio"} as const;
const kindLabel=(f:FileInfo)=>f.kind==="dir"?"Folder":f.type!=="other"?LABELS[f.type]:(/\.([^.]{1,8})$/.exec(f.name)?.[1].toUpperCase() ?? "File");
const MAX_TEXT=1024*1024, SHARE_MAX=25*1024*1024;

interface Entry { info:FileInfo; line?:number }

// Full screen, one file or folder at a time. Opening a folder's entries stacks
// them, so Back returns to the folder.
export function FileViewer({sessionId,start,close}:{sessionId:string;start:Entry;close:()=>void}) {
  const [stack,setStack]=useState<Entry[]>([start]);
  const {info,line}=stack.at(-1)!;
  const [raw,setRaw]=useState(false);
  useEffect(()=>setRaw(line!==undefined),[info.path,line]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{if(e.key==="Escape")close();};
    window.addEventListener("keydown",key);
    return ()=>window.removeEventListener("keydown",key);
  },[close]);
  const open=(e:Entry)=>setStack(s=>[...s,e]);
  return <div className="viewer" role="dialog" aria-modal="true" aria-label={info.name}>
    <header className="viewer-bar">
      {stack.length>1 && <button type="button" className="icon-button back" aria-label="Back" onClick={()=>setStack(s=>s.slice(0,-1))}><BackIcon /></button>}
      <div className="viewer-title">
        <p className="viewer-name">{info.name}</p>
        <p className="viewer-path">{tilde(info.path)}</p>
      </div>
      {info.type==="markdown" && <button type="button" className="viewer-toggle" onClick={()=>setRaw(!raw)}>{raw?"Formatted":"Raw"}</button>}
      <button type="button" className="icon-button" aria-label="Close" onClick={close}><CloseIcon /></button>
    </header>
    <div className="viewer-body" key={info.path+(line ?? "")}>
      {info.kind==="dir"?<FolderView sessionId={sessionId} path={info.path} open={open} />
        :!info.url?<FileCard info={info} />
        :info.type==="image"?<ZoomImage src={info.url} alt={info.name} />
        :info.type==="text" || info.type==="markdown"?<TextView info={info} line={line} markdown={info.type==="markdown" && !raw} />
        :info.type==="video"?<div className="viewer-media"><video src={info.url} controls playsInline preload="metadata" /><FileCard info={info} /></div>
        :info.type==="audio"?<div className="viewer-media"><audio src={info.url} controls preload="metadata" /><FileCard info={info} /></div>
        :<FileCard info={info} />}
    </div>
  </div>;
}

function FolderView({sessionId,path,open}:{sessionId:string;path:string;open:(e:Entry)=>void}) {
  const [folder,setFolder]=useState<Folder|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let stopped=false;
    api.folder(sessionId,path).then(f=>{if(!stopped)setFolder(f);},e=>{if(!stopped)setError(errorMessage(e));});
    return ()=>{stopped=true;};
  },[sessionId,path]);
  if(error)return <p className="viewer-note">{error}</p>;
  if(!folder)return <p className="viewer-note">Loading…</p>;
  return <div className="folder">
    {folder.parent && <button type="button" className="folder-row" onClick={()=>open({info:folder.parent!})}>
      <span className="folder-name">↑ {folder.parent.name || "/"}</span><span className="folder-meta">Up</span>
    </button>}
    {!folder.entries.length && <p className="viewer-note">This folder is empty, or you can't see its files from here.</p>}
    {folder.entries.map(e=><button key={e.path} type="button" className="folder-row" data-kind={e.kind} onClick={()=>open({info:e})}>
      <span className="folder-name">{e.name}{e.kind==="dir"?"/":""}</span>
      <span className="folder-meta">{kindLabel(e)}{e.kind==="file"?` · ${formatSize(e.size)}`:""}</span>
    </button>)}
    {folder.truncated && <p className="viewer-note">Only the first 1,000 entries are shown.</p>}
  </div>;
}

function useText(url:string) {
  const [state,setState]=useState<{text:string;cut:boolean}|{error:string}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    // Only the first megabyte: enough to read, and quick over a phone connection.
    fetch(url,{headers:{range:`bytes=0-${MAX_TEXT-1}`},signal:controller.signal}).then(async res=>{
      if(!res.ok)throw new Error(((await res.json().catch(()=>({}))) as {error?:string}).error || "You can't open this file right now.");
      const bytes=await res.arrayBuffer();
      const total=Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1] ?? bytes.byteLength);
      let text=new TextDecoder().decode(bytes);
      const cut=total>bytes.byteLength;
      if(cut && text.includes("\n"))text=text.slice(0,text.lastIndexOf("\n")+1);
      setState({text,cut});
    }).catch(e=>{if(!controller.signal.aborted)setState({error:errorMessage(e)});});
    return ()=>controller.abort();
  },[url]);
  return state;
}

function TextView({info,line,markdown}:{info:FileInfo;line?:number;markdown:boolean}) {
  const state=useText(info.url!);
  if(!state)return <p className="viewer-note">Loading…</p>;
  if("error" in state)return <p className="viewer-note">{state.error}</p>;
  return <>
    {state.cut && <p className="viewer-note">This file is {formatSize(info.size)}. Only the first 1 MB is shown.</p>}
    {markdown
      ?<div className="markdown viewer-markdown"><Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{state.text}</Markdown></div>
      :<CodeView text={state.text} line={line} />}
  </>;
}

function CodeView({text,line}:{text:string;line?:number}) {
  const lines=useMemo(()=>{const l=text.split("\n");if(l.length>1 && l.at(-1)==="")l.pop();return l;},[text]);
  const target=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{target.current?.scrollIntoView({block:"center"});},[lines,line]);
  return <div className="code-view">
    <div className="code-lines" style={{"--gutter":`${String(lines.length).length}ch`} as CSSProperties}>
      {lines.map((l,i)=><div key={i} className="code-line" data-target={i+1===line || undefined} ref={i+1===line?target:undefined}>
        <span className="code-num">{i+1}</span><span className="code-text">{l || " "}</span>
      </div>)}
    </div>
  </div>;
}

// Pinch to zoom, drag to pan while zoomed, double tap to zoom in or back out.
function ZoomImage({src,alt}:{src:string;alt:string}) {
  const [t,setT]=useState({s:1,x:0,y:0});
  const [error,setError]=useState(false);
  const box=useRef<HTMLDivElement>(null);
  const gesture=useRef<{t:typeof t;dist?:number;mid:{x:number;y:number}}|null>(null);
  const lastTap=useRef(0);
  // Touch points relative to the box's center, where the transform's origin is.
  const point=(touches:React.TouchList)=>{
    const r=box.current!.getBoundingClientRect();
    const ps=Array.from(touches).slice(0,2).map(p=>({x:p.clientX-r.left-r.width/2,y:p.clientY-r.top-r.height/2}));
    const mid={x:ps.reduce((a,p)=>a+p.x,0)/ps.length,y:ps.reduce((a,p)=>a+p.y,0)/ps.length};
    return {mid,dist:ps.length===2?Math.hypot(ps[0].x-ps[1].x,ps[0].y-ps[1].y):undefined};
  };
  if(error)return <p className="viewer-note">You can't view this image here. Try downloading it instead.</p>;
  return <div className="zoom" ref={box}
    onTouchStart={e=>{
      const p=point(e.touches);
      gesture.current={t,...p};
      if(e.touches.length===1){
        if(Date.now()-lastTap.current<300){setT(t.s>1?{s:1,x:0,y:0}:{s:2.5,x:-p.mid.x*1.5,y:-p.mid.y*1.5});gesture.current=null;lastTap.current=0;}
        else lastTap.current=Date.now();
      }
    }}
    onTouchMove={e=>{
      const g=gesture.current;if(!g)return;
      const p=point(e.touches);
      if(g.dist && p.dist){
        // Keep the spot under the fingers where it was while scaling.
        const s=Math.min(8,Math.max(1,g.t.s*p.dist/g.dist));
        setT({s,x:p.mid.x-s*(g.mid.x-g.t.x)/g.t.s,y:p.mid.y-s*(g.mid.y-g.t.y)/g.t.s});
      } else if(!g.dist && g.t.s>1)setT({...g.t,x:g.t.x+p.mid.x-g.mid.x,y:g.t.y+p.mid.y-g.mid.y});
    }}
    onTouchEnd={e=>{
      if(e.touches.length){gesture.current={t,...point(e.touches)};return;}
      gesture.current=null;
      if(t.s<=1.02)setT({s:1,x:0,y:0});
    }}>
    <img src={src} alt={alt} draggable={false} onError={()=>setError(true)} style={{transform:`translate(${t.x}px,${t.y}px) scale(${t.s})`}} />
  </div>;
}

// Fetched ahead so Share runs straight from the tap, as iOS requires.
function useShareFile(info:FileInfo,enabled:boolean) {
  const [file,setFile]=useState<File|null>(null);
  useEffect(()=>{
    if(!enabled || !info.url || info.size>SHARE_MAX || typeof navigator.canShare!=="function")return;
    const controller=new AbortController();
    fetch(`${info.url}&download=1`,{signal:controller.signal}).then(r=>r.ok?r.blob():null).then(blob=>{
      if(!blob)return;
      const f=new File([blob],info.name,{type:blob.type});
      if(navigator.canShare({files:[f]}))setFile(f);
    }).catch(()=>{});
    return ()=>controller.abort();
  },[enabled,info.url,info.size,info.name]);
  return file;
}

function FileCard({info}:{info:FileInfo}) {
  // Video and audio play above the card; fetching them again just to share would be slow.
  const share=useShareFile(info,info.type!=="video" && info.type!=="audio");
  const media=info.type==="pdf" || info.type==="video" || info.type==="audio";
  return <div className="file-card">
    <p className="file-card-name">{info.name}</p>
    <p className="file-card-meta">{kindLabel(info)} · {formatSize(info.size)}</p>
    <p className="file-card-meta">Modified {new Date(info.mtime).toLocaleString()}</p>
    {!info.url && <p className="viewer-note">You can't open this file here.</p>}
    {info.url && <div className="file-card-actions">
      {media && <a className="file-card-button primary" href={info.url} target="_blank" rel="noreferrer">Open</a>}
      {share && <button type="button" className="file-card-button" onClick={()=>void navigator.share({files:[share],title:info.name}).catch(()=>{})}>Share</button>}
      <a className="file-card-button" href={`${info.url}&download=1`} download={info.name}>Download</a>
    </div>}
  </div>;
}
