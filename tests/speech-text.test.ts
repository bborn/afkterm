import test from "node:test";
import assert from "node:assert/strict";
import { command, heardNothing, newSpeech, speakable, speechParts } from "../web/speech-text";

test("reads the prose and says where code and tables were, without reading them",()=>{
  const said=speakable("Fixed the **login** redirect in `/Users/bruno/app/src/auth/session.ts`.\n\n```ts\nconst x=1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nWant me to push?");
  assert.equal(said,"Fixed the login redirect in session.ts. Followed by a code block. Followed by a table. Want me to push?");
  assert.equal(speakable("```sh\nnpm test\n```"),"Claude replied with a code block.");
});

test("lists, headings, links and long inline code read as sentences",()=>{
  assert.equal(speakable("## Changes\n- Added a test\n- Ran `npm test`\n1. See [the docs](https://x.dev) at https://x.dev/a"),
    "Changes. Added a test. Ran npm test. 1, See the docs at a link.");
  assert.equal(speakable("Run `git rebase --onto origin/main feature~3 feature` first."),"Run first.");
});

test("splits a long reply into parts of about 20 seconds",()=>{
  const sentence="This sentence has exactly ten words in it for counting.";
  const parts=speechParts(Array(12).fill(sentence).join(" "));
  assert.equal(parts.length,3);
  assert.ok(parts.every(p=>p.split(" ").length<=55));
  assert.deepEqual(speechParts("Short one."),["Short one."]);
  assert.deepEqual(speechParts(""),[]);
});

test("ignores Whisper's noise words, and knows the few spoken commands",()=>{
  assert.equal(heardNothing("Thank you."),true);
  assert.equal(heardNothing("[BLANK_AUDIO]"),true);
  assert.equal(heardNothing("Thank you, now run the tests"),false);
  assert.equal(command("Stop.",false),"stop");
  assert.equal(command("Repeat that, please",false),"repeat");
  assert.equal(command("Exit hands-free.",false),"exit");
  assert.equal(command("Yeah.",true),"more");
  assert.equal(command("Yeah.",false),null);
  assert.equal(command("No thanks",true),"no-more");
  assert.equal(command("Stop using the old API",false),null);
});

test("updates while Claude works are short; the last message is read in full, without repeating its start",()=>{
  const state={spoken:new Map<string,number>(),finished:new Set<string>(["old"])};
  const msg=(id:string,text:string,role="assistant")=>({id,role,text});
  const long="Checking the logs now. Then I'll look at the detector code and see why the pause never ends. After that I'll run the tests again and report back with what I find. It should not take more than a few minutes, I think.";
  const first=newSpeech([msg("old","Earlier."),msg("u1","yes go","user"),msg("a1",long),msg("t","{}","tool")],null,state);
  assert.deepEqual(first.map(s=>[s.id,s.final,s.sentences.length]),[["a1",false,3]]);
  assert.deepEqual(newSpeech([msg("a1",long)],null,state),[]);
  // Two updates arrive while one was being read: only the newer is spoken.
  const behind=newSpeech([msg("a1",long),msg("a2","Found it."),msg("a3","Fixing it now.")],null,state);
  assert.deepEqual(behind.map(s=>s.id),["a3"]);
  // The turn ends on a message whose start was read as an update.
  const last=newSpeech([msg("a3","Fixing it now."),msg("a4",long)],"a4",state);
  assert.deepEqual(last.map(s=>[s.id,s.final]),[["a4",true]]);
  assert.equal(last[0].sentences.length,4);
  const resumed=newSpeech([msg("a5",long)],null,state);
  assert.equal(resumed[0].sentences.length,3);
  assert.deepEqual(newSpeech([msg("a5",long)],"a5",state)[0].sentences,["It should not take more than a few minutes, I think."]);
});
