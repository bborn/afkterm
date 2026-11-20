import test from "node:test";
import assert from "node:assert/strict";
import { SpeechDetector } from "../web/speech-detector";

// Feeds loudness at 60 frames a second and returns when each event first happened.
// Talking at about this loudness: it rises and falls with the syllables, about five a second.
function voice(level:number){let frame=0;return ()=>level*(.2+.8*Math.abs(Math.sin(frame++*.26)));}

function run(d:SpeechDetector,segments:[ms:number,level:number|(()=>number)][],strict=false) {
  const seen=new Map<string,number>();let t=0;
  for(const [ms,level] of segments)for(let end=t+ms;t<end;t+=16){
    const e=d.push(typeof level==="number"?level:level(),t,strict);
    if(!seen.has(e))seen.set(e,t);
    if(e==="pause" || e==="max")return seen;
  }
  return seen;
}

test("a pause ends it even with bumps and clicks in the silence",()=>{
  const d=new SpeechDetector();let frame=0;
  // Quiet room, two seconds of talk, then quiet with a short click every 300ms.
  const clicks=()=>(frame++%19===0?.08:.003);
  const seen=run(d,[[600,.003],[2000,voice(.15)],[4000,clicks]]);
  assert.ok(seen.has("onset"));
  const pause=seen.get("pause");
  assert.ok(pause!==undefined && pause<2600+1600,`pause at ${pause}`);
});

test("steady road noise isn't heard as talking, and talking over it still ends",()=>{
  const d=new SpeechDetector();
  const seen=run(d,[[600,.03],[3000,.035],[1500,voice(.35)],[3000,.04]]);
  assert.ok((seen.get("onset") ?? 0)>=3600,"noise alone started it");
  assert.ok(seen.has("pause"));
});

test("a short breath between words doesn't end it",()=>{
  const d=new SpeechDetector();
  const seen=run(d,[[600,.003],[1500,voice(.15)],[600,.004],[1500,voice(.15)],[1500,.003]]);
  assert.ok((seen.get("pause") ?? 0)>=600+1500+600+1500,"ended during the breath");
});

test("while Claude speaks, its echo doesn't count as you, but talking over it does",()=>{
  const d=new SpeechDetector();
  run(d,[[600,.003]]);
  d.reset();
  // Leaked playback at about four times the room, in bursts as Claude talks.
  let frame=0;const echo=()=>(frame++%30<20?.013:.004);
  assert.ok(!run(d,[[4000,echo]],true).has("onset"));
  d.reset();
  assert.ok(run(d,[[1000,.004],[800,voice(.15)]],true).has("onset"));
});

test("a steady noise that starts it still ends, and doesn't start the next one",()=>{
  const d=new SpeechDetector();
  // A quiet room, then a fan or engine comes on well above it and stays on.
  const seen=run(d,[[600,.002],[5000,.03]]);
  assert.ok(seen.has("onset"));
  const pause=seen.get("pause");
  assert.ok(pause!==undefined && pause<600+2500,`pause at ${pause}`);
  d.reset();
  assert.ok(!run(d,[[3000,.03]]).has("onset"),"the same noise started it again");
  d.reset();
  assert.ok(run(d,[[300,.03],[1500,voice(.2)]]).has("onset"),"talking over the noise didn't start it");
});

test("road noise that wobbles a little from frame to frame still counts as steady",()=>{
  const d=new SpeechDetector();
  let seed=1;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const road=()=>.03*(.75+.5*rand());
  const seen=run(d,[[600,.002],[1500,voice(.2)],[5000,road]]);
  const pause=seen.get("pause");
  assert.ok(pause!==undefined && pause<600+1500+2500,`pause at ${pause}`);
});
