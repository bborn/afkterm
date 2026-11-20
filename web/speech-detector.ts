// Works out when you start and stop talking from the mic's loudness, one frame
// (about 16ms) at a time. Speech is loud and sustained; a car's road noise is steady
// and a bump or click is short, so neither should keep a pause from ending.

export const PAUSE=1200, MAX_TALK=60000, IDLE_RESTART=30000;
const CALIBRATE=500, ONSET=100, STRICT_ONSET=300, RESUME=250, STEADY_WINDOW=600;

export type DetectorEvent="calibrating"|"waiting"|"onset"|"talking"|"pause"|"max"|"idle";

export class SpeechDetector {
  // The room's level, kept between utterances and slowly following changes.
  floor=0;
  private started=-1;
  private calibrateMin=Infinity;
  private smooth=0;
  private onset=0;
  private loudSince=0;
  private quietSince=0;
  private peak=0;
  private fast=0;
  private recent:[number,number][]=[];
  level=0;

  reset(){this.started=-1;this.calibrateMin=Infinity;this.smooth=0;this.onset=0;this.loudSince=0;this.quietSince=0;this.peak=0;this.fast=0;this.recent=[];this.level=0;}
  get talkingSince(){return this.onset;}

  // `strict` while Claude is speaking: its own voice leaks into the mic, so it takes
  // louder and longer sound to count as you starting to talk.
  push(rms:number,now:number,strict=false):DetectorEvent {
    if(this.started<0)this.started=now;
    if(!this.floor){
      this.calibrateMin=Math.min(this.calibrateMin,rms);
      if(now-this.started<CALIBRATE)return "calibrating";
      this.floor=Math.max(this.calibrateMin,.002);
    }
    // About 100ms of smoothing, so a single loud frame barely moves it.
    this.smooth=this.smooth*.8+rms*.2;
    const threshold=Math.max(this.floor*3,.012)*(strict && !this.onset?2:1);
    this.level=Math.min(1,this.smooth/(threshold*3));
    if(!this.onset){
      if(!strict)this.floor=this.floor*.995+Math.min(rms,this.floor*2)*.005;
      if(this.smooth>threshold){
        this.loudSince||=now;
        if(now-this.loudSince>=(strict?STRICT_ONSET:ONSET)){this.onset=now;this.peak=this.smooth;this.loudSince=0;return "onset";}
      } else this.loudSince=0;
      return now-this.started>=IDLE_RESTART?"idle":"waiting";
    }
    // While you talk, quiet means well below how loud you've been, not just above the room.
    this.peak=Math.max(this.smooth,this.peak*.999);
    // Speech rises and falls with every syllable. A level that hardly moves for most of
    // a second is a fan, an engine or a hum, however loud, so it doesn't count as you,
    // and the room's level is raised so the same noise doesn't start the next one.
    // Measured on a lightly smoothed level, from the quieter and louder tenth of it.
    this.fast=this.fast*.5+rms*.5;
    this.recent.push([now,this.fast]);
    while(this.recent.length && now-this.recent[0][0]>STEADY_WINDOW)this.recent.shift();
    const sorted=this.recent.map(([,v])=>v).sort((a,b)=>a-b);
    const lo=sorted[Math.floor(sorted.length*.1)], hi=sorted[Math.floor(sorted.length*.9)];
    const steady=now-this.onset>=STEADY_WINDOW && hi<lo*2;
    if(steady)this.floor=Math.max(this.floor,lo/2.5);
    const talking=!steady && this.smooth>Math.max(threshold,this.peak*.3);
    if(talking){
      this.loudSince||=now;
      // Only sound that lasts counts as you carrying on.
      if(now-this.loudSince>=RESUME)this.quietSince=0;
    } else {
      this.loudSince=0;
      this.quietSince||=now;
    }
    if(this.quietSince && now-this.quietSince>=PAUSE)return "pause";
    if(now-this.onset>=MAX_TALK)return "max";
    return "talking";
  }
}
