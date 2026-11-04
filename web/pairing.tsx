import { useState } from "react";
import { errorMessage } from "./api";

// Shown until this phone has the device secret. The code comes from
// `afkterm pair` (or the end of `afkterm setup`) on the Mac.
export function Pairing({initialCode,pair,done}:{initialCode:string|null;pair:(code:string)=>Promise<void>;done:()=>void}) {
  const [code,setCode]=useState(initialCode || "");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(value=code) {
    const digits=value.replace(/\D/g,"");
    if(digits.length!==6 || busy)return;
    setBusy(true);setError("");
    try {await pair(digits);done();}
    catch(e){setError(errorMessage(e));setBusy(false);}
  }
  return <div className="app"><div className="screen pairing">
    <div className="pairing-body">
      <img src="/icon.svg" alt="" width={72} height={72} />
      <h1>Connect this device</h1>
      <p>On your Mac, run <code>afkterm pair</code> and enter the 6-digit code it shows.</p>
      <form onSubmit={e=>{e.preventDefault();void submit();}}>
        <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
          inputMode="numeric" autoComplete="one-time-code" placeholder="000000" aria-label="Pairing code" autoFocus={!initialCode} disabled={busy} />
        <button type="submit" disabled={busy || code.length!==6}>{busy?"Connecting…":"Connect"}</button>
      </form>
      {error && <p className="pairing-error" role="alert">{error}</p>}
    </div>
  </div></div>;
}
