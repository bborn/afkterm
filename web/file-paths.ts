// Finding file paths in Claude's text: absolute, ~/..., ./ and ../, folder/file,
// or a bare name with an extension, each with an optional :line(:column).
// Candidates are only guesses; the server says which ones exist.
export interface PathRef { raw:string; path:string; line?:number }

const SEG="\\.?[\\w@+-][\\w@+.-]*";
// Not preceded by anything that would make it part of a URL or a longer word.
const PATH=new RegExp(`(?<![\\w:/.~@%-])((?:~|\\.{1,2})?/?(?:${SEG}/)*${SEG}/?|~/?|\\.{1,2}/)(?::(\\d+)(?::\\d+)?)?`,"g");
const EXT=/\.[a-z][a-z0-9]{0,9}$/i;

function ref(raw:string,path:string,line?:string):PathRef|null {
  if(path.length<2 || path.length>1024)return null;
  // A bare word needs a slash or an extension to look like a file.
  if(!path.includes("/") && !EXT.test(path))return null;
  if(/^\/\//.test(path) || /^\d+(\.\d+)*$/.test(path))return null;
  return {raw,path,line:line?Number(line):undefined};
}

// Text split into plain strings and path candidates, in order.
export function splitPaths(text:string):(string|PathRef)[] {
  const out:(string|PathRef)[]=[];let last=0;
  for(const m of text.matchAll(PATH)){
    let [raw,path,line]=m;
    // Sentence punctuation after a path isn't part of it ("see app.ts.").
    if(!line){const trimmed=path.replace(/[.]+$/,"");raw=raw.slice(0,raw.length-(path.length-trimmed.length));path=trimmed;}
    const r=ref(raw,path,line);
    if(!r)continue;
    if(m.index>last)out.push(text.slice(last,m.index));
    out.push(r);last=m.index+raw.length;
  }
  if(last<text.length)out.push(text.slice(last));
  return out;
}

// The whole string as one path ("src/app.ts:12" in an inline code span), or null.
export function wholePath(text:string):PathRef|null {
  const parts=splitPaths(text.trim());
  return parts.length===1 && typeof parts[0]!=="string"?parts[0]:null;
}

// Every candidate path in a Markdown message, skipping fenced code blocks.
export function pathsIn(markdown:string):string[] {
  const text=markdown.replace(/```[\s\S]*?(```|$)/g," ");
  return [...new Set(splitPaths(text).flatMap(p=>typeof p==="string"?[]:[p.path]))];
}
