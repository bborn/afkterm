import type { Question, QuestionAnswer } from "./contract";

// Claude Code's AskUserQuestion dialog, read from the screen and answered with keys.
//
// The dialog looks like this (one tab per question, then a review tab):
//
//   ←  ☐ Color  ☐ Toppings  ✔ Submit  →
//   Which toppings?
//   ❯ 1. [ ] Cheese            ← multiSelect rows carry a checkbox
//          dairy
//     2. [✔] Olives
//     3. [ ] Type something    ← the free-text ("Other") row; typing into it checks it
//        Submit                ← multiSelect only: "Next" until the last question
//   ─────────────
//     4. Chat about this
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// Single-select questions answer with the option's number. Questions with option
// previews show the focused option's preview in a box on the right and offer notes
// ("n"); there the number only moves the cursor and Enter selects. ↑/↓ move through
// options, the free-text row, Next/Submit and Chat about this, in that order.

const OPTION=/^\s*(❯)?\s*(\d+)[.)]\s+(?:\[(.)\]\s+)?(.*?)\s*$/;
const ACTION_ROW=/^\s*(❯)?\s*(Submit|Next)\s*$/;
const CHAT_ROW=/^\s*(❯)?\s*(?:(\d+)[.)]\s+)?Chat about this\s*$/;
const SEPARATOR=/^\s*[─━]{8,}\s*$/;
const TAB=/^([☐☒✔])\s+(.+)$/;
const CHECKED=new Set(["✔","✓","x","X","☒","■","●"]);
const FREE_TEXT_PLACEHOLDER=/^Type something\.?$/;

function tabsLine(line:string) {
  if(!/^\s*(?:←\s+)?[☐☒✔]\s+\S/.test(line))return undefined;
  const tokens=line.replace(/^\s*←\s*/,"").replace(/\s*→\s*$/,"").trim().split(/\s{2,}/);
  const tabs=tokens.map(t=>TAB.exec(t.trim()));
  if(!tabs.length || tabs.some(t=>!t))return undefined;
  return tabs.map(t=>({mark:t![1],label:t![2].trim()}));
}

// Question text sits in a bordered block on some screens ("│ Which database…").
const unborder=(line:string)=>line.replace(/^\s*[│┃|]\s?/,"").trimEnd();
const paragraph=(lines:string[])=>{
  const out=lines.map(unborder);
  while(out.length && !out[0].trim())out.shift();
  while(out.length && !out.at(-1)!.trim())out.pop();
  return out.map(l=>l.replace(/^\s+/,"")).join("\n").slice(0,2000);
};

export function claudeQuestion(screen:string):Question|undefined {
  const lines=screen.split("\n").slice(-90).map(l=>l.trimEnd());
  let last=lines.length-1;
  while(last>=0 && !lines[last].trim())last--;
  // The key hints close the dialog; on narrow terminals they wrap onto a second line.
  let footer=-1;
  for(let i=last;i>=0 && last-i<4;i--)if(/Enter to (?:select|confirm)/i.test(lines[i])){footer=i;break;}
  if(footer<0){
    // The review tab has no key hints: it ends with "1. Submit answers / 2. Cancel".
    const tail=lines.slice(Math.max(0,last-30),last+1).join("\n");
    if(!/Review your answers/.test(tail) || !/^\s*(?:❯\s*)?\d[.)]\s+Submit answers\s*$/m.test(tail))return undefined;
    footer=last+1;
  }
  else if(!/Esc to cancel/i.test(lines.slice(footer,last+1).join(" ")))return undefined;
  let header=-1,tabs:ReturnType<typeof tabsLine>;
  for(let i=footer-1;i>=0 && footer-i<75;i--){tabs=tabsLine(lines[i]);if(tabs){header=i;break;}}
  if(header<0 || !tabs)return undefined;
  const editing=/ctrl\+g to edit/i.test(lines.slice(footer,last+1).join(" "));
  const questionTabs=tabs.filter(t=>!(t.mark==="✔" && t.label==="Submit")).map(t=>({label:t.label.slice(0,100),answered:t.mark!=="☐"}));
  const submitTab=questionTabs.length<tabs.length;
  const body=lines.slice(header+1,footer);

  const firstOption=body.findLastIndex(l=>/^\s*(?:❯\s*)?1[.)]\s+\S/.test(l));
  if(firstOption<0)return undefined;
  let separator=body.findIndex((l,i)=>i>firstOption && SEPARATOR.test(l));
  if(separator<0)separator=body.length;

  // Option previews draw a box to the right of the options; split it off by column.
  const boxColumn=(()=>{
    for(const line of body.slice(firstOption,separator)){
      const col=line.indexOf("┌");
      if(col>8 && /\s{2,}$/.test(line.slice(0,col)))return col;
    }
    return -1;
  })();
  const left=body.slice(firstOption,separator).map(l=>boxColumn>0?l.slice(0,boxColumn).trimEnd():l);
  const right=boxColumn>0?body.slice(firstOption,separator).map(l=>l.slice(boxColumn).trimEnd()):[];

  type Row={kind:"numbered";key:string;cursor:boolean;box?:string;label:string;detail:string[]}|{kind:"action";label:"Submit"|"Next";cursor:boolean};
  const rows:Row[]=[];
  for(const line of left){
    let m=OPTION.exec(line);
    if(m){rows.push({kind:"numbered",key:m[2],cursor:!!m[1],box:m[3],label:m[4],detail:[]});continue;}
    m=ACTION_ROW.exec(line);
    if(m){rows.push({kind:"action",label:m[2] as "Submit"|"Next",cursor:!!m[1]});continue;}
    const prev=rows.at(-1);
    if(line.trim() && prev?.kind==="numbered")prev.detail.push(line.trim());
  }
  const numbered=rows.filter(r=>r.kind==="numbered");
  if(numbered.some((r,i)=>r.key!==String(i+1)))return undefined;
  const action=rows.find(r=>r.kind==="action");
  let chat:{key?:string;cursor:boolean}|undefined;
  for(const line of body.slice(separator+1)){const m=CHAT_ROW.exec(line);if(m)chat={key:m[2],cursor:!!m[1]};}

  // The review tab: "Review your answers", the answers so far, then Submit answers / Cancel.
  const reviewAt=body.slice(0,firstOption).findIndex(l=>/^\s*Review your answers\s*$/.test(l));
  if(reviewAt>=0){
    const answers:{question:string;answer:string}[]=[];
    const notes:string[]=[];
    for(const line of body.slice(reviewAt+1,firstOption).map(l=>l.trim()).filter(Boolean)){
      let m=/^●\s*(.+)$/.exec(line);
      if(m){answers.push({question:m[1],answer:""});continue;}
      m=/^→\s*(.*)$/.exec(line);
      if(m && answers.length){const a=answers.at(-1)!;a.answer=a.answer?`${a.answer}\n${m[1]}`:m[1];continue;}
      notes.push(line);
    }
    return {tabs:questionTabs,submitTab,prompt:"Review your answers",multiSelect:false,
      options:numbered.map(r=>({key:r.key,label:r.label.slice(0,300),checked:false})),
      cursor:numbered.findIndex(r=>r.cursor)>=0?`option:${numbered.findIndex(r=>r.cursor)}`:null,
      review:{answers:answers.slice(0,20),message:notes.join("\n").slice(0,1000)}};
  }

  const preview=boxColumn>0;
  const multiSelect=numbered.some(r=>r.box!==undefined);
  // Claude adds a free-text row as the last numbered option, except on preview questions.
  const otherRow=!preview && numbered.length>2?numbered.at(-1):undefined;
  const options=numbered.filter(r=>r!==otherRow);
  if(options.length<2)return undefined;

  let previewText:string|undefined;
  let notes:{text:string;editing:boolean}|undefined;
  if(preview){
    const top=right.findIndex(l=>l.startsWith("┌"));
    const bottom=right.findIndex((l,i)=>i>top && l.startsWith("└"));
    if(top>=0)previewText=right.slice(top+1,bottom<0?undefined:bottom).map(l=>l.replace(/^│ ?/,"").replace(/ ?│$/,"").trimEnd()).join("\n").replace(/\n+$/,"").slice(0,8000);
    const noteLine=right.map(l=>/^\s*Notes:\s*(.*)$/.exec(l)).find(Boolean);
    if(noteLine){
      const raw=noteLine[1].trim();
      // The placeholder is cut short ("Add notes on this desig…") on narrow terminals.
      const placeholder=/^press n to add notes$/i.test(raw) || /^Add notes on th/i.test(raw);
      notes={text:placeholder?"":raw.slice(0,2000),editing:editing || /^Add notes on this design/i.test(raw)};
    }
  }

  const cursorIndex=options.findIndex(r=>r.cursor);
  const cursor=chat?.cursor?"chat"
    :otherRow?.cursor?"other"
    :action?.kind==="action" && action.cursor?"submit"
    :cursorIndex>=0?`option:${cursorIndex}`:null;
  const otherText=otherRow && !FREE_TEXT_PLACEHOLDER.test(otherRow.label)?otherRow.label:"";
  return {
    tabs:questionTabs,submitTab,
    prompt:paragraph(body.slice(0,firstOption)),
    multiSelect,
    options:options.map(r=>({key:r.key,label:r.label.slice(0,300),...(r.detail.length?{detail:r.detail.join(" ").slice(0,600)}:{}),checked:r.box!==undefined && CHECKED.has(r.box)})),
    ...(otherRow?{other:{key:otherRow.key,text:otherText.slice(0,4000),checked:multiSelect?otherRow.box!==undefined && CHECKED.has(otherRow.box):!!otherText}}:{}),
    ...(action?.kind==="action"?{submit:action.label}:{}),
    ...(chat?{chat:chat.key?{key:chat.key}:{}}:{}),
    cursor,
    ...(previewText!==undefined?{preview:previewText}:{}),
    ...(notes?{notes}:{}),
  };
}

// Rows in the order ↑/↓ visit them.
function rowOrder(q:Question) {
  return [...q.options.map((_,i)=>`option:${i}`),...(q.other?["other"]:[]),...(q.submit?["submit"]:[]),...(q.chat?["chat"]:[])];
}

export interface QuestionTerminal {
  read():Promise<string>;
  type(text:string):Promise<void>;
}

const KEY={up:"\x1b[A",down:"\x1b[B",left:"\x1b[D",right:"\x1b[C",enter:"\r",escape:"\x1b",clearLine:"\x15"};
const paste=(text:string)=>`\x1b[200~${text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g,"")}\x1b[201~`;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

export class QuestionError extends Error {}

// Re-read the screen until the dialog reaches the expected state.
async function settle(t:QuestionTerminal,done:(q:Question|undefined)=>boolean,timeout=2000) {
  const end=Date.now()+timeout;
  for(;;){
    const q=claudeQuestion(await t.read());
    if(done(q))return q;
    if(Date.now()>end)throw new QuestionError("Claude's question didn't respond to the keys. Check the terminal view.");
    await sleep(60);
  }
}

async function moveTo(t:QuestionTerminal,q:Question,target:string):Promise<Question> {
  if(q.cursor===target)return q;
  const order=rowOrder(q);
  const from=order.indexOf(q.cursor ?? ""),to=order.indexOf(target);
  if(to<0)throw new QuestionError("That choice isn't on screen any more.");
  if(from<0)throw new QuestionError("Couldn't find the cursor in Claude's question. Check the terminal view.");
  const delta=to-from;
  await t.type((delta>0?KEY.down:KEY.up).repeat(Math.abs(delta)));
  const moved=await settle(t,n=>!n || n.prompt!==q.prompt || n.cursor===target);
  if(!moved || moved.prompt!==q.prompt)throw new QuestionError("Claude's question changed. Check the terminal view.");
  return moved;
}

// Digits and arrows type into the free-text row while it has the cursor, so step off it first.
async function leaveFreeText(t:QuestionTerminal,q:Question) {
  if(q.cursor!=="other")return q;
  return moveTo(t,q,q.options.length?`option:${q.options.length-1}`:"submit");
}

async function typeFreeText(t:QuestionTerminal,q:Question,text:string) {
  if(!q.other)throw new QuestionError("This question has no free-text answer.");
  q=await moveTo(t,q,"other");
  await t.type(KEY.clearLine+(text?paste(text):""));
  const want=text.replace(/\s+/g," ").trim().slice(0,20);
  return settle(t,n=>!n || n.prompt!==q.prompt || !want || !!n.other?.text.replace(/\s+/g," ").includes(want),1500).catch(()=>q);
}

// Answer the question on screen. `prompt` guards against a tap meant for a question
// that has since changed.
export async function answerQuestion(t:QuestionTerminal,prompt:string,answer:QuestionAnswer):Promise<void> {
  let q=claudeQuestion(await t.read());
  if(!q)throw new QuestionError("Claude isn't asking a question any more.");
  if(q.prompt!==prompt)throw new QuestionError("Claude's question changed. Check the latest one.");
  if(answer.op==="cancel"){
    // Esc first leaves the notes field, if it's open.
    if(q.notes?.editing)await t.type(KEY.escape);
    return t.type(KEY.escape);
  }
  if(answer.op==="submit"){
    if(!q.review)throw new QuestionError("Answer every question before submitting.");
    const i=q.options.findIndex(o=>/^Submit/i.test(o.label));
    if(i<0)throw new QuestionError("Couldn't find Submit answers.");
    return t.type(q.options[i].key);
  }
  if(answer.op==="tab"){
    if(!q.tabs.length || (q.tabs.length<2 && !q.submitTab))throw new QuestionError("There's only one question.");
    q=await leaveFreeText(t,q);
    return t.type(answer.direction<0?KEY.left:KEY.right);
  }
  if(answer.op==="chat"){
    if(!q.chat)throw new QuestionError("Chat about this isn't offered here.");
    q=await moveTo(t,q,"chat");
    return t.type(KEY.enter);
  }
  if(q.review)throw new QuestionError("Submit or go back to change an answer.");
  const option=(index:number)=>{const o=q!.options[index];if(!o)throw new QuestionError("That choice isn't on screen any more.");return o;};
  switch(answer.op){
    case "focus":
      await moveTo(t,q,`option:${answer.index}`);return;
    case "toggle":
      if(!q.multiSelect)throw new QuestionError("This question takes one answer.");
      q=await leaveFreeText(t,q);
      return t.type(option(answer.index).key);
    case "select": {
      if(q.multiSelect)throw new QuestionError("This question takes several answers; use Submit.");
      const o=option(answer.index);
      const notes=answer.notes?.trim();
      if(q.preview===undefined && q.notes===undefined && !notes){
        q=await leaveFreeText(t,q);
        return t.type(o.key);
      }
      q=await moveTo(t,q,`option:${answer.index}`);
      if(notes!==undefined && q.notes && notes!==q.notes.text){
        await t.type("n");
        await settle(t,n=>!!n?.notes?.editing,600).catch(()=>q);
        await t.type(KEY.clearLine+(notes?paste(notes):""));
        await sleep(150);
      }
      return t.type(KEY.enter);
    }
    case "other": {
      const text=answer.text.trim();
      if(!text)throw new QuestionError("Type an answer first.");
      q=await typeFreeText(t,q,text);
      if(!q || q.multiSelect)return;
      return t.type(KEY.enter);
    }
    case "next": {
      if(!q.multiSelect || !q.submit)throw new QuestionError("Pick an option to answer this question.");
      // The client sends its free-text box with Submit; an emptied box clears the answer.
      const text=answer.other?.trim();
      if(text!==undefined && q.other && text!==q.other.text){
        const typed=await typeFreeText(t,q,text);
        if(!typed || typed.prompt!==q.prompt)throw new QuestionError("Claude's question changed. Check the terminal view.");
        q=typed;
      }
      q=await moveTo(t,q,"submit");
      return t.type(KEY.enter);
    }
  }
}
