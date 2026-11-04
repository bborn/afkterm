import { mkdir, writeFile, stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Upload } from "./contract";
import { CONFIG_DIR } from "./config";

export const MAX_UPLOAD_BYTES=20*1024*1024;
export const uploadRoot=()=>join(CONFIG_DIR,"attachments");
let lastCleanup=0;

export function uploadPath(sessionId:string,upload:Upload,root=uploadRoot()) {
  const session=createHash("sha256").update(sessionId).digest("hex").slice(0,24);
  const name=upload.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-120)||"attachment";
  return join(root,session,`${upload.uploadId}-${name}`);
}

// Files land on the Mac so Claude can read them by path. Copies expire after a week.
export async function saveUpload(sessionId:string,name:string,bytes:Buffer,root=uploadRoot()):Promise<Upload> {
  if(bytes.length>MAX_UPLOAD_BYTES)throw Error("Each attachment must be at most 20 MiB.");
  const upload={uploadId:randomUUID(),name:name.slice(0,255)||"attachment"};
  const path=uploadPath(sessionId,upload,root);
  await mkdir(join(path,".."),{recursive:true,mode:0o700});
  await writeFile(path,bytes,{flag:"wx",mode:0o600});
  if(Date.now()-lastCleanup>3600000){
    lastCleanup=Date.now();
    for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()){
      for(const file of await readdir(join(root,entry.name))){
        const old=join(root,entry.name,file);
        try {if((await stat(old)).mtimeMs<Date.now()-7*86400000)await rm(old);}catch{}
      }
    }
  }
  return upload;
}
