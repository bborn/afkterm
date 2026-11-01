import { useEffect, useState } from "react";
import type { Question, QuestionAnswer } from "./api";

// Claude Code's AskUserQuestion dialog as a card. Every tap becomes one answer op
// that the server turns into keys and checks against the screen.
export function QuestionCard({question:q,disabled,answer}:{question:Question;disabled:boolean;answer:(a:QuestionAnswer)=>Promise<boolean>}) {
  const focused=q.cursor?.startsWith("option:")?Number(q.cursor.slice(7)):-1;
  const [other,setOther]=useState(q.other?.text ?? "");
  const [otherOpen,setOtherOpen]=useState(!!q.other?.text);
  const [notes,setNotes]=useState(q.notes?.text ?? "");
  // The screen is the source of truth: pick up what the terminal shows when the question or row changes.
  useEffect(()=>{setOther(q.other?.text ?? "");setOtherOpen(!!q.other?.text);},[q.prompt,q.other?.text]);
  useEffect(()=>{setNotes(q.notes?.text ?? "");},[q.prompt,focused,q.notes?.text]);

  const tabs=q.tabs.length>1 || q.submitTab;
  // In a multiSelect question, typed text counts as checked; it is sent with Next/Submit.
  const otherOn=!!q.other && (q.multiSelect && otherOpen?!!other.trim():q.other.checked);
  const preview=q.preview!==undefined;
  const send=(a:QuestionAnswer)=>void answer(a);

  return <div className="prompt question" role="group" aria-label="Claude is asking">
    {tabs && <div className="question-tabs" role="tablist">
      {q.tabs.map((t,i)=><span key={i} className="question-tab" data-answered={t.answered}>{t.answered?"✓ ":""}{t.label}</span>)}
      {q.submitTab && <span className="question-tab" data-current={!!q.review}>Submit</span>}
    </div>}
    <p className="prompt-question">{q.prompt}</p>

    {q.review
      ?<div className="question-review">
        {q.review.answers.map((a,i)=><div key={i} className="question-answer"><span className="prompt-detail">{a.question}</span><span>{a.answer || "No answer"}</span></div>)}
        <div className="question-actions">
          <button type="button" className="question-primary" disabled={disabled} onClick={()=>send({op:"submit"})}>Submit answers</button>
          <button type="button" className="question-secondary" disabled={disabled} onClick={()=>send({op:"tab",direction:-1})}>Back</button>
        </div>
      </div>
      :<div className="prompt-options" role={q.multiSelect?"group":"radiogroup"}>
        {q.options.map((o,i)=>{
          const on=q.multiSelect?o.checked:preview && i===focused;
          return <div key={o.key} className="question-row">
            <button type="button" className="prompt-option" role={q.multiSelect?"checkbox":"radio"} aria-checked={on} data-selected={on} disabled={disabled}
              onClick={()=>send(q.multiSelect?{op:"toggle",index:i}:preview?{op:"focus",index:i}:{op:"select",index:i})}>
              <span className="question-mark" data-kind={q.multiSelect?"check":"radio"} data-on={on} aria-hidden="true" />
              <span className="prompt-label"><span>{o.label}</span>{o.detail && <span className="prompt-detail">{o.detail}</span>}</span>
            </button>
            {preview && i===focused && <div className="question-preview">
              {q.preview && <pre>{q.preview}</pre>}
              {q.notes && <textarea rows={2} placeholder="Notes for Claude (optional)" value={notes} maxLength={4000} onChange={e=>setNotes(e.target.value)} />}
              <button type="button" className="question-primary" disabled={disabled} onClick={()=>send({op:"select",index:i,...(q.notes?{notes}:{})})}>Choose {o.label}</button>
            </div>}
          </div>;
        })}
        {q.other && <div className="question-row">
          <button type="button" className="prompt-option" role={q.multiSelect?"checkbox":"radio"} aria-checked={otherOn} aria-expanded={otherOpen} data-selected={otherOn} disabled={disabled}
            onClick={()=>setOtherOpen(!otherOpen)}>
            <span className="question-mark" data-kind={q.multiSelect?"check":"radio"} data-on={otherOn} aria-hidden="true" />
            <span className="prompt-label"><span>{q.other.text || "Other…"}</span>{!q.other.text && <span className="prompt-detail">Type your own answer</span>}</span>
          </button>
          {otherOpen && <div className="question-preview">
            <textarea rows={2} autoFocus placeholder="Your answer" value={other} maxLength={4000} onChange={e=>setOther(e.target.value)} />
            {!q.multiSelect && <button type="button" className="question-primary" disabled={disabled || !other.trim()} onClick={()=>send({op:"other",text:other})}>Send answer</button>}
          </div>}
        </div>}
        {q.multiSelect && q.submit && <button type="button" className="question-primary" disabled={disabled}
          onClick={()=>send({op:"next",...(q.other && (otherOpen || q.other.text)?{other}:{})})}>{q.submit==="Next"?"Next":"Submit"}</button>}
      </div>}

    <div className="question-footer">
      {tabs && !q.review && <>
        <button type="button" className="question-link" disabled={disabled || q.tabs.length<2 && !q.submitTab} onClick={()=>send({op:"tab",direction:-1})}>‹ Prev</button>
        <button type="button" className="question-link" disabled={disabled} onClick={()=>send({op:"tab",direction:1})}>Skip ›</button>
      </>}
      {q.chat && <button type="button" className="question-link" disabled={disabled}
        onClick={()=>void answer({op:"chat"}).then(ok=>{if(ok)(document.querySelector(".composer textarea") as HTMLTextAreaElement|null)?.focus();})}>Chat about this</button>}
      <button type="button" className="question-link question-cancel" disabled={disabled} onClick={()=>send({op:"cancel"})}>Cancel</button>
    </div>
  </div>;
}
