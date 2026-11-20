// Push-to-talk on the mic: hold to talk and let go to send, or tap to record
// hands-off and stop with the buttons (which also offer edit-before-send).
// Sliding the finger left or up past CANCEL_PX throws the recording away.

// Shorter than this is a tap. Long enough that a firm tap isn't read as a hold.
export const HOLD_MS=300;
// Far enough that a thumb drifting while you talk doesn't cancel.
export const CANCEL_PX=70;

export type Press={at:number;x:number;y:number};
export type PressEnd="tap"|"send"|"cancel";

export const slideCancels=(p:Press,x:number,y:number)=>p.x-x>=CANCEL_PX || p.y-y>=CANCEL_PX;

// Decided on release, so sliding back before letting go undoes a cancel, like an iOS button.
export function pressEnd(p:Press,at:number,x:number,y:number):PressEnd {
  if(slideCancels(p,x,y))return "cancel";
  return at-p.at<HOLD_MS?"tap":"send";
}
