/*
  CB-VIDEO ANALOG V8 / 120 ksample/s -- progressive-only analog TV with automatic H/V sync.
  Uses unmodified CB FM STEREO V12 RF firmware and the MPX3 PCM8 transport.
  Pixels never have CRC, packet validity, FEC, or retransmission.
  H/V pulse detection controls the raster only. Damaged samples remain visible.
*/
(function(root){
'use strict';
const FS=120000, HSYNC=24, BLACK=12, WHITE=12, PRE=8, POST=12;
const VSYNC=168, VPORCH=24, VBLANK=VSYNC+VPORCH;
// Reserved-endpoint vertical marker: LOW 48, WHITE 12, LOW 48, WHITE 12, LOW 48.
// Same 168 samples as V4: frame rate is unchanged.
const VSEGMENTS=Object.freeze([[0,48,true],[48,60,false],[60,108,true],[108,120,false],[120,168,true]]);
const HOVER=HSYNC+BLACK+WHITE+PRE+POST; // 68 samples per physical line
const PIXEL_OFFSET=HSYNC+BLACK+WHITE+PRE;
const SYNC=-110, BLACK_REF=-48, WHITE_REF=88, PIXEL_BLACK=-38, PIXEL_WHITE=78;
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
const enc=v=>(v+256)&255;
const formats=[];
const resolutions=[[64,48],[80,60],[96,72],[128,96],[160,120],[192,144],[256,192],[320,240]];
for(const [w,h] of resolutions)formats.push({id:`bw${w}`,label:`${w} × ${h} · progressive B&W`,kind:'mono',w,h,spp:1});
formats.push({id:'bw320stable',label:'320 × 240 · B&W stable (2 samples/pixel)',kind:'mono',w:320,h:240,spp:2});
for(const [w,h] of resolutions.filter(([w])=>w<=256))formats.push({id:`col${w}`,label:`${w} × ${h} · YUV 4:2:0 color`,kind:'color',w,h,spp:1});
// Slow color mode: repeat each transmitted Y, U and V sample twice for analog robustness.
formats.push({id:'col256stable',label:'256 × 192 · YUV 4:2:0 color stable (2 samples/pixel)',kind:'color',w:256,h:192,spp:2});
const byId=new Map(formats.map(f=>[f.id,Object.freeze(f)]));
function getFormat(id){const m=byId.get(id);if(!m)throw Error('Unknown video format: '+id);return m;}
function getPlan(id){
 const m=typeof id==='string'?getFormat(id):id,rows=[];
 if(m.kind==='mono')for(let y=0;y<m.h;y++)rows.push({plane:'y',y,width:m.w,spp:m.spp,len:HOVER+m.w*m.spp});
 if(m.kind==='color'){
  for(let y=0;y<m.h;y++)rows.push({plane:'y',y,width:m.w,spp:m.spp,len:HOVER+m.w*m.spp});
  for(const plane of ['u','v'])for(let y=0;y<m.h/2;y++)rows.push({plane,y,width:m.w/2,spp:m.spp,len:HOVER+(m.w/2)*m.spp});
 }
 const fieldSamples=VBLANK+rows.reduce((s,row)=>s+row.len,0);
 return {mode:m,rows,fieldSamples,fieldsPerFrame:1,fieldFps:FS/fieldSamples,frameFps:FS/fieldSamples};
}
const planCache=new Map(formats.map(m=>[m.id,getPlan(m)]));
const plan=id=>planCache.get(typeof id==='string'?id:id.id);
function patternRGBA(modeId){
 const m=getFormat(modeId),rgba=new Uint8ClampedArray(m.w*m.h*4);
 for(let y=0;y<m.h;y++)for(let x=0;x<m.w;x++){
  const i=4*(y*m.w+x),check=(((x/(m.w/8))|0)+((y/(m.h/6))|0))&1;
  let r=check?195:43,g=r,b=r;
  if(x>m.w*.34&&x<m.w*.67&&y>m.h*.28&&y<m.h*.78){r=g=b=Math.round(255*(x/m.w-.34)/.33);}
  if(m.kind==='color'&&y>m.h*.76){
   const bar=Math.min(5,Math.floor(x/m.w*6));
   [[224,52,53],[236,178,52],[54,195,113],[39,157,224],[156,90,226],[231,87,164]][bar].forEach((v,k)=>{if(k===0)r=v;else if(k===1)g=v;else b=v;});
  }
  rgba[i]=r;rgba[i+1]=g;rgba[i+2]=b;rgba[i+3]=255;
 }
 return rgba;
}
function sourceFromRGBA(modeId,rgba){
 const m=getFormat(modeId),size=m.w*m.h;
 if(!rgba||rgba.length!==size*4)throw Error('Invalid RGBA source image');
 const y=new Uint8Array(size),u=m.kind==='color'?new Uint8Array(size/4):null,v=m.kind==='color'?new Uint8Array(size/4):null;
 // BT.601 full-range YUV. Chrominance is averaged over 2x2 spatial blocks.
 for(let py=0;py<m.h;py++)for(let px=0;px<m.w;px++){
  const j=4*(py*m.w+px),r=rgba[j],g=rgba[j+1],b=rgba[j+2];
  y[py*m.w+px]=clamp(Math.round(.299*r+.587*g+.114*b),0,255);
 }
 if(m.kind==='color')for(let py=0;py<m.h;py+=2)for(let px=0;px<m.w;px+=2){
  let us=0,vs=0;
  for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
   const p=(py+dy)*m.w+px+dx,j=p*4,yy=y[p];
   us+=(rgba[j+2]-yy)/1.772+128;
   vs+=(rgba[j]-yy)/1.402+128;
  }
  const k=(py/2)*(m.w/2)+px/2;
  u[k]=clamp(Math.round(us/4),0,255);
  v[k]=clamp(Math.round(vs/4),0,255);
 }
 return {id:m.id,y,u,v};
}
function makeWave(source,modeId){
 const p=plan(modeId),m=p.mode;
 if(!source||source.id!==m.id)throw Error('Source/mode mismatch');
 const wave=new Uint8Array(p.fieldSamples),put=(value,count)=>{wave.fill(enc(value),at,at+count);at+=count;};
 let at=0;
 for(const [lo,hi,isSync] of VSEGMENTS)put(isSync?SYNC:WHITE_REF,hi-lo);
 put(BLACK_REF,VPORCH);
 for(const row of p.rows){
  put(SYNC,HSYNC);put(BLACK_REF,BLACK);put(WHITE_REF,WHITE);put(BLACK_REF,PRE);
  const arr=row.plane==='u'?source.u:row.plane==='v'?source.v:source.y;
  for(let x=0;x<row.width;x++){
   let lum;
   lum=arr[row.y*row.width+x];
   const signed=PIXEL_BLACK+Math.round((PIXEL_WHITE-PIXEL_BLACK)*lum/255);
   put(signed,row.spp);
  }
  put(BLACK_REF,POST);
 }
 if(at!==wave.length)throw Error('Scan timing: unexpected frame length');
 return wave;
}
class Decoder{
 constructor({mode='bw320',threshold=-78,brightness=0,contrast=1,saturation=1,hPosition=0,hHold=0,vHold=0,hLock=.85,onFrame=()=>{}}={}){
  this.onFrame=onFrame;this.onHSignal=null;this.seed=0x3F69B2D1;
  this.totalSamples=0;this.totalMissing=0;this.verticalSyncs=0;this.horizontalSyncs=0;
  this.fields=0;this.frames=0;this.falseH=0;this.hLost=0;this.hPhaseError=0;
  this.hReacquired=0;this.vRejected=0;
  this.threshold=threshold;this.autoThreshold=true;this.syncThresholdUsed=threshold;
  this.brightness=brightness;this.contrast=contrast;this.saturation=saturation;
  this.hPosition=hPosition;this.hHold=hHold;this.vHold=vHold;this.hLock=hLock;
  this.setMode(mode);
 }
 setMode(id){
  this.p=plan(id);this.m=this.p.mode;this.row=0;
  this.lineLengths=[...new Set(this.p.rows.map(row=>row.len))];
  this.lineStart=this.totalSamples+VBLANK;this.autoPeriod=0;
  this.anchored=false;this.hLocked=false;this.hStreak=0;this.hMissStreak=0;this.hClockStarted=false;
  this.lineSeq=0;this.hSeq=-1;this.hCandidate=null;this.hAlternative=null;
  this.syncThresholdUsed=this.threshold;this.lowSum=0;
  this.lastHAt=-1e12;this.lastHLineLength=0;this.lastVAt=-1e12;this.lastFrameAt=-1e12;
  this.previousLow=false;this.lowRun=0;this.vCandidate=null;
  // Running valid-sample sums allow a waveform-shape sync separator, not a fixed
  // negative PCM threshold. Works through DC offset and analog gain variation.
  this.windowEpoch=this.totalSamples;
  this.cumSum=new Float64Array(1024);this.cumSquare=new Float64Array(1024);
  this.cumValid=new Float64Array(1024);this.sumSoFar=0;this.squareSoFar=0;this.validSoFar=0;
  this.hCandidates=0;this.hShapes=0;this.vCandidates=0;
  this.lastShapeH=-1e12;this.lastVShape=-1e12;
  this.rxSyncMean=null;this.rxBlackMean=null;this.rxWhiteMean=null;
  this.autoLevel=true;this.markerContrast=0;
  this.recoverySamples=0;
  this.fieldParity=0;
  this.y=new Uint8Array(this.m.w*this.m.h);this.y.fill(95);
  if(this.m.kind==='color'){
   this.u=new Uint8Array(this.m.w*this.m.h/4);this.v=new Uint8Array(this.u.length);this.u.fill(128);this.v.fill(128);
  }else {this.u=null;this.v=null;}
  this.bitmap=new Uint8ClampedArray(this.m.w*this.m.h*4);this.previousSample=0;
 }
 reset(clearCounters=false){
  if(clearCounters){this.totalSamples=0;this.totalMissing=0;this.verticalSyncs=0;this.horizontalSyncs=0;this.fields=0;this.frames=0;this.falseH=0;this.hLost=0;this.hReacquired=0;this.vRejected=0;}
  this.setMode(this.m.id);
 }
 setLevels({brightness=this.brightness,contrast=this.contrast,saturation=this.saturation,threshold=this.threshold,
   hPosition=this.hPosition,hHold=this.hHold,vHold=this.vHold,hLock=this.hLock,autoThreshold=this.autoThreshold,autoLevel=this.autoLevel}={}){
  this.brightness=clamp(+brightness||0,-160,160);
  this.contrast=clamp(Number.isFinite(+contrast)?+contrast:1,.1,6);
  this.saturation=clamp(Number.isFinite(+saturation)?+saturation:1,0,3);
  this.threshold=clamp(Number.isFinite(+threshold)?+threshold:-78,-126,-40);
  this.autoThreshold=!!autoThreshold;this.autoLevel=!!autoLevel;
  if(!this.autoThreshold)this.syncThresholdUsed=this.threshold;
  this.hPosition=clamp(+hPosition||0,-320,320);
  this.hHold=clamp(+hHold||0,-5,5);this.vHold=clamp(+vHold||0,-180,600);
  this.hLock=clamp(Number.isFinite(+hLock)?+hLock:.85,0,1);
 }
 snow(){let x=this.seed;x^=x<<13;x^=x>>>17;x^=x<<5;this.seed=x>>>0;return this.seed&255;}
 level(raw){
  // Porches act as a sync-tip / black-level clamp. This is analog AGC/DC
  // restoration, not a pixel-error check or digital error correction.
  let black=PIXEL_BLACK,white=PIXEL_WHITE;
  if(this.autoLevel && this.rxBlackMean!==null && this.rxWhiteMean!==null){
   const gain=clamp((this.rxWhiteMean-this.rxBlackMean)/(WHITE_REF-BLACK_REF),.35,2.8);
   black=this.rxBlackMean+(PIXEL_BLACK-BLACK_REF)*gain;
   white=this.rxBlackMean+(PIXEL_WHITE-BLACK_REF)*gain;
  }
  return clamp(Math.round((255*(raw-black)/(white-black)-128)*this.contrast+128+this.brightness),0,255);
 }
 // H-POSITION represents a circular horizontal displacement, not clipping.
 // YUV 4:2:0 chroma uses half as many horizontal samples as luma.
 shiftedX(sourceX,row){
  const offset=row.plane==='y'?this.hPosition:Math.round(this.hPosition/2);
  return ((sourceX+offset)%row.width+row.width)%row.width;
 }
 paint(x,row,value){
  const desc=this.p.rows[row],m=this.m;
  if(desc.plane==='y')this.y[desc.y*m.w+x]=value;
  else if(desc.plane==='u')this.u[desc.y*(m.w/2)+x]=value;
  else this.v[desc.y*(m.w/2)+x]=value;
 }
 compose(){
  const m=this.m,rgba=this.bitmap,source=this.y,uvW=m.w/2;
  for(let y=0;y<m.h;y++)for(let x=0;x<m.w;x++){
   const i=y*m.w+x,j=i*4,yy=source[i];let r=yy,g=yy,b=yy;
   if(m.kind==='color'){
    const uv=(Math.floor(y/2)*uvW)+Math.floor(x/2),du=(this.u[uv]-128)*this.saturation,dv=(this.v[uv]-128)*this.saturation;
    r=clamp(Math.round(yy+1.402*dv),0,255);
    g=clamp(Math.round(yy-.344136*du-.714136*dv),0,255);
    b=clamp(Math.round(yy+1.772*du),0,255);
   }
   rgba[j]=r;rgba[j+1]=g;rgba[j+2]=b;rgba[j+3]=255;
  }
  return rgba.slice();
 }
 emitFrame(at){
  this.fields++;this.frames++;this.lastFrameAt=at;
  this.onFrame(this.compose(),{fields:this.fields,frames:this.frames,verticalSyncs:this.verticalSyncs,
    horizontalSyncs:this.horizontalSyncs,anchored:this.anchored,hLocked:this.hLocked,
    missingSamples:this.totalMissing,hMisses:this.hLost,falseH:this.falseH});
 }
 currentPeriod(){return this.p.rows[this.row].len+this.hHold+this.autoPeriod;}
 advanceRaster(n,silent=false){
  let guard=0;
  while(n>=this.lineStart+this.currentPeriod()&&guard++<10000){
   // The raster never rejects a line. Its H detector is only a clock/phase reference.
   if(this.hClockStarted && this.hSeq!==this.lineSeq){
    this.hMissStreak++;this.hLost++;
    if(this.hMissStreak>=12){this.hLocked=false;this.hStreak=0;}
   }
   this.lineStart+=this.currentPeriod();
   if(++this.row>=this.p.rows.length){
    this.row=0;this.lineSeq=0;this.hSeq=-1;
    // Vertical blanking breaks the ordinary H-H distance. The next H is
    // allowed even if the V marker was lost; do not invalidate H lock.
    this.lastHAt=-1e12;this.lastHLineLength=0;
    if(!silent)this.emitFrame(n);
    // Never recycle stale lines from the preceding field. Missing samples
    // remain visible as noise in each newly scanned field.
    this.y.fill(72);if(this.u){this.u.fill(128);this.v.fill(128);}
    this.lineStart+=VBLANK+this.vHold;
    // Free-run through V blanking; a recognizable next V pulse reanchors us.
   }else{this.lineSeq++;}
  }
 }
 // Prefix sums of ONLY transport-valid analog samples; no per-pixel CRC.
 resetWaveWindow(){
  this.windowEpoch=this.totalSamples;
  this.cumSum.fill(0);this.cumSquare.fill(0);this.cumValid.fill(0);
  this.sumSoFar=0;this.squareSoFar=0;this.validSoFar=0;
  this.lastShapeH=-1e12;this.vCandidate=null;
 }
 stat(lo,hi){
  if(lo<this.windowEpoch||hi>this.totalSamples||hi-lo>900)return null;
  const n=this.cumValid[hi&1023]-this.cumValid[lo&1023];
  if(n<1)return null;
  const sum=this.cumSum[hi&1023]-this.cumSum[lo&1023];
  const sq=this.cumSquare[hi&1023]-this.cumSquare[lo&1023];
  const mean=sum/n;
  return {n,mean,sd:Math.sqrt(Math.max(0,sq/n-mean*mean))};
 }
 // H separator: 24 negative samples, followed by 12 black porch and 12
 // bright reference samples. Compare means and flatness (relative contrast),
 // never demand a predetermined absolute amplitude or a previous V lock.
 detectHorizontal(n){
  const start=n+1-(HSYNC+BLACK+WHITE);
  if(start<this.windowEpoch||start-this.lastShapeH<18)return;
  // Once locked, look near the predicted line boundary. A false H in image
  // content must not tug the horizontal oscillator across the screen.
  if(this.hLocked && Math.abs(start-this.lineStart)>22 && this.hMissStreak<10)return;
  const a=this.stat(start,start+HSYNC),b=this.stat(start+HSYNC,start+HSYNC+BLACK);
  const c=this.stat(start+HSYNC+BLACK,start+HSYNC+BLACK+WHITE);
  if(!a||!b||!c||a.n<17||b.n<8||c.n<8)return;
  const d1=b.mean-a.mean,d2=c.mean-b.mean;
  if(d1<13||d2<28||a.sd>Math.max(20,d1*.48)||b.sd>Math.max(22,d2*.28)||c.sd>26)return;
  // Prevent overlapping detections of the same real pulse.
  this.lastShapeH=start;this.hCandidates++;this.hShapes++;
  if(this.onHSignal)this.onHSignal(start);
  this.onHorizontal(start,n,HSYNC,a.mean,b.mean,c.mean);
 }
 // V separator: 48 low, 12 porch, 48 low, 12 porch, 48 low.
 // This distinctive waveform is also normalized by the RECEIVED analog
 // contrast rather than the encoder's nominal PCM offset.
 verticalScore(start){
  if(start<this.windowEpoch||start+VSYNC>this.totalSamples)return -1;
  let lows=[],porches=[];
  for(const [lo,hi,isSync] of VSEGMENTS){
   // Ignore transition edges (FIR ringing + 4-sample search phase).
   const width=hi-lo, trim=isSync?5:3;
   const s=this.stat(start+lo+trim,start+hi-trim);
   if(!s||s.n<(width-2*trim)*.70)return -1;
   (isSync?lows:porches).push(s);
  }
  const low=lows.reduce((sum,s)=>sum+s.mean,0)/3;
  const porch=(porches[0].mean+porches[1].mean)*.5;
  const contrast=porch-low;
  if(contrast<45)return -1;
  // A vertical sync marker is a FLAT pulse train, unlike random FM noise.
  // This is a check on the reserved sync waveform only, not on image pixels.
  if(lows.some(s=>s.sd>Math.max(23,contrast*.30)) ||
     porches.some(s=>s.sd>Math.max(24,contrast*.35)))return -1;
  // A true V sync uses the SAME reserved negative/positive extremes as
  // the observed H reference levels, never ordinary image gray values.
  if(this.rxSyncMean!==null && Math.abs(low-this.rxSyncMean)>Math.max(22,this.markerContrast*.5))return -1;
  if(this.rxWhiteMean!==null && Math.abs(porch-this.rxWhiteMean)>Math.max(25,(this.rxWhiteMean-this.rxBlackMean)*.35))return -1;
  if(lows.some(s=>Math.abs(s.mean-low)>Math.max(17,contrast*.40))||
     porches.some(s=>Math.abs(s.mean-porch)>Math.max(20,contrast*.45)))return -1;
  // Noise may make an individual 48-sample low segment uneven. Its mean
  // can still be usable; do not treat the video luminance as valid/invalid.
  return contrast-Math.abs(porches[0].mean-porches[1].mean)*.2;
 }
 detectVertical(n){
  if((n&3)!==0)return;
  if(this.vCandidate && n>=this.vCandidate.until){
   const candidate=this.vCandidate;this.vCandidate=null;
   if(candidate.start-this.lastVAt>this.p.fieldSamples*.65)this.onVertical(candidate.start,n);
  }
  if(n+1<VSYNC||n-this.lastVAt<this.p.fieldSamples*.65)return;
  const start=n+1-VSYNC,score=this.verticalScore(start);
  if(score>=45){
   this.vCandidates++;
   if(!this.vCandidate||score>this.vCandidate.score)this.vCandidate={start,score,until:n+20};
  }
 }
 onVertical(start,n){
  const wasHLocked=this.hLocked;
  this.lastVAt=start;this.verticalSyncs++;this.anchored=true;this.hClockStarted=true;
  if(this.row>this.p.rows.length*.70 && n-this.lastFrameAt>this.p.fieldSamples*.55)this.emitFrame(n);
  this.row=0;this.lineStart=start+VBLANK;
  this.y.fill(72);if(this.u){this.u.fill(128);this.v.fill(128);}
  this.hMissStreak=0;this.lineSeq=0;this.hSeq=-1;
  this.hAlternative=null;this.hPhaseError=0;
  this.lastHAt=-1e12;this.lastHLineLength=0;
  if(wasHLocked)this.hStreak=Math.max(3,this.hStreak);
 }
 onHorizontal(start,n,run,syncMean,blackMean,whiteMean){
  if(start>=this.lastVAt && start<this.lastVAt+VBLANK-10)return;
  const prev=this.lastHAt,prevLen=this.lastHLineLength;
  const length=this.p.rows[this.row].len;
  if(prev>-1e11&&start-prev<.58*Math.min(length,prevLen)){this.falseH++;return;}
  const delta=prev>-1e11?start-prev:0;
  const plausible=prev<=-1e11||this.lineLengths.some(l=>Math.abs(delta-l)<Math.max(13,l*.045));
  const skipped=prev>-1e11&&this.lineLengths.some(l=>Math.abs(delta-2*l)<23);
  if(!this.hClockStarted){
   this.hClockStarted=true;this.lineStart=start;this.row=0;this.lineSeq=0;
   this.hSeq=-1;this.hStreak=0;this.autoPeriod=0;
  }
  let err=start-this.lineStart;
  if(Math.abs(err)>(this.hLocked?22:55)){
   const alt=this.hAlternative;
   const coherent=alt&&start>alt.start&&this.lineLengths.some(l=>Math.abs(start-alt.start-l)<18);
   const streak=coherent?alt.streak+1:1;
   this.hAlternative={start,streak};
   if(streak<3){this.falseH++;return;}
   this.hReacquired++;this.lineStart=start;err=0;this.hStreak=2;
   this.hAlternative=null;this.hLocked=false;
  }else this.hAlternative=null;
  if(!plausible&&!skipped&&prev>-1e11){this.falseH++;return;}
  this.horizontalSyncs++;this.lastHAt=start;this.lastHLineLength=length;
  this.hStreak=plausible?Math.min(255,this.hStreak+1):Math.max(1,this.hStreak);
  this.hSeq=this.lineSeq;this.hMissStreak=0;
  if(this.hStreak>=3)this.hLocked=true;
  this.hPhaseError=err;
  const gain=this.hLocked?this.hLock:.65;
  this.lineStart+=clamp(err*gain,-38,38);
  if(prev>-1e11 && plausible && delta>0){
   this.autoPeriod=clamp(.97*this.autoPeriod+.03*(delta-prevLen-this.hHold),-3,3);
  }
  // Analog reference recovery. It follows receive gain/DC slowly once locked.
  const alpha=this.rxBlackMean===null?1:this.hLocked?.045:.18;
  this.rxSyncMean=this.rxSyncMean===null?syncMean:this.rxSyncMean*(1-alpha)+syncMean*alpha;
  this.rxBlackMean=this.rxBlackMean===null?blackMean:this.rxBlackMean*(1-alpha)+blackMean*alpha;
  this.rxWhiteMean=this.rxWhiteMean===null?whiteMean:this.rxWhiteMean*(1-alpha)+whiteMean*alpha;
  this.markerContrast=this.rxBlackMean-this.rxSyncMean;
  this.syncThresholdUsed=(this.rxSyncMean+this.rxBlackMean)*.5;
 }
 feed(value){
  const n=this.totalSamples++,missing=value===-128;
  if(missing)this.totalMissing++;
  if(!missing){this.sumSoFar+=value;this.squareSoFar+=value*value;this.validSoFar++;}
  const at=(n+1)&1023;
  this.cumSum[at]=this.sumSoFar;this.cumSquare[at]=this.squareSoFar;this.cumValid[at]=this.validSoFar;
  this.advanceRaster(n);
  if(!missing){this.detectHorizontal(n);this.detectVertical(n);}
  this.advanceRaster(n);
  const row=this.p.rows[this.row],rel=n-this.lineStart-PIXEL_OFFSET;
  const position=Math.round(rel);
  if(position>=0&&position<row.width*row.spp){
   const x=this.shiftedX(Math.floor(position/row.spp),row);
   const level=missing?this.snow():this.level(value);
   if(row.spp===1)this.paint(x,this.row,level);
   else if((position%row.spp)===0)this.previousSample=level;
   else this.paint(x,this.row,Math.round((this.previousSample+level)*.5));
  }
  this.advanceRaster(n+1);
 }
 feedBytes(bytes){for(let i=0;i<bytes.length;i++)this.feed(bytes[i]===128?-128:(bytes[i]<<24)>>24);}
 feedMissing(n){for(let k=0;k<n;k++)this.feed(-128);}
 skipMissing(n){
  if(n<=0)return;
  // Avoid processing 100,000 missing samples in JS on the RX main thread.
  // Missing video is shown as snow in its actual raster positions, not accepted
  // or rejected by an imaginary digital-pixel quality test.
  if(n>this.p.fieldSamples*2){
   this.totalSamples+=n;this.totalMissing+=n;
   this.anchored=false;this.hLocked=false;this.hStreak=0;this.hClockStarted=false;
   this.lineStart=this.totalSamples+VBLANK;this.row=0;this.lineSeq=0;this.hSeq=-1;
   this.lowRun=0;this.lowSum=0;this.vCandidate=null;this.hCandidate=null;
   this.resetWaveWindow();
   this.drawSnowFrame();return;
  }
  const end=this.totalSamples+n;
  let loops=0;
  while(this.totalSamples<end && loops++<this.p.rows.length*3+10){
   this.advanceRaster(this.totalSamples);
   const lineEnd=this.lineStart+this.currentPeriod();
   const segmentEnd=Math.min(end,Math.max(this.totalSamples+1,lineEnd));
   const row=this.p.rows[this.row],a=this.totalSamples,b=segmentEnd;
   const low=Math.max(0,Math.ceil((a-this.lineStart-PIXEL_OFFSET)/row.spp));
   const high=Math.min(row.width,Math.ceil((b-this.lineStart-PIXEL_OFFSET)/row.spp));
   for(let x=low;x<high;x++)this.paint(this.shiftedX(x,row),this.row,this.snow());
   this.totalMissing+=b-a;this.totalSamples=b;
   this.advanceRaster(this.totalSamples);
  }
  if(this.totalSamples<end){this.totalMissing+=end-this.totalSamples;this.totalSamples=end;this.drawSnowFrame();}
  // A gap can wipe out the current sync pattern. Keep the raster moving, then
  // let the next legitimate H/V markers establish the new phase.
  this.lowRun=0;this.lowSum=0;this.hCandidate=null;this.vCandidate=null;
  this.resetWaveWindow();
  // The clock survives short serial gaps. A full missed line or two will
  // be corrected by the next H; V can always realign the vertical origin.
  this.hAlternative=null;
 }
 drawSnowFrame(){for(let i=0;i<this.y.length;i++)this.y[i]=this.snow();if(this.u)for(let i=0;i<this.u.length;i++){this.u[i]=this.snow();this.v[i]=this.snow();}this.emitFrame(this.totalSamples);}
}
root.CBAnalogV8=Object.freeze({FS,HSYNC,VSYNC,VPORCH,VBLANK,HOVER,VSEGMENTS,formats,getFormat,getPlan,plan,patternRGBA,sourceFromRGBA,makeWave,Decoder});
root.CBAnalogV7=root.CBAnalogV8; // test harness compatibility
})(typeof globalThis!=='undefined'?globalThis:this);
