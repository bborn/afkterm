// Working out where a dragged tab lands in the tab list. A tab can show as several
// rows (one per pane), so each tab is one block: its rows' top and total height.

export interface Block {tab:number;top:number;height:number}

// The position the dragged block would take, from where its middle is now.
export function dropTarget(blocks:Block[],from:number,dy:number):number {
  const b=blocks[from];
  const middle=b.top+b.height/2+dy;
  return blocks.filter((o,i)=>i!==from && o.top+o.height/2<middle).length;
}

// How far another block moves out of the way while the dragged one hovers at `target`.
export function shiftFor(i:number,from:number,target:number,height:number):number {
  if(i===from)return 0;
  if(from<target && i>from && i<=target)return -height;
  if(target<from && i>=target && i<from)return height;
  return 0;
}

export function moved<T>(items:T[],from:number,to:number):T[] {
  const out=items.slice();const [item]=out.splice(from,1);out.splice(to,0,item);return out;
}
