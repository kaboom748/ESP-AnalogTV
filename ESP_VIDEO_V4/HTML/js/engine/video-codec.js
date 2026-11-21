
/* Derived from ESP_VIDEO_V2, commit99f36c3a2c1a. Exact-byte legacy acceleration.
 * Legacy decoding and timing remain unchanged. Additional formats may select
 * pixel endpoints and an explicit bounded clock-correction range.
 * Default outputs own memory; Into APIs use explicit caller-owned buffers. */
/*
  CB-VIDEO HTMLv4 / 120 ksample/s -- real PCM8, explicit RED loss pixels, no simulated RF noise.
  Retains CB FM STEREO V12 radio processing; negotiates MPX4 CRC32 with legacy MPX3 fallback.
  Pixels never have CRC, packet validity, FEC, or retransmission.
  H/V pulse detection controls the raster only. Actual RF distortion remains visible.
*/
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.CBAnalogV8=api;root.CBAnalogV7=api;}
})(typeof globalThis!=='undefined'?globalThis:this,function(){
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
// HTMLv3: full-resolution progressive monochrome, 1 or 2 PCM8 samples per pixel.
// H/V timing and reference porches are identical to HTMLv2; only raster size differs.
formats.push({id:'bw640',label:'640 × 480 · B&W (1 sample/pixel)',kind:'mono',w:640,h:480,spp:1});
formats.push({id:'bw640stable',label:'640 × 480 · B&W stable (2 samples/pixel)',kind:'mono',w:640,h:480,spp:2});
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
const registeredFormats=formats.slice();
function registerFormat(descriptor){
 const value=descriptor||{},id=value.id;
 if(typeof id!=='string'||id.length<1||id.length>64)throw Error('Invalid format ID');
 const {w,h,spp,kind}=value;
 if(!Number.isInteger(w)||w<1||w>4096||!Number.isInteger(h)||h<1||h>1024)throw Error('Invalid format dimensions');
 if(spp!==1&&spp!==2)throw Error('Invalid samples per pixel');
 if(kind!=='mono'&&kind!=='color')throw Error('Invalid format kind');
 if(kind==='color'&&(w%2||h%2))throw Error('Color dimensions must be even');
 const pixelBlack=value.pixelBlack??PIXEL_BLACK,pixelWhite=value.pixelWhite??PIXEL_WHITE;
 if(!Number.isInteger(pixelBlack)||!Number.isInteger(pixelWhite)||
  pixelBlack<=BLACK_REF||pixelBlack>=pixelWhite||pixelWhite>=WHITE_REF)throw Error('Pixel endpoints must be integers strictly inside black/white references');
 if(value.autoPeriodLimit!==undefined&&(!Number.isFinite(value.autoPeriodLimit)||value.autoPeriodLimit<=0))throw Error('Invalid automatic period limit');
 const previous=byId.get(id);
 if(previous){
  if(previous.w!==w||previous.h!==h||previous.spp!==spp||previous.kind!==kind||
   (previous.pixelBlack??PIXEL_BLACK)!==pixelBlack||(previous.pixelWhite??PIXEL_WHITE)!==pixelWhite||
   previous.autoPeriodLimit!==value.autoPeriodLimit)throw Error('Format ID already registered with different geometry or levels');
  return previous;
 }
 const mode=Object.freeze({id,label:typeof value.label==='string'?value.label:id,kind,w,h,spp,pixelBlack,pixelWhite,
  ...(value.autoPeriodLimit!==undefined?{autoPeriodLimit:value.autoPeriodLimit}:{})});
 const timing=getPlan(mode);byId.set(id,mode);planCache.set(id,timing);registeredFormats.push(mode);
 return mode;
}
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

const fastCounts={sourcePlaneAllocations:0,sourcePlaneBytes:0,previewAllocations:0,previewBytes:0,waveAllocations:0,waveBytes:0,templateAllocations:0,templateBytes:0,sourceIntoCalls:0,prepareCalls:0,waveIntoCalls:0};
const pixelPCMLUTs=new Map();
function pixelPCMLUT(mode){
 const black=mode.pixelBlack??PIXEL_BLACK,white=mode.pixelWhite??PIXEL_WHITE,key=black+':'+white;
 if(!pixelPCMLUTs.has(key))pixelPCMLUTs.set(key,Uint8Array.from({length:256},(_,value)=>enc(black+Math.round((white-black)*value/255))));
 return pixelPCMLUTs.get(key);
}
const waveTemplates=new Map(),sourceControlLUTs=new Map();
function allocatePlane(length){fastCounts.sourcePlaneAllocations++;fastCounts.sourcePlaneBytes+=length;return new Uint8Array(length);}
function sourceTarget(modeId,target){
 const m=getFormat(modeId),size=m.w*m.h,out=target||{};
 if(!out.y||out.y.length!==size)out.y=allocatePlane(size);
 if(m.kind==='color'){
  if(!out.u||out.u.length!==size/4)out.u=allocatePlane(size/4);
  if(!out.v||out.v.length!==size/4)out.v=allocatePlane(size/4);
 }else{out.u=null;out.v=null;}
 out.id=m.id;return out;
}
function chromaFromRGBA(m,rgba,source){
 const {y,u,v}=source;
 for(let py=0;py<m.h;py+=2)for(let px=0;px<m.w;px+=2){
  let us=0,vs=0;
  for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
   const p=(py+dy)*m.w+px+dx,j=p*4,yy=y[p];
   us+=(rgba[j+2]-yy)/1.772+128;vs+=(rgba[j]-yy)/1.402+128;
  }
  const k=(py/2)*(m.w/2)+px/2;
  u[k]=clamp(Math.round(us/4),0,255);v[k]=clamp(Math.round(vs/4),0,255);
 }
}
function sourceFromRGBAInto(modeId,rgba,target){
 const m=getFormat(modeId),size=m.w*m.h;
 if(!rgba||rgba.length!==size*4)throw Error('Invalid RGBA source image');
 const source=sourceTarget(modeId,target),y=source.y;fastCounts.sourceIntoCalls++;
 for(let i=0,j=0;i<size;i++,j+=4)y[i]=clamp(Math.round(.299*rgba[j]+.587*rgba[j+1]+.114*rgba[j+2]),0,255);
 if(m.kind==='color')chromaFromRGBA(m,rgba,source);
 return source;
}
function sourceFromRGBA(modeId,rgba){return sourceFromRGBAInto(modeId,rgba,null);}
function sourceControls(m,options){
 const levels=options.grayLevels===undefined?256:Number(options.grayLevels),contrast=options.contrast===undefined?1:Number(options.contrast);
 const key=m.kind+':'+levels+':'+contrast;if(sourceControlLUTs.has(key))return sourceControlLUTs.get(key);
 const lut=new Uint8Array(256);
 for(let i=0;i<256;i++){
  const value=Math.max(0,Math.min(255,(i-128)*contrast+128));
  lut[i]=m.kind==='color'?Math.round(value):Math.round(Math.round(value*(levels-1)/255)*255/(levels-1));
 }
 sourceControlLUTs.set(key,lut);while(sourceControlLUTs.size>16)sourceControlLUTs.delete(sourceControlLUTs.keys().next().value);
 return lut;
}
function prepareSourceInto(modeId,rgba,options={},target){
 const m=getFormat(modeId),size=m.w*m.h;
 if(!rgba||rgba.length!==size*4)throw Error('Invalid RGBA source image');
 const out=target||{},source=sourceTarget(modeId,out.source),lut=sourceControls(m,options);
 if(!out.pixels||out.pixels.length!==size*4){out.pixels=new Uint8ClampedArray(size*4);fastCounts.previewAllocations++;fastCounts.previewBytes+=size*4;}
 const pixels=out.pixels;
 if(pixels.buffer&&rgba.buffer&&pixels.buffer===rgba.buffer)throw Error('Preview scratch must not alias source RGBA');
 for(let i=0,j=0;i<size;i++,j+=4){
  if(m.kind==='mono'){
   const gray=lut[Math.round(.299*rgba[j]+.587*rgba[j+1]+.114*rgba[j+2])];
   pixels[j]=pixels[j+1]=pixels[j+2]=source.y[i]=gray;
  }else{
   const r=lut[rgba[j]],g=lut[rgba[j+1]],b=lut[rgba[j+2]];
   pixels[j]=r;pixels[j+1]=g;pixels[j+2]=b;
   source.y[i]=clamp(Math.round(.299*r+.587*g+.114*b),0,255);
  }
  pixels[j+3]=rgba[j+3];
 }
 if(m.kind==='color')chromaFromRGBA(m,pixels,source);
 out.source=source;fastCounts.prepareCalls++;return out;
}
function prepareSource(modeId,rgba,options={}){return prepareSourceInto(modeId,rgba,options,null);}
function waveformTemplate(modeId){
 const p=plan(modeId);if(waveTemplates.has(p.mode.id)){const cached=waveTemplates.get(p.mode.id);waveTemplates.delete(p.mode.id);waveTemplates.set(p.mode.id,cached);return cached;}
 const wave=new Uint8Array(p.fieldSamples),rows=[];wave.fill(enc(BLACK_REF));
 for(const [lo,hi,isSync]of VSEGMENTS)wave.fill(enc(isSync?SYNC:WHITE_REF),lo,hi);
 let at=VBLANK;
 for(const row of p.rows){
  wave.fill(enc(SYNC),at,at+HSYNC);wave.fill(enc(WHITE_REF),at+HSYNC+BLACK,at+HSYNC+BLACK+WHITE);
  rows.push({...row,offset:at+PIXEL_OFFSET});at+=row.len;
 }
 if(at!==wave.length)throw Error('Scan timing: unexpected frame length');
 const result={wave,rows};waveTemplates.set(p.mode.id,result);
 while(waveTemplates.size>2)waveTemplates.delete(waveTemplates.keys().next().value);
 fastCounts.templateAllocations++;fastCounts.templateBytes+=wave.length;return result;
}
function makeWaveInto(source,modeId,target){
 const p=plan(modeId),m=p.mode;
 if(!source||source.id!==m.id)throw Error('Source/mode mismatch');
 if(!(target instanceof Uint8Array)||target.length!==p.fieldSamples)throw Error('Wave target/mode mismatch');
 for(const plane of [source.y,source.u,source.v])if(plane?.buffer===target.buffer)throw Error('Wave target must not alias source planes');
 const template=waveformTemplate(modeId),lut=pixelPCMLUT(m);target.set(template.wave);
 for(const row of template.rows){
  const arr=row.plane==='u'?source.u:row.plane==='v'?source.v:source.y,from=row.y*row.width;
  if(row.spp===1)for(let x=0;x<row.width;x++)target[row.offset+x]=lut[arr[from+x]];
  else for(let x=0;x<row.width;x++){const value=lut[arr[from+x]],at=row.offset+x*2;target[at]=target[at+1]=value;}
 }
 fastCounts.waveIntoCalls++;return target;
}
function makeWave(source,modeId){
 const p=plan(modeId),wave=new Uint8Array(p.fieldSamples);fastCounts.waveAllocations++;fastCounts.waveBytes+=wave.length;
 return makeWaveInto(source,modeId,wave);
}
function getFastStats(){return {...fastCounts,cachedTemplateModes:waveTemplates.size,liveTemplateBytes:[...waveTemplates.values()].reduce((n,value)=>n+value.wave.length,0),pixelLUTBytes:pixelPCMLUTs.size*256,pixelLUTs:pixelPCMLUTs.size,liveControlLUTBytes:sourceControlLUTs.size*256};}

class Decoder{
 constructor({mode='bw320',threshold=-78,brightness=0,contrast=1,saturation=1,hPosition=0,hHold=0,vHold=0,hLock=.85,onFrame=()=>{}}={}){
  this.onFrame=onFrame;this.onHSignal=null;
  this.totalSamples=0;this.totalMissing=0;this.invalidSamples=0;this.gapSamples=0;
  this.redPixelsLast=0;this.verticalSyncs=0;this.horizontalSyncs=0;
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
  this.lastShapeH=-1e12;this.lastVShape=-1e12;this.hShapeCandidate=null;
  this.rxSyncMean=null;this.rxBlackMean=null;this.rxWhiteMean=null;
  this.autoLevel=true;this.markerContrast=0;
  this.recoverySamples=0;
  this.fieldParity=0;
  // A valid bit is set ONLY after an actual, non-0x80 PCM8 value has been
  // received for that pixel. Missing positions render pure RED (255,0,0).
  // This validity bitmap is NOT a second picture buffer or a frame gate.
  this.y=new Uint8Array(this.m.w*this.m.h);this.y.fill(95);
  this.yValid=new Uint8Array(this.y.length);
  if(this.m.kind==='color'){
   this.u=new Uint8Array(this.m.w*this.m.h/4);this.v=new Uint8Array(this.u.length);
   this.u.fill(128);this.v.fill(128);
   this.uValid=new Uint8Array(this.u.length);this.vValid=new Uint8Array(this.v.length);
  }else {this.u=null;this.v=null;this.uValid=null;this.vValid=null;}
  this.bitmap=new Uint8ClampedArray(this.m.w*this.m.h*4);
  this.previousSample=0;this.previousSampleValid=false;
 }
 reset(clearCounters=false){
  if(clearCounters){this.totalSamples=0;this.totalMissing=0;this.invalidSamples=0;this.gapSamples=0;this.redPixelsLast=0;this.verticalSyncs=0;this.horizontalSyncs=0;this.fields=0;this.frames=0;this.falseH=0;this.hLost=0;this.hReacquired=0;this.vRejected=0;}
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
  this.hPosition=clamp(+hPosition||0,-this.m.w,this.m.w);
  this.hHold=clamp(+hHold||0,-5,5);this.vHold=clamp(+vHold||0,-180,600);
  this.hLock=clamp(Number.isFinite(+hLock)?+hLock:.85,0,1);
 }
 level(raw){
  // Porches act as a sync-tip / black-level clamp. This is analog AGC/DC
  // restoration, not a pixel-error check or digital error correction.
  const pixelBlack=this.m.pixelBlack??PIXEL_BLACK,pixelWhite=this.m.pixelWhite??PIXEL_WHITE;
  let black=pixelBlack,white=pixelWhite;
  if(this.autoLevel && this.rxBlackMean!==null && this.rxWhiteMean!==null){
   const gain=clamp((this.rxWhiteMean-this.rxBlackMean)/(WHITE_REF-BLACK_REF),.05,2.8);
   black=this.rxBlackMean+(pixelBlack-BLACK_REF)*gain;
   white=this.rxBlackMean+(pixelWhite-BLACK_REF)*gain;
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
  if(desc.plane==='y'){
   const k=desc.y*m.w+x;this.y[k]=value;this.yValid[k]=1;
  }else if(desc.plane==='u'){
   const k=desc.y*(m.w/2)+x;this.u[k]=value;this.uValid[k]=1;
  }else {
   const k=desc.y*(m.w/2)+x;this.v[k]=value;this.vValid[k]=1;
  }
 }
 markMissing(x,row){
  const desc=this.p.rows[row],m=this.m;
  if(desc.plane==='y')this.yValid[desc.y*m.w+x]=0;
  else if(desc.plane==='u')this.uValid[desc.y*(m.w/2)+x]=0;
  else this.vValid[desc.y*(m.w/2)+x]=0;
 }
 compose(){
  const m=this.m,rgba=this.bitmap,source=this.y,uvW=m.w/2;
  let red=0;
  for(let y=0;y<m.h;y++)for(let x=0;x<m.w;x++){
   const i=y*m.w+x,j=i*4,yy=source[i];let r=yy,g=yy,b=yy;
   let valid=this.yValid[i]===1;
   if(m.kind==='color'){
    const uv=(Math.floor(y/2)*uvW)+Math.floor(x/2);
    valid=valid&&this.uValid[uv]===1&&this.vValid[uv]===1;
    if(valid){
     const du=(this.u[uv]-128)*this.saturation,dv=(this.v[uv]-128)*this.saturation;
     r=clamp(Math.round(yy+1.402*dv),0,255);
     g=clamp(Math.round(yy-.344136*du-.714136*dv),0,255);
     b=clamp(Math.round(yy+1.772*du),0,255);
    }
   }
   // RED means 'unknown video data' — never simulated radio noise.
   if(!valid){r=255;g=0;b=0;red++;}
   rgba[j]=r;rgba[j+1]=g;rgba[j+2]=b;rgba[j+3]=255;
  }
  this.redPixelsLast=red;
  return rgba.slice();
 }
 emitFrame(at){
  this.fields++;this.frames++;this.lastFrameAt=at;
  const picture=this.compose();
  this.onFrame(picture,{fields:this.fields,frames:this.frames,verticalSyncs:this.verticalSyncs,
    horizontalSyncs:this.horizontalSyncs,anchored:this.anchored,hLocked:this.hLocked,
    missingSamples:this.totalMissing,invalidSamples:this.invalidSamples,gapSamples:this.gapSamples,
    redPixels:this.redPixelsLast,totalPixels:this.m.w*this.m.h,
    hMisses:this.hLost,falseH:this.falseH,hReacquired:this.hReacquired,
    hPhaseError:this.hPhaseError,lineClockErrorSamples:this.autoPeriod});
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
    this.y.fill(72);this.yValid.fill(0);
     if(this.u){this.u.fill(128);this.v.fill(128);this.uValid.fill(0);this.vValid.fill(0);}
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
  this.lastShapeH=-1e12;this.vCandidate=null;this.hShapeCandidate=null;
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
 finishHorizontalCandidate(n){
  const candidate=this.hShapeCandidate;
  if(!candidate||n<candidate.until)return;
  this.hShapeCandidate=null;this.lastShapeH=candidate.start;
  this.hCandidates++;this.hShapes++;
  if(this.onHSignal)this.onHSignal(candidate.start);
  this.onHorizontal(candidate.start,n,HSYNC,candidate.a.mean,candidate.b.mean,candidate.c.mean);
 }
 detectHorizontal(n){
  const start=n+1-(HSYNC+BLACK+WHITE);
  if(start<this.windowEpoch||start-this.lastShapeH<18)return;
  // Once locked, look near the predicted line boundary. A false H in image
  // content must not tug the horizontal oscillator across the screen.
  if(this.hLocked && Math.abs(start-this.lineStart)>22 && this.hMissStreak<10)return;
  const a=this.stat(start,start+HSYNC),b=this.stat(start+HSYNC,start+HSYNC+BLACK);
  const c=this.stat(start+HSYNC+BLACK,start+HSYNC+BLACK+WHITE);
  if(!a||!b||!c||a.n<17||b.n<8||c.n<8)return;
  const d1=b.mean-a.mean,d2=c.mean-b.mean,span=c.mean-a.mean;
  if(span<12||d1<Math.max(2,span*.08)||d2<Math.max(3,span*.20))return;
  if(!this.autoThreshold&&a.mean>=this.threshold)return;
  // Flatness is normalized to the RECEIVED amplitude. Absolute standard-
  // deviation thresholds made low-gain signals latch one or two samples early.
  if(a.sd>span*.24||b.sd>span*.24||c.sd>span*.24)return;
  const score=(a.sd*a.sd*a.n+b.sd*b.sd*b.n+c.sd*c.sd*c.n)/((a.n+b.n+c.n)*span*span);
  if(score>.04)return;
  // Choose the best local alignment, not the first passing window. Six samples
  // still leave at least two samples before the first active pixel at offset56.
  const prior=this.hShapeCandidate;
  if(!prior)this.hShapeCandidate={start,score,a,b,c,until:n+6};
  else if(score<prior.score-1e-12)this.hShapeCandidate={start,score,a,b,c,until:prior.until};
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
  if(contrast<12)return -1;
  // A vertical sync marker is a FLAT pulse train, unlike random FM noise.
  // This is a check on the reserved sync waveform only, not on image pixels.
  if(lows.some(s=>s.sd>Math.max(2,contrast*.30)) ||
     porches.some(s=>s.sd>Math.max(2,contrast*.35)))return -1;
  // H and V have different pulse widths and need not retain identical sync-tip
  // amplitudes after the real RF channel. Compare DC-invariant contrasts;
  // do not veto a genuine V merely because a short H was attenuated more.
  if(this.hLocked&&this.rxWhiteMean!==null&&this.rxBlackMean!==null&&
     contrast<(this.rxWhiteMean-this.rxBlackMean)*1.05)return -1;
  if(!this.autoThreshold&&low>=this.threshold)return -1;
  if(lows.some(s=>Math.abs(s.mean-low)>Math.max(2,contrast*.40))||
     porches.some(s=>Math.abs(s.mean-porch)>Math.max(2,contrast*.45)))return -1;
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
  if(score>=12){
   this.vCandidates++;
   if(!this.vCandidate||score>this.vCandidate.score)this.vCandidate={start,score,until:n+20};
  }
 }
 onVertical(start,n){
  const wasHLocked=this.hLocked;
  this.lastVAt=start;this.verticalSyncs++;this.anchored=true;this.hClockStarted=true;
  if(this.row>this.p.rows.length*.70 && n-this.lastFrameAt>this.p.fieldSamples*.55)this.emitFrame(n);
  this.row=0;this.lineStart=start+VBLANK;
  this.y.fill(72);this.yValid.fill(0);
  if(this.u){this.u.fill(128);this.v.fill(128);this.uValid.fill(0);this.vValid.fill(0);}
  this.hMissStreak=0;this.lineSeq=0;this.hSeq=-1;
  this.hAlternative=null;this.hShapeCandidate=null;this.hPhaseError=0;
  this.lastHAt=-1e12;this.lastHLineLength=0;
  // The V back porch is also an actual received black reference. It can
  // re-establish the clamp after a large gain change while H was unavailable.
  const lowStats=VSEGMENTS.filter(s=>s[2]).map(([lo,hi])=>this.stat(start+lo+5,start+hi-5));
  const whiteStats=VSEGMENTS.filter(s=>!s[2]).map(([lo,hi])=>this.stat(start+lo+3,start+hi-3));
  const black=this.stat(start+VSYNC+3,Math.min(this.totalSamples,start+VBLANK-3));
  if(lowStats.every(Boolean)&&whiteStats.every(Boolean)&&black&&black.n>=6){
   const low=lowStats.reduce((s,v)=>s+v.mean,0)/lowStats.length;
   const white=whiteStats.reduce((s,v)=>s+v.mean,0)/whiteStats.length;
   if(black.mean>low+(white-low)*.10&&black.mean<white-(white-low)*.20){
    this.rxSyncMean=low;this.rxBlackMean=black.mean;this.rxWhiteMean=white;
    this.markerContrast=black.mean-low;this.syncThresholdUsed=(low+black.mean)*.5;
   }
  }
  if(wasHLocked)this.hStreak=Math.max(3,this.hStreak);
 }
 onHorizontal(start,n,run,syncMean,blackMean,whiteMean){
  if(start>=this.lastVAt && start<this.lastVAt+VBLANK-10)return;
  const prev=this.lastHAt,prevLen=this.lastHLineLength;
  const length=this.p.rows[this.row].len;
  const periodLimit=this.m.autoPeriodLimit??3;
  // Outside the expected flyback window, require reserved-reference contrast
  // continuity. Image plateaus can imitate H shape, but must not drag a held
  // oscillator into active video. Near the predicted top, allow real gain/DC
  // changes immediately instead of waiting a whole slow frame for V.
  const predictedError=this.hClockStarted?start-this.lineStart:0;
  if(this.rxSyncMean!==null&&this.rxBlackMean!==null&&this.rxWhiteMean!==null&&Math.abs(predictedError)>22){
   const depth=blackMean-syncMean,whiteSpan=whiteMean-blackMean;
   if(depth<Math.max(2,(this.rxBlackMean-this.rxSyncMean)*.35)||
      whiteSpan<Math.max(3,(this.rxWhiteMean-this.rxBlackMean)*.65)){
    this.falseH++;return;
   }
  }
  if(prev>-1e11&&start-prev<.58*Math.min(length,prevLen)){this.falseH++;return;}
  const delta=prev>-1e11?start-prev:0;
  const plausible=prev<=-1e11||this.lineLengths.some(l=>Math.abs(delta-l)<Math.max(13,l*.012));
  const skipped=prev>-1e11&&this.lineLengths.some(l=>Math.abs(delta-2*l)<23);
  const first=!this.hClockStarted;
  let err=first?0:start-this.lineStart,reacquired=false,periodObservation=null;
  if(!first&&(!plausible&&!skipped||Math.abs(err)>(this.hLocked?22:55))){
   const alt=this.hAlternative;
   const candidateDelta=alt?start-alt.start:0;
   const matching=this.lineLengths.find(l=>candidateDelta>0&&Math.abs(candidateDelta-l)<Math.max(13,l*.012));
   const coherent=alt&&matching!==undefined;
   const streak=coherent?alt.streak+1:1;
   const observed=coherent?candidateDelta-matching-this.hHold:0;
   this.hAlternative={start,streak,periodError:coherent?(alt.periodError*(streak-2)+observed)/(streak-1):0};
   if(streak<3){this.falseH++;return;}
   reacquired=true;periodObservation=this.hAlternative.periodError;
  }
  // No rejected candidate above can change the oscillator, row, calibration,
  // or pixels. A coherent reacquisition deliberately releases the stale lastH.
  this.hAlternative=null;
  if(first){
   this.hClockStarted=true;this.lineStart=start;this.row=0;this.lineSeq=0;
   this.hSeq=-1;this.hStreak=0;this.autoPeriod=0;
  }else if(reacquired){
   this.hReacquired++;this.lineStart=start;err=0;this.hStreak=2;this.hLocked=false;
   this.autoPeriod=clamp(periodObservation,-periodLimit,periodLimit);
  }
  this.horizontalSyncs++;this.lastHAt=start;this.lastHLineLength=length;
  this.hStreak=plausible||reacquired?Math.min(255,this.hStreak+1):Math.max(1,this.hStreak);
  this.hSeq=this.lineSeq;this.hMissStreak=0;
  if(this.hStreak>=3)this.hLocked=true;
  this.hPhaseError=err;
  const gain=this.hLocked?this.hLock:.65;
  this.lineStart+=clamp(err*gain,-38,38);
  if(!reacquired&&prev>-1e11 && plausible && delta>0){
   this.autoPeriod=clamp(.97*this.autoPeriod+.03*(delta-prevLen-this.hHold),-periodLimit,periodLimit);
  }
  // A line clamp follows the received back porch, not an old multi-line DC
  // average. Smooth only gain/contrast; available image samples remain intact.
  if(this.rxBlackMean===null){
   this.rxSyncMean=syncMean;this.rxBlackMean=blackMean;this.rxWhiteMean=whiteMean;
  }else{
   const oldSpan=this.rxWhiteMean-this.rxBlackMean,newSpan=whiteMean-blackMean;
   const oldDepth=this.rxBlackMean-this.rxSyncMean,newDepth=blackMean-syncMean;
   const gainAlpha=newSpan<oldSpan*.70||newSpan>oldSpan*1.45?.75:.10;
   const span=oldSpan*(1-gainAlpha)+newSpan*gainAlpha;
   const depth=oldDepth*.85+newDepth*.15;
   this.rxBlackMean=blackMean;this.rxWhiteMean=blackMean+span;this.rxSyncMean=blackMean-depth;
  }
  this.markerContrast=this.rxBlackMean-this.rxSyncMean;
  this.syncThresholdUsed=(this.rxSyncMean+this.rxBlackMean)*.5;
 }
 feed(value,missingSource='firmware'){
  const n=this.totalSamples++,missing=value===-128;
  if(missing){
   this.totalMissing++;
   if(missingSource==='gap')this.gapSamples++;
   else this.invalidSamples++;
  }
  if(!missing){this.sumSoFar+=value;this.squareSoFar+=value*value;this.validSoFar++;}
  const at=(n+1)&1023;
  this.cumSum[at]=this.sumSoFar;this.cumSquare[at]=this.squareSoFar;this.cumValid[at]=this.validSoFar;
  this.advanceRaster(n);
  this.finishHorizontalCandidate(n);
  if(!missing){this.detectHorizontal(n);this.detectVertical(n);}
  this.advanceRaster(n);
  const row=this.p.rows[this.row],rel=n-this.lineStart-PIXEL_OFFSET;
  const position=Math.round(rel);
  if(position>=0&&position<row.width*row.spp){
   const x=this.shiftedX(Math.floor(position/row.spp),row);
   if(row.spp===1){
    if(missing)this.markMissing(x,this.row);
    else this.paint(x,this.row,this.level(value));
   }else if((position%row.spp)===0){
    this.previousSampleValid=!missing;
    if(!missing)this.previousSample=this.level(value);
    else this.markMissing(x,this.row);
   }else if(missing||!this.previousSampleValid){
    this.markMissing(x,this.row);
   }else this.paint(x,this.row,Math.round((this.previousSample+this.level(value))*.5));
  }
  this.advanceRaster(n+1);
 }
 feedBytes(bytes){for(let i=0;i<bytes.length;i++)this.feed(bytes[i]===128?-128:(bytes[i]<<24)>>24,'firmware');}
 feedMissing(n){for(let k=0;k<n;k++)this.feed(-128,'gap');}
 skipMissing(n){
  if(n<=0)return;
  // Advance the analog timebase through absent MPX3 samples.
  // Unknown video positions are marked RED, never replaced by random data.
  if(n>this.p.fieldSamples*2){
   this.totalSamples+=n;this.totalMissing+=n;this.gapSamples+=n;
   this.anchored=false;this.hLocked=false;this.hStreak=0;this.hClockStarted=false;
   this.lineStart=this.totalSamples+VBLANK;this.row=0;this.lineSeq=0;this.hSeq=-1;
   this.lowRun=0;this.lowSum=0;this.vCandidate=null;this.hCandidate=null;
   this.resetWaveWindow();
   this.showSignalLoss('Large serial timeline gap');return;
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
   for(let x=low;x<high;x++)this.markMissing(this.shiftedX(x,row),this.row);
   this.totalMissing+=b-a;this.gapSamples+=b-a;this.totalSamples=b;
   this.advanceRaster(this.totalSamples);
  }
  if(this.totalSamples<end){
   this.totalMissing+=end-this.totalSamples;this.gapSamples+=end-this.totalSamples;
   this.totalSamples=end;this.showSignalLoss('Serial sample timeline interrupted');
  }
  // A gap can wipe out the current sync pattern. Keep the raster moving, then
  // let the next legitimate H/V markers establish the new phase.
  this.lowRun=0;this.lowSum=0;this.hCandidate=null;this.vCandidate=null;
  this.resetWaveWindow();
  // The clock survives short serial gaps. A full missed line or two will
  // be corrected by the next H; V can always realign the vertical origin.
  this.hAlternative=null;
 }
 showSignalLoss(reason='No PCM samples arriving'){
  // UI state only. No fictitious PCM sample is fed to the video decoder.
  const picture=new Uint8ClampedArray(this.m.w*this.m.h*4);
  for(let j=0;j<picture.length;j+=4){picture[j]=255;picture[j+1]=0;picture[j+2]=0;picture[j+3]=255;}
  this.redPixelsLast=this.m.w*this.m.h;
  this.onFrame(picture,{redPixels:this.redPixelsLast,totalPixels:this.redPixelsLast,
    invalidSamples:this.invalidSamples,gapSamples:this.gapSamples,
    missingSamples:this.totalMissing,signalLoss:reason});
 }
}
return Object.freeze({FS,HSYNC,VSYNC,VPORCH,VBLANK,HOVER,VSEGMENTS,formats,registeredFormats,registerFormat,getFormat,getPlan,plan,patternRGBA,sourceFromRGBA,sourceFromRGBAInto,prepareSource,prepareSourceInto,makeWave,makeWaveInto,getFastStats,Decoder});
});
