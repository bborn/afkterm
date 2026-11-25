// What hands-free mode reads aloud from one of Claude's messages: the prose, never
// code or tables, split into parts of about 20 seconds so you can stop after one.

const WORDS_PER_PART=55; // about 20 seconds at a normal speaking pace
const CODE="Followed by a code block.", TABLE="Followed by a table.";

const basename=(path:string)=>path.replace(/\/+$/,"").split("/").pop() || path;

function inlineCode(code:string) {
  if(/^[~.]?\/|\/\w/.test(code) && !/\s/.test(code))return basename(code);
  return code.length<=30?code:"";
}

export function speakable(markdown:string):string {
  const lines:string[]=[];
  let fence=false, table=false;
  for(const raw of markdown.replace(/\r/g,"").split("\n")){
    if(/^\s*(```|~~~)/.test(raw)){
      if(!fence)lines.push(CODE);
      fence=!fence;continue;
    }
    if(fence)continue;
    const isTable=/^\s*\|.*\|\s*$/.test(raw);
    if(isTable){if(!table)lines.push(TABLE);table=true;continue;}
    table=false;
    let line=raw.trim();
    if(!line){lines.push("");continue;}
    line=line.replace(/^#{1,6}\s+/,"").replace(/^>\s?/,"")
      .replace(/^[-*•]\s+(\[[ x]\]\s+)?/i,"").replace(/^(\d+)[.)]\s+/,"$1, ");
    line=line.replace(/!\[[^\]]*\]\([^)]*\)/g,"")
      .replace(/\[([^\]]+)\]\([^)]*\)/g,"$1")
      .replace(/`([^`]+)`/g,(_,code:string)=>inlineCode(code))
      .replace(/https?:\/\/\S+/g,"a link")
      .replace(/(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g,path=>basename(path))
      .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g,"$2")
      .replace(/\s+([,.;:!?])/g,"$1").replace(/\s{2,}/g," ").trim();
    // A list item or heading without its own full stop still ends a sentence when spoken.
    if(line && !/[.!?:,;]$/.test(line))line+=".";
    if(line)lines.push(line);
  }
  const text=lines.join(" ").replace(/(Followed by a (?:code block|table)\.)(\s+\1)+/g,"$1").replace(/\s+/g," ").trim();
  return text===CODE || text===TABLE?`The reply is ${text==="Followed by a code block."?"a code block":"a table"}.`:text;
}

export function speechSentences(markdown:string):string[] {
  const text=speakable(markdown);
  if(!text)return [];
  return text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(s=>s.trim()).filter(Boolean) ?? [text];
}
const words=(s:string)=>s.split(/\s+/).length;

// Sentences grouped into parts of about 20 seconds each.
export function groupParts(sentences:string[]):string[] {
  const parts:string[]=[];let part:string[]=[],n=0;
  for(const sentence of sentences){
    if(part.length && n+words(sentence)>WORDS_PER_PART){parts.push(part.join(" "));part=[];n=0;}
    part.push(sentence);n+=words(sentence);
  }
  if(part.length)parts.push(part.join(" "));
  return parts;
}
export const speechParts=(markdown:string)=>groupParts(speechSentences(markdown));

// Claude's updates while it works, a sentence or two each; its last message in full.
const UPDATE_WORDS=35;
export interface SpeechState {spoken:Map<string,number>;finished:Set<string>}
export interface Speech {id:string;sentences:string[];final:boolean}
export function newSpeech(messages:{id:string;role:string;text:string}[],finalId:string|null,state:SpeechState):Speech[] {
  const out:Speech[]=[];
  for(const m of messages){
    if(m.role!=="assistant" || state.finished.has(m.id))continue;
    const sentences=speechSentences(m.text);
    if(m.id===finalId){
      // The rest of it, if its start was already read as an update.
      out.push({id:m.id,sentences:sentences.slice(state.spoken.get(m.id) ?? 0),final:true});
      state.finished.add(m.id);
    } else if(!state.spoken.has(m.id)){
      const update:string[]=[];
      for(const s of sentences){if(update.length && update.reduce((n,x)=>n+words(x),0)+words(s)>UPDATE_WORDS)break;update.push(s);}
      out.push({id:m.id,sentences:update,final:false});
      state.spoken.set(m.id,update.length);
    }
  }
  // Behind on updates, only the latest is worth hearing.
  const updates=out.filter(s=>!s.final);
  return out.filter(s=>s.final || s===updates.at(-1)).filter(s=>s.sentences.length || s.final);
}

const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu," ").replace(/\s+/g," ").trim();

// Whisper writes these for a clip with no speech in it.
const NOISE=/^(?:you|thank you|thanks|thanks for watching|thank you for watching|bye|hmm|uh|um|music|silence|blank audio)?$/;
export const heardNothing=(text:string)=>NOISE.test(normalize(text)) || /^[\[(].*[\])]$/.test(text.trim());

export type Command="stop"|"repeat"|"exit"|"more"|"no-more";
// A short spoken command, or null for something to send to Claude.
export function command(text:string,offeringMore:boolean):Command|null {
  const t=normalize(text).replace(/^(?:hey |ok |okay |please )/,"").replace(/ please$/,"");
  if(/^(?:stop|stop claude|stop it|interrupt|escape)$/.test(t))return "stop";
  if(/^(?:repeat|repeat that|say that again|what did you say|come again)$/.test(t))return "repeat";
  if(/^(?:exit|exit hands free|stop hands free|end hands free|hands free off|turn off hands free)$/.test(t))return "exit";
  if(offeringMore){
    if(/^(?:yes|yeah|yep|yup|sure|more|keep going|go on|go ahead|continue|read more|read it|ok|okay)$/.test(t))return "more";
    if(/^(?:no|nope|no thanks|that's enough|enough|skip|skip it)$/.test(t))return "no-more";
  }
  return null;
}
