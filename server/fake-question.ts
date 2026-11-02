import type { QuestionTerminal } from "./question";

// A stand-in for Claude Code's AskUserQuestion dialog in demo mode. It draws the
// dialog the way Claude Code 2.1 does and reacts to the same keys, so the real
// screen parser and key driver run against it unchanged.

interface Q { header:string; question:string; multiSelect:boolean; options:{label:string;description:string;preview?:string}[] }
const QUESTIONS:Q[]=[
  {header:"Layout",question:"Which layout should the archive page use? The archive currently lists about 340 posts going back to 2014, many of which have no hero image, and the design team wants something that still looks intentional when half the cards are text-only. Mobile traffic is 72% of visits, so whatever we pick has to hold up on a narrow phone first and a desktop second.",multiSelect:false,options:[
    {label:"Grid",description:"Cards in columns with a thumbnail, title, date and a two-line excerpt; posts without a hero image fall back to a tinted block with the first letter of the title, which keeps the rhythm of the grid intact.",preview:"+--------+--------+\n| post   | post   |\n+--------+--------+\n| post   | post   |\n+--------+--------+"},
    {label:"List",description:"One post per row",preview:"- Dark mode is here\n- Faster builds\n- Our new RSS feed"},
  ]},
  {header:"Extras",question:"Which extras should ship with it? Pick any that you think are worth the extra build time this sprint, keeping in mind that search needs an index rebuild and tags need a migration of the old category data.",multiSelect:true,options:[
    {label:"Search",description:"Filter posts as you type, matching titles, excerpts and tag names, with results ranked by recency and a keyboard shortcut to focus the box from anywhere on the page."},
    {label:"Tags",description:"Tag chips on each post"},
    {label:"Pagination",description:"20 posts per page"},
  ]},
  {header:"Theme",question:"Which accent color?",multiSelect:false,options:[
    {label:"Orange",description:"Matches the logo"},
    {label:"Blue",description:"Calmer, more neutral"},
    {label:"Green",description:"Stands out from the header"},
  ]},
];

// Claude Code wraps long text to the terminal width, with continuation lines indented.
function wrap(text:string,width:number,indent=""):string[] {
  const lines:string[]=[];let line="";
  for(const word of text.split(/\s+/).filter(Boolean)){
    if(line && indent.length+line.length+1+word.length>width){lines.push(indent+line);line=word;}
    else line=line?`${line} ${word}`:word;
  }
  if(line)lines.push(indent+line);
  return lines;
}

export class FakeQuestion implements QuestionTerminal {
  tab=0; cursor=0; editingNotes=false;
  checked=QUESTIONS.map(()=>new Set<number>());
  other=QUESTIONS.map(()=>"");
  otherChecked=QUESTIONS.map(()=>false);
  answers:(string|undefined)[]=QUESTIONS.map(()=>undefined);
  notes=new Map<string,string>();
  result:string|null=null;
  constructor(private done:(result:string)=>void) {}

  private q() {return QUESTIONS[this.tab];}
  private review() {return this.tab===QUESTIONS.length;}
  private hasOther(q:Q) {return !q.options.some(o=>o.preview);}
  private rows(q:Q) {return q.options.length+(this.hasOther(q)?1:0)+(q.multiSelect?1:0)+1;}
  private answered(i:number) {return QUESTIONS[i].multiSelect?this.checked[i].size>0 || this.otherChecked[i]:this.answers[i]!==undefined;}
  private finish(result:string) {this.result=result;this.done(result);}
  private advance() {this.tab=Math.min(this.tab+1,QUESTIONS.length);this.cursor=0;this.editingNotes=false;}
  private answerText(i:number) {
    const q=QUESTIONS[i];
    if(!q.multiSelect)return this.answers[i];
    const picked=[...this.checked[i]].map(j=>q.options[j].label);
    if(this.otherChecked[i] && this.other[i])picked.push(this.other[i]);
    return picked.length?picked.join(", "):undefined;
  }

  async read() {
    if(this.result)return "";
    const width=96;
    const tabs=["←",...QUESTIONS.map((q,i)=>`${this.answered(i)?"☒":"☐"} ${q.header}`),"✔ Submit","→"].join("  ");
    const out=[`${"─".repeat(width)}`,tabs,""];
    if(this.review()){
      out.push("Review your answers","");
      QUESTIONS.forEach((q,i)=>{const a=this.answerText(i);if(a)out.push(` ● ${q.question}`,`   → ${a}`);});
      out.push("","Ready to submit your answers?","",`${this.cursor===0?"❯":" "} 1. Submit answers`,`${this.cursor===1?"❯":" "} 2. Cancel`,"","");
      return out.join("\n");
    }
    const q=this.q(),t=this.tab;
    out.push(...wrap(q.question,width),"");
    const mark=(row:number)=>this.cursor===row?"❯":" ";
    const preview=q.options[this.cursor]?.preview ?? q.options.find(o=>o.preview)?.preview;
    if(q.options.some(o=>o.preview)){
      const box=(preview ?? "").split("\n");
      const inner=Math.max(...box.map(l=>l.length))+2;
      const right=[`┌${"─".repeat(inner)}┐`,...box.map(l=>`│ ${l.padEnd(inner-2)} │`),`└${"─".repeat(inner)}┘`,"",
        `Notes: ${this.notes.get(`${t}:${this.cursor}`) || (this.editingNotes?"Add notes on this design…":"press n to add notes")}`];
      const left=q.options.map((o,i)=>`${mark(i)} ${i+1}. ${o.label}`);
      for(let i=0;i<Math.max(left.length,right.length);i++)out.push(`${(left[i] ?? "").padEnd(34)}${right[i] ?? ""}`.trimEnd());
    } else {
      q.options.forEach((o,i)=>{
        out.push(`${mark(i)} ${i+1}. ${q.multiSelect?`[${this.checked[t].has(i)?"✔":" "}] `:""}${o.label}`,...wrap(o.description,width," ".repeat(q.multiSelect?9:5)));
      });
      const n=q.options.length;
      out.push(`${mark(n)} ${n+1}. ${q.multiSelect?`[${this.otherChecked[t]?"✔":" "}] `:""}${this.other[t] || (q.multiSelect?"Type something":"Type something.")}`);
      if(q.multiSelect)out.push(`${mark(n+1)}    ${t===QUESTIONS.length-1?"Submit":"Next"}`);
    }
    const chatRow=this.rows(q)-1;
    out.push("","─".repeat(width),q.options.some(o=>o.preview)?`${mark(chatRow)} Chat about this`:`${mark(chatRow)} ${q.options.length+2}. Chat about this`,"");
    const hints=["Enter to select",q.multiSelect?"Tab/Arrow keys to navigate":"↑/↓ to navigate",...(q.options.some(o=>o.preview)?["n to add notes"]:[]),...(this.editingNotes?["ctrl+g to edit in $EDITOR"]:[]),"Esc to cancel"];
    out.push(hints.join(" · "));
    return out.join("\n");
  }

  async type(input:string) {
    if(this.result)return;
    for(let rest=input;rest;){
      const paste=/^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(rest);
      if(paste){this.text(paste[1]);rest=rest.slice(paste[0].length);continue;}
      const seq=/^\x1b\[[ABCDZ]/.exec(rest)?.[0] ?? rest[0];
      rest=rest.slice(seq.length);
      this.key(seq);
      if(this.result)return;
    }
  }

  private onOther() {const q=this.q();return !!q && this.hasOther(q) && this.cursor===q.options.length;}
  private text(s:string) {
    if(this.review())return;
    if(this.editingNotes){const k=`${this.tab}:${this.cursor}`;this.notes.set(k,(this.notes.get(k) ?? "")+s);return;}
    if(this.onOther()){this.other[this.tab]+=s.replace(/\n/g," ");if(this.q().multiSelect)this.otherChecked[this.tab]=!!this.other[this.tab];}
  }
  private key(k:string) {
    const q=this.q(),t=this.tab;
    if(this.review()){
      if(k==="1" || (k==="\r" && this.cursor===0)){this.finish(QUESTIONS.map((q,i)=>`${q.header}: ${this.answerText(i) ?? "(no answer)"}`).join("\n"));}
      else if(k==="2" || k==="\x1b" || (k==="\r" && this.cursor===1))this.finish("cancelled");
      else if(k==="\x1b[A" || k==="\x1b[B")this.cursor=k==="\x1b[A"?0:1;
      else if(k==="\x1b[D"){this.tab--;this.cursor=0;}
      return;
    }
    const rows=this.rows(q),preview=q.options.some(o=>o.preview);
    if(this.editingNotes){
      if(k==="\x1b")this.editingNotes=false;
      else if(k==="\x15")this.notes.delete(`${t}:${this.cursor}`);
      else if(k==="\r")this.key2Enter();
      else if(k.length===1 && k>=" ")this.text(k);
      return;
    }
    if(k==="\x1b"){this.finish("cancelled");return;}
    if(k==="\x1b[A"){this.cursor=Math.max(0,this.cursor-1);return;}
    if(k==="\x1b[B"){this.cursor=Math.min(rows-1,this.cursor+1);return;}
    if(k==="\x1b[C" || k==="\x1b[D"){if(this.onOther())return;this.tab=Math.max(0,Math.min(QUESTIONS.length,t+(k==="\x1b[C"?1:-1)));this.cursor=0;return;}
    if(k==="\x15"){if(this.onOther()){this.other[t]="";this.otherChecked[t]=false;}return;}
    if(k==="\r"){this.key2Enter();return;}
    if(this.onOther() && k.length===1 && k>=" "){this.text(k);return;}
    if(preview && k==="n" && this.cursor<q.options.length){this.editingNotes=true;return;}
    if(/^[1-9]$/.test(k)){
      const i=Number(k)-1;
      if(preview){if(i<q.options.length)this.cursor=i;return;}
      if(i===q.options.length+1){this.finish("chat");return;}
      if(q.multiSelect){
        if(i<q.options.length){const set=this.checked[t];if(set.has(i))set.delete(i);else set.add(i);}
        else if(i===q.options.length)this.otherChecked[t]=!this.otherChecked[t];
        return;
      }
      if(i<q.options.length){this.answers[t]=q.options[i].label;this.advance();}
      else if(i===q.options.length)this.cursor=i;
    }
  }
  private key2Enter() {
    const q=this.q(),t=this.tab,n=q.options.length;
    this.editingNotes=false;
    if(this.cursor===this.rows(q)-1){this.finish("chat");return;}
    if(this.cursor<n){
      if(q.multiSelect){const set=this.checked[t];if(set.has(this.cursor))set.delete(this.cursor);else set.add(this.cursor);return;}
      const note=this.notes.get(`${t}:${this.cursor}`);
      this.answers[t]=q.options[this.cursor].label+(note?` (notes: ${note})`:"");this.advance();return;
    }
    if(this.onOther()){if(q.multiSelect)return;if(this.other[t]){this.answers[t]=this.other[t];this.advance();}return;}
    this.advance();   // Next / Submit
  }
}
