import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

// Where a list was scrolled to, kept while you open an agent and come back, and
// across a reload. It keeps trying on each render until the list is long enough,
// so a list that fills in after it opens still lands where you left it. A list
// that comes and goes (the drawer) picks up its place each time it appears.
const kept=new Map<string,number>();
const stored=(key:string)=>{
  if(kept.has(key))return kept.get(key)!;
  try {const n=Number(sessionStorage.getItem(`scroll:${key}`));return Number.isFinite(n)?n:0;} catch {return 0;}
};

export function useKeptScroll(key:string,ref:RefObject<HTMLElement|null>) {
  const seen=useRef<{el:HTMLElement;off:()=>void}|null>(null);
  // The position still to restore; cleared once it's reached or you scroll yourself.
  const pending=useRef<number|null>(null);

  useLayoutEffect(()=>{
    const el=ref.current;
    if(el!==seen.current?.el){
      seen.current?.off();seen.current=null;
      if(el){
        pending.current=stored(key);
        const save=()=>{
          if(pending.current!==null)return;
          kept.set(key,el.scrollTop);
          try {sessionStorage.setItem(`scroll:${key}`,String(Math.round(el.scrollTop)));} catch {}
        };
        const yours=()=>{pending.current=null;};
        el.addEventListener("scroll",save,{passive:true});
        el.addEventListener("touchstart",yours,{passive:true});
        el.addEventListener("wheel",yours,{passive:true});
        seen.current={el,off:()=>{el.removeEventListener("scroll",save);el.removeEventListener("touchstart",yours);el.removeEventListener("wheel",yours);}};
      }
    }
    const target=pending.current;
    if(!el || target===null)return;
    if(target<=0){pending.current=null;return;}
    el.scrollTop=target;
    if(Math.abs(el.scrollTop-target)<2)pending.current=null;
  });
  useEffect(()=>()=>{seen.current?.off();seen.current=null;},[]);
}
