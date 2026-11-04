import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newKey, parseLogins } from "./auth";
import { allowedHosts, CONFIG_FILE, LOG_FILE, loadConfig, migrateLegacyHome, saveConfig, type Config } from "./config";

const VERSION="0.2.0";
const HELP=`afkterm ${VERSION}: your iTerm2 or Herdr terminals and Claude Code sessions, on your phone.

Usage:
  afkterm setup [--login <tailscale-login>] [--https-port <port>] [--port <port>]
                  [--backend iterm|herdr]
      Check requirements, install the login agent and publish it on your tailnet.
      --backend herdr shows your Herdr terminals instead of iTerm2's.
  afkterm pair [--reset]
      Show a code and QR link to connect a phone. --reset signs out every
      paired device first.
  afkterm doctor      Check requirements without changing anything.
  afkterm status      Show whether it's running and where.
  afkterm restart     Restart the background server (e.g. after upgrading).
  afkterm logs        Show recent log output.
  afkterm uninstall   Remove the login agent and stop serving it on the tailnet.
  afkterm start [--demo]
      Run the server in the foreground. --demo serves made-up sessions on
      http://127.0.0.1:<port> with no Tailscale needed.
`;

type Flags={login:string[];port?:number;httpsPort?:number;demo:boolean;reset:boolean;backend?:Config["backend"]};
function parse(argv:string[]):{command:string;flags:Flags} {
  const flags:Flags={login:[],demo:false,reset:false};
  const [command="help",...rest]=argv;
  const number=(value:string|undefined,name:string)=>{const n=Number(value);if(!Number.isInteger(n) || n<1 || n>65535)throw new Error(`${name} needs a port number.`);return n;};
  for(let i=0;i<rest.length;i++){
    const arg=rest[i];
    if(arg==="--login")flags.login.push(...parseLogins(rest[++i]));
    else if(arg==="--port")flags.port=number(rest[++i],"--port");
    else if(arg==="--https-port")flags.httpsPort=number(rest[++i],"--https-port");
    else if(arg==="--demo")flags.demo=true;
    else if(arg==="--backend"){
      const value=rest[++i];
      if(value!=="iterm" && value!=="herdr")throw new Error("--backend needs iterm or herdr.");
      flags.backend=value;
    }
    else if(arg==="--reset")flags.reset=true;
    else throw new Error(`Unknown option ${arg}\n\n${HELP}`);
  }
  return {command,flags};
}

const mark=(ok:boolean,fatal?:boolean)=>ok?"\x1b[32m✓\x1b[0m":fatal?"\x1b[31m✗\x1b[0m":"\x1b[33m!\x1b[0m";
const say=(s="")=>process.stdout.write(s+"\n");
// `afkterm status | head` closes the pipe early; that's not an error.
process.stdout.on("error",error=>{if((error as NodeJS.ErrnoException).code==="EPIPE")process.exit(0);throw error;});

// Ask the running server for a one-time code and show it with a QR link.
async function pair(config:Config) {
  const setup=await import("./setup");
  const {code}=await setup.local(config,"/api/pair-code",{method:"POST"}) as {code:string};
  const url=`https://${config.publicHost}/#pair=${code}`;
  say(`\nOn your phone (connected to your tailnet), open:\n\n  ${url}\n`);
  try {const qr=(await import("qrcode-terminal")).default;qr.generate(url,{small:true},(text:string)=>say(text));} catch { /* QR is a nicety. */ }
  say(`Or open https://${config.publicHost} and enter the code ${code.slice(0,3)} ${code.slice(3)}. It expires in 10 minutes.`);
  say("Then use Share → Add to Home Screen.");
}

async function main() {
  const {command,flags}=parse(process.argv.slice(2));
  migrateLegacyHome();
  const config:Config={...loadConfig()};
  if(flags.port)config.port=flags.port;
  if(flags.httpsPort)config.httpsPort=flags.httpsPort;
  if(flags.backend)config.backend=flags.backend;

  if(command==="help" || command==="--help" || command==="-h"){say(HELP);return;}
  if(command==="--version" || command==="version"){say(VERSION);return;}

  if(command==="start"){
    const {startServer}=await import("./index");
    const logins=flags.login.length?flags.login:config.allowedLogins;
    await startServer({port:config.port,fake:flags.demo,terminals:config.backend,auth:flags.demo
      ?{allowedLogins:new Set(logins.map(l=>l.toLowerCase())),allowLocal:true}
      :{allowedLogins:new Set(logins.map(l=>l.toLowerCase())),allowLocal:false,key:config.key,hosts:allowedHosts(config)}});
    return;
  }

  const setup=await import("./setup");

  if(command==="doctor" || command==="setup"){
    const result=await setup.checks(config);
    for(const c of result.checks)say(`${mark(c.ok,c.fatal)} ${c.name.padEnd(22)} ${c.detail}`);
    const fatal=result.checks.filter(c=>!c.ok && c.fatal);
    if(command==="doctor" || fatal.length){
      if(fatal.length){say("\nFix the items marked ✗, then run this again.");process.exitCode=1;}
      return;
    }
    const cli=fileURLToPath(import.meta.url);
    if(cli.endsWith(".ts"))throw new Error("Run setup from the built package (npm run build, then node dist/cli.js setup).");
    if(cli.includes("/_npx/"))throw new Error("Install afkterm first so the login agent has a stable path:\n  npm install -g afkterm\n  afkterm setup");
    const logins=flags.login.length?flags.login:config.allowedLogins.length?config.allowedLogins:[result.tailscale!.login];
    if(!logins[0])throw new Error("Couldn't tell which Tailscale login to allow. Pass --login you@example.com.");
    config.allowedLogins=logins;
    config.key??=newKey();
    config.publicHost=`${result.tailscale!.dnsName}:${config.httpsPort}`;
    saveConfig(config);
    setup.writeAgent(cli);
    await setup.loadAgent();
    await setup.enableServe(result.bin!,config.httpsPort,config.port);
    say(`\nAllowed login: ${logins.join(", ")}  (config: ${CONFIG_FILE})`);
    // The background server may need its own Automation approval the first time.
    let ok=false;
    for(let i=0;i<20 && !ok;i++){ok=(await setup.health(config)).ok;if(!ok)await new Promise(r=>setTimeout(r,500));}
    if(!ok){say(`\n${mark(false,true)} The server didn't start. See ${LOG_FILE}`);process.exitCode=1;return;}
    const sessions=await setup.local(config,"/api/sessions").then(()=>null,(e:Error)=>e.message);
    if(sessions)say(config.backend==="herdr"
      ?`\n${mark(false)} The server is running but can't read Herdr yet: ${sessions}`
      :`\n${mark(false)} The server is running but can't read iTerm2 yet: ${sessions}\n  If macOS asked whether "node" may control iTerm2, click OK, then run: afkterm restart`);
    say(`\n${mark(true)} afkterm is running at https://${config.publicHost}`);
    await pair(config);
    return;
  }

  if(command==="pair"){
    if(!config.key || !config.publicHost)throw new Error("Run `afkterm setup` first.");
    if(flags.reset){
      config.key=newKey();saveConfig(config);
      await setup.restartAgent();
      for(let i=0;i<20 && !(await setup.health(config)).ok;i++)await new Promise(r=>setTimeout(r,500));
      say("Signed out every paired device.");
    }
    await pair(config);
    return;
  }

  if(command==="status"){
    say(`Background server: ${await setup.agentState()}`);
    const h=await setup.health(config);
    say(`Local server:      ${h.ok?"responding":h.detail} (http://127.0.0.1:${config.port})`);
    const bin=await setup.tailscaleBinary();
    if(bin){
      const ts=await setup.tailscaleState(bin).catch(()=>null);
      if(ts?.dnsName){
        const serve=await setup.serveState(bin,ts.dnsName,config.httpsPort);
        say(`Tailscale:         ${serve.target===`http://127.0.0.1:${config.port}`?`https://${ts.dnsName}:${config.httpsPort}`:"not serving afkterm"}${serve.funnel?"  ⚠ Funnel is ON (requests are refused)":""}`);
      }
    }
    say(`Allowed logins:    ${config.allowedLogins.join(", ") || "(none)"}`);
    say(`Terminals:         ${config.backend==="herdr"?"Herdr":"iTerm2"}`);
    return;
  }

  if(command==="restart"){
    // An install from before the rename still runs the old login agent: replace it.
    if(setup.hasLegacyAgent() && await setup.agentState()==="not installed"){
      const cli=fileURLToPath(import.meta.url);
      setup.writeAgent(cli);await setup.loadAgent();
    } else await setup.restartAgent();
    say("Restarted.");return;
  }
  if(command==="logs"){
    try {say(readFileSync(LOG_FILE,"utf8").split("\n").slice(-60).join("\n"));} catch {say(`No log yet at ${LOG_FILE}`);}
    return;
  }
  if(command==="uninstall"){
    await setup.removeAgent();
    const bin=await setup.tailscaleBinary();
    if(bin)await setup.disableServe(bin,config.httpsPort);
    say(`Removed the login agent and stopped serving port ${config.httpsPort}. Your settings are still in ${CONFIG_FILE}.`);
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${HELP}`);
}

main().catch(error=>{process.stderr.write(`afkterm: ${error instanceof Error?error.message:String(error)}\n`);process.exit(1);});
