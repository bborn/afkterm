// Attachments as small tiles: a thumbnail for images, a file icon with its type for
// everything else. Used for what you're about to send and for what you sent.

type Kind="image"|"pdf"|"video"|"audio"|"code"|"text"|"sheet"|"doc"|"archive"|"file";
const KINDS:[RegExp,Kind][]=[
  [/\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|svg|tiff?)$/i,"image"],
  [/\.pdf$/i,"pdf"],
  [/\.(mov|mp4|m4v|webm|avi|mkv)$/i,"video"],
  [/\.(mp3|m4a|wav|aac|flac|ogg|opus|caf)$/i,"audio"],
  [/\.(csv|tsv|xlsx?|numbers)$/i,"sheet"],
  [/\.(docx?|pages|rtf|key|pptx?)$/i,"doc"],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg)$/i,"archive"],
  [/\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|html?|css|scss|json|ya?ml|toml|xml|lua|ex|exs|erb)$/i,"code"],
  [/\.(txt|md|markdown|log|ini|conf)$/i,"text"],
];
export const kindOf=(name:string):Kind=>KINDS.find(([re])=>re.test(name))?.[1] ?? "file";
const extOf=(name:string)=>/\.([^./]{1,5})$/.exec(name)?.[1].toUpperCase() ?? "";

function FileIcon({name}:{name:string}) {
  const kind=kindOf(name);
  return <span className="file-icon" data-kind={kind} aria-hidden="true">
    <svg viewBox="0 0 24 30" width="24" height="30"><path d="M3 1h12l6 6v20a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="currentColor" opacity=".18"/><path d="M15 1v6h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M3 1h12l6 6v20a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
    <span className="file-ext">{extOf(name) || "FILE"}</span>
  </span>;
}

export type TileState="uploading"|"ready"|"error";

// One attachment. `src` is a thumbnail for images (a local copy before sending,
// the Mac's file after). Tapping opens it when `open` is given.
export function AttachmentTile({name,src,state="ready",error,open,remove}:{name:string;src?:string;state?:TileState;error?:string;open?:()=>void;remove?:()=>void}) {
  const image=!!src;
  const body=image
    ?<img className="tile-thumb" src={src} alt="" draggable={false} />
    :<><FileIcon name={name} /><span className="tile-name">{name}</span></>;
  return <span className="tile" data-image={image || undefined} data-state={state} title={error || name}>
    {open?<button type="button" className="tile-body" aria-label={`Open ${name}`} onClick={open}>{body}</button>:<span className="tile-body" aria-label={name}>{body}</span>}
    {state==="uploading" && <span className="tile-spinner" aria-label="Uploading" />}
    {state==="error" && <span className="tile-error" aria-label={error || "Upload failed"}>!</span>}
    {remove && <button type="button" className="tile-remove" aria-label={`Remove ${name}`} onClick={remove}>×</button>}
  </span>;
}

// "Attached file: <path>" lines that afkterm adds when it sends files to Claude,
// and the "📎 name" lines of a message that's still on its way.
const ATTACHED=/^(?:Attached file: (\/\S.*)|📎 (.+))$/;
export function splitAttachments(text:string):{text:string;files:{path?:string;name:string}[]} {
  const files:{path?:string;name:string}[]=[];
  const rest=text.split("\n").filter(line=>{
    const m=ATTACHED.exec(line.trim());
    if(!m)return true;
    if(m[1]){
      // Saved as <upload id>-<name>; show the name you picked.
      const file=m[1].split("/").at(-1) ?? m[1];
      files.push({path:m[1],name:file.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,"")});
    } else files.push({name:m[2]});
    return false;
  });
  return {text:rest.join("\n").trim(),files};
}

// Pasted and dragged images often come as "image.png" or with no name at all.
// Give them a name you can tell apart in the chat and on the Mac.
const EXT:Record<string,string>={"image/png":"png","image/jpeg":"jpg","image/heic":"heic","image/gif":"gif","image/webp":"webp","application/pdf":"pdf","video/quicktime":"mov","video/mp4":"mp4"};
export function namedFile(file:File,now=new Date()):File {
  if(file.name && !/^image\.\w+$/i.test(file.name))return file;
  const ext=/\.(\w+)$/.exec(file.name)?.[1] ?? EXT[file.type] ?? file.type.split("/")[1]?.replace(/\W/g,"") ?? "bin";
  const p=(n:number)=>String(n).padStart(2,"0");
  const stamp=`${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())} at ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
  const kind=file.type.startsWith("image/")?"Screenshot":"File";
  return new File([file],`${kind} ${stamp}.${ext}`,{type:file.type,lastModified:file.lastModified});
}

// What a drag carries, so the page knows whether to offer a drop.
export const draggingFiles=(e:DragEvent)=>!!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
