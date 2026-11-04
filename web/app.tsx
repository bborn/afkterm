import { useEffect, useState } from "react";
import { api, pair, pairCodeFromUrl, UNPAIRED, useSessions } from "./api";
import { Pairing } from "./pairing";
import { SessionList } from "./session-list";
import { SessionView } from "./session-view";

// Two screens: the tab index ("/") and one session ("/s/<id>").
const sessionFromPath=()=>{const m=/^\/s\/(.+)$/.exec(location.pathname);return m?decodeURIComponent(m[1]):null;};

export function App() {
  const [unpaired,setUnpaired]=useState(false);
  const [linkCode]=useState(pairCodeFromUrl);
  useEffect(()=>{
    const flag=()=>setUnpaired(true);
    window.addEventListener(UNPAIRED,flag);
    return ()=>window.removeEventListener(UNPAIRED,flag);
  },[]);
  if(unpaired || linkCode)return <Pairing initialCode={linkCode} done={()=>{history.replaceState(null,"","/");location.reload();}} pair={pair} />;
  return <Paired />;
}

function Paired() {
  const [sessionId,setSessionId]=useState(sessionFromPath);
  const [host,setHost]=useState("");
  const [app,setApp]=useState("iTerm2");
  const sessions=useSessions(sessionId?8000:4000);
  useEffect(()=>{
    const sync=()=>setSessionId(sessionFromPath());
    window.addEventListener("popstate",sync);
    return ()=>window.removeEventListener("popstate",sync);
  },[]);
  useEffect(()=>{api.me().then(me=>{setHost(me.host);if(me.app)setApp(me.app);},()=>{});},[]);
  useEffect(()=>{
    const session=sessions.data?.sessions.find(s=>s.id===sessionId);
    document.title=session?(session.tabName || session.name):host?`iTerm Web · ${host}`:"iTerm Web";
  },[sessions.data,sessionId,host]);

  const open=(id:string)=>{history.pushState({fromIndex:true},"",`/s/${encodeURIComponent(id)}`);setSessionId(id);};
  const back=()=>{
    if(history.state?.fromIndex)history.back();
    else {history.replaceState(null,"","/");setSessionId(null);}
  };
  const session=sessions.data?.sessions.find(s=>s.id===sessionId);

  return <div className="app">
    {sessionId
      ? <SessionView key={sessionId} sessionId={sessionId} session={session} sessions={sessions.data?.sessions || []} gone={!!sessions.data && !session} back={back} open={id=>{history.replaceState(history.state,"",`/s/${encodeURIComponent(id)}`);setSessionId(id);}} refreshList={sessions.refresh} />
      : <SessionList host={host} app={app} data={sessions.data} error={sessions.error} refresh={sessions.refresh} open={open} />}
  </div>;
}
