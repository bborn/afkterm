// afkterm's service worker. It only shows notifications from your Mac and opens
// the agent when you tap one. It doesn't cache anything: the app always loads fresh.

self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));

self.addEventListener("push",event=>{
  let data={};
  try {data=event.data?event.data.json():{};} catch {data={title:"afkterm",body:event.data?.text() || ""};}
  const shown=self.registration.showNotification(data.title || "afkterm",{
    body:data.body || "",
    tag:data.tag,
    renotify:true,
    icon:"/icon-192.png",
    badge:"/icon-192.png",
    data:{url:data.url || "/"},
  });
  const badge=typeof data.badge==="number" && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(data.badge).catch(()=>{})
    : Promise.resolve();
  event.waitUntil(Promise.all([shown,badge]));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url || "/",self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const open=windows[0];
    if(open){
      await open.focus().catch(()=>{});
      // The app listens for this and switches to the agent without a reload.
      open.postMessage({kind:"open",url});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
