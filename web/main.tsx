import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";
import { registerWorker } from "./notifications";

// iOS Safari keeps the layout viewport full height when the keyboard opens.
// Size the app to the visible area so the composer stays above the keyboard.
function trackViewport() {
  const viewport=window.visualViewport;
  const root=document.documentElement;
  const update=()=>{
    root.style.setProperty("--vvh",`${viewport?viewport.height:window.innerHeight}px`);
    root.style.setProperty("--vvt",`${viewport?viewport.offsetTop:0}px`);
  };
  update();
  viewport?.addEventListener("resize",update);
  viewport?.addEventListener("scroll",update);
  window.addEventListener("resize",update);
}
trackViewport();
registerWorker();

createRoot(document.getElementById("root")!).render(<App />);
