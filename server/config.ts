import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseLogins } from "./auth";

export const CONFIG_DIR=join(homedir(),".afkterm");
export const CONFIG_FILE=join(CONFIG_DIR,"config.json");
export const LOG_FILE=join(homedir(),"Library","Logs","afkterm.log");

// afkterm was called iterm-web. Move its folder (config, device secret,
// attachments, voice models) over once, and leave a link at the old path.
// The CLI calls this before anything else reads the folder.
export function migrateLegacyHome(legacy=join(homedir(),".iterm-web"),current=CONFIG_DIR) {
  try {
    if(existsSync(current) || !existsSync(legacy) || lstatSync(legacy).isSymbolicLink())return false;
    renameSync(legacy,current);
    symlinkSync(current,legacy);
    return true;
  } catch {return false;} // Keep going; setup writes a fresh config if it must.
}

// AFKTERM_<NAME>, or the ITERM_WEB_<NAME> it replaced.
export const envVar=(name:string)=>process.env[`AFKTERM_${name}`] || process.env[`ITERM_WEB_${name}`] || undefined;

const schema=z.object({
  allowedLogins:z.array(z.string()).default([]),
  port:z.number().int().min(1024).max(65535).default(47823),
  httpsPort:z.number().int().min(1).max(65535).default(9443),
  key:z.string().optional(),          // device secret, shared with paired phones
  publicHost:z.string().optional(),   // <machine>.<tailnet>.ts.net:<httpsPort>
  backend:z.enum(["iterm","herdr"]).default("iterm"),  // which terminal app to drive
});
export type Config=z.infer<typeof schema>;

// ~/.afkterm/config.json, written by `afkterm setup`. Environment variables
// (AFKTERM_ALLOWED_LOGINS, AFKTERM_PORT, AFKTERM_BACKEND) override it.
export function loadConfig():Config {
  let file:unknown={};
  try {file=JSON.parse(readFileSync(CONFIG_FILE,"utf8"));} catch { /* No config yet. */ }
  const config=schema.parse(file);
  const logins=envVar("ALLOWED_LOGINS");
  if(logins)config.allowedLogins=[...parseLogins(logins)];
  if(envVar("PORT"))config.port=Number(envVar("PORT"));
  if(envVar("BACKEND"))config.backend=envVar("BACKEND") as Config["backend"];
  return schema.parse(config);
}

// Host headers the server accepts: its tailnet name, and loopback for the CLI.
export function allowedHosts(config:Config) {
  const hosts=new Set([`127.0.0.1:${config.port}`,`localhost:${config.port}`]);
  if(config.publicHost){
    hosts.add(config.publicHost.toLowerCase());
    if(config.publicHost.endsWith(":443"))hosts.add(config.publicHost.slice(0,-4).toLowerCase());
  }
  return hosts;
}

export function saveConfig(config:Config) {
  mkdirSync(CONFIG_DIR,{recursive:true,mode:0o700});
  chmodSync(CONFIG_DIR,0o700);
  writeFileSync(CONFIG_FILE,JSON.stringify(schema.parse(config),null,2)+"\n",{mode:0o600});
  chmodSync(CONFIG_FILE,0o600);   // the file holds the device secret
}
