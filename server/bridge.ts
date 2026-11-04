import { execFile } from "node:child_process";

// Static source only. Data is read from stdin, never evaluated or put on a shell command line.
export const SCRIPT = String.raw`
ObjC.import('Foundation');
function run() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
  var app = Application('com.googlecode.iterm2');
  var action = input.action;
  if (!app.running()) {
    if (input.method === 'list') return JSON.stringify({running:false,sessions:[],truncated:false});
    if (!action || action.kind !== 'new-window') throw Error('iTerm2 is not running. Open iTerm2 on this Mac first.');
  }
  if (input.method === 'api-auth') {
    var credentials = app.requestCookie({andKeyForAppNamed:'afkterm'}).split(' ');
    return JSON.stringify({cookie:credentials[0],key:credentials[1]});
  }
  if (action && action.kind === 'new-window') {
    var created = app.createWindowWithDefaultProfile();
    return JSON.stringify({sessionId:created.currentSession().id()});
  }
  var windows = app.windows();
  var rows = [];
  var serializedLength = 0;
  function optional(fn, fallback) { try { var v = fn(); return v == null ? fallback : v; } catch (_) { return fallback; } }
  for (var wi = 0; wi < windows.length; wi++) {
    var w = windows[wi];
    var tabs = w.tabs();
    for (var ti = 0; ti < tabs.length; ti++) {
      var t = tabs[ti];
      var sessions = t.sessions();
      for (var si = 0; si < sessions.length; si++) {
        var s = sessions[si];
        var id;
        try { id = s.id(); } catch (_) { continue; } // Session closed during enumeration.
        if (input.method === 'list') {
          if (rows.length >= 1000 || serializedLength >= 200000) return JSON.stringify({running:true,sessions:rows,truncated:true});
          try {
            rows.push({id:id,name:String(s.name()).slice(0,500),tabName:String(optional(function(){return t.title();},'')).slice(0,500),windowId:w.id(),windowName:String(w.name()).slice(0,500),
              tabIndex:ti+1,paneIndex:si+1,tty:String(s.tty()),profile:String(s.profileName()).slice(0,500),
              cwd:String(optional(function(){return s.variable({named:'path'});},'')).slice(0,2000),
              processing:!!s.isProcessing(),atPrompt:!!s.isAtShellPrompt(),
              selected:optional(function(){return app.currentWindow().currentSession().id() === id;},false)});
            serializedLength += JSON.stringify(rows[rows.length-1]).length;
          } catch (_) { /* A tab or session may disappear between Apple events. */ }
        } else if (id === (action ? action.sessionId : input.sessionId)) {
          if (input.method === 'input-context') return JSON.stringify({cwd:String(optional(function(){return s.variable({named:'path'});},'')),tty:String(s.tty())});
          if (input.method === 'preview') {
            var screen = String(s.contents());
            return JSON.stringify({text:screen.slice(-64000),truncated:screen.length>64000,tty:String(s.tty())});
          }
          switch (action.kind) {
            case 'focus': w.miniaturized = false; w.select(); t.select(); s.select(); app.activate(); break;
            case 'rename': t.title = action.name; break;
            case 'send': s.write({text:action.text,newline:action.enter}); break;
            case 'key':
              var keys = {'enter':'\r','tab':'\t','shift-tab':'\x1b[Z','escape':'\x1b','ctrl-c':'\x03','ctrl-d':'\x04','up':'\x1b[A','down':'\x1b[B','right':'\x1b[C','left':'\x1b[D'};
              s.write({text:keys[action.key] || (/^[1-9]$/.test(action.key) ? action.key : ''),newline:false}); break;
            case 'close': s.close(); return JSON.stringify({sessionId:null});
            case 'close-tab': t.close(); return JSON.stringify({sessionId:null});
            case 'new-tab': return JSON.stringify({sessionId:w.createTabWithDefaultProfile().currentSession().id()});
            case 'split':
              var split = action.direction === 'vertical' ? s.splitVerticallyWithDefaultProfile() : s.splitHorizontallyWithDefaultProfile();
              return JSON.stringify({sessionId:split.id()});
            default: throw Error('Unsupported action');
          }
          return JSON.stringify({sessionId:id});
        }
      }
    }
  }
  if (input.method === 'list') return JSON.stringify({running:true,sessions:rows,truncated:false});
  throw Error('Session no longer exists. Refresh the session list.');
}`;

export function automationError(error: unknown): Error {
  const e = error as { message?: string; stderr?: string; killed?: boolean; code?: string };
  const message = e.stderr || e.message || String(error);
  if (e.killed || /timed out|timeout/i.test(message)) return new Error("iTerm2 did not respond. When you have access to the Mac, check for an Automation permission prompt or an iTerm dialog. Automation access is under System Settings → Privacy & Security → Automation. If you sent input, check the session before sending it again.");
  if (/-1743|not authorized|not permitted/i.test(message)) return new Error("macOS denied access to iTerm2. In System Settings → Privacy & Security → Automation, allow afkterm (or node, or your terminal app) to control iTerm2, then retry.");
  if (/-10814|can't be found|not found/i.test(message)) return new Error("iTerm2 is not installed on this Mac. Install and open iTerm2, then retry.");
  return new Error(message.slice(0,2000));
}

export function runAutomation(input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== "darwin") return Promise.reject(new Error("iTerm2 sessions are available only on a Mac. Select a macOS host."));
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], {
      timeout: 15000, maxBuffer: 4 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) return reject(automationError(Object.assign(error, { stderr })));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("iTerm2 returned an invalid response. Refresh and try again.")); }
    });
    child.stdin?.on("error", () => {}); // execFile callback owns process errors.
    child.stdin?.end(JSON.stringify(input));
  });
}
