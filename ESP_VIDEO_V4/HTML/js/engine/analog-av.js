
/* Analog A/V time multiplex. Only metadata has a CRC. Payload PCM remains
 * analog, including noise. No device, browser process, driver or network I/O. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./av-dc-restoration'),require('./av-control-restoration'));
 else root.CBAnalogAV=factory(root.CBAVDC,root.CBAVControlRestoration);
})(typeof globalThis!=='undefined'?globalThis:this,function(DC,Control){
 'use strict';
 const FS=120000,BLOCK_MS=40,BLOCK_SAMPLES=4800,GUARD=16;
 const LEGACY_VERSION=1,VERSION=2,HEADER_BYTES=26,HEADER_BODY=22,SYMBOL_SAMPLES=3;
 const PILOT_LEVELS=Object.freeze([-110,88,-48,88,-110,-48]),PILOT_RUN=12;
 const PILOT_SAMPLES=PILOT_LEVELS.length*PILOT_RUN,HEADER_SAMPLES=PILOT_SAMPLES+HEADER_BYTES*4*SYMBOL_SAMPLES;
 const GUARD_SAMPLES=GUARD*4,OVERHEAD_SAMPLES=HEADER_SAMPLES+GUARD_SAMPLES;
 const PAM=Object.freeze([-110,-48,20,88]),AUDIO_CENTER=20,AUDIO_PEAK=58;
 const MOD32=4294967296,CAPACITY=16384,MASK=CAPACITY-1,SEARCH_MARGIN=6,RESYNC_MARGIN=512,MAX_GAP=FS*2,MAX_VIDEO_SAMPLES=2000000;
 const CLOCK_HISTORY=2048,CLOCK_LOOKAHEAD=5962,CLOCK_MIN=.95,CLOCK_MAX=1.05;
 const SIGNAL_HOLDOVER_BLOCKS=3;
 const CLOCK_SCALES=Object.freeze([.952,.96,.968,.976,.984,.992,1,1.008,1.016,1.024,1.032,1.04,1.048]);
 const VIDEO_MODES=Object.freeze(['bw64','bw80','bw96','bw128','bw160','bw192','bw256','bw320','bw320stable','bw640','bw640stable','col64','col80','col96','col128','col160','col192','col256','col256stable','col320','col640']);
 const AUDIO_RATES=Object.freeze([8000,12000,16000,24000,32000,44100,48000]);
 const AUDIO_MODES=Object.freeze(AUDIO_RATES.flatMap(rate=>[1,2].map(channels=>Object.freeze({id:rate+'-'+channels,rate,sampleRate:rate,audioRate:rate,channels,audioChannels:channels}))));
 const crcTable=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let b=0;b<8;b++)c=(c>>>1)^((c&1)?0xedb88320:0);crcTable[i]=c>>>0;}
 const caches=new WeakMap();let sessionCounter=(Math.random()*65536)>>>0;
 const clip=(v,a,b)=>Math.max(a,Math.min(b,v)),signed=b=>b===128?-128:(b<<24)>>24;
 function crc32(a,start=0,length=a.length-start){let c=0xffffffff;for(let i=start;i<start+length;i++)c=(c>>>8)^crcTable[(c^a[i])&255];return(c^0xffffffff)>>>0;}
 function put32(a,at,n){for(let i=0;i<4;i++)a[at+i]=n>>>(8*i);}
 function get32(a,at){return(a[at]|a[at+1]<<8|a[at+2]<<16|a[at+3]<<24)>>>0;}
 function unwrap32(n,reference){if(!Number.isFinite(reference))return n>>>0;let value=Math.floor(reference/MOD32)*MOD32+(n>>>0);if(value-reference>MOD32/2)value-=MOD32;else if(reference-value>MOD32/2)value+=MOD32;return value;}
 function integer(n,name,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(n)||n<min||n>max)throw RangeError(name);return n;}
 function plan(C,config={}){
  let videoMode=config.videoMode===undefined?(config.mode||'bw640'):config.videoMode;
  if(config.videoEnabled===false||videoMode==='audio-only'||videoMode==='none'||videoMode===false)videoMode=null;
  if(videoMode&&typeof videoMode==='object')videoMode=videoMode.id;
  const audioRate=Number(config.audioRate??config.sampleRate??16000),audioChannels=Number(config.audioChannels??config.channels??1);
  const legacy=config.audioEnabled===false||config.audioMode==='off'||audioRate===0;
  if(config.blockMs!==undefined&&Number(config.blockMs)!==BLOCK_MS)throw RangeError('Analog AV uses 40 ms blocks');
  let videoFrameSamples=0,videoIndex=255;
  if(videoMode!==null){videoIndex=VIDEO_MODES.indexOf(videoMode);if(videoIndex<0||!C?.plan)throw RangeError('Unsupported AV video format');videoFrameSamples=integer(C.plan(videoMode).fieldSamples,'Video frame sample count',1,MAX_VIDEO_SAMPLES);}
  if(legacy){if(videoMode===null)throw RangeError('No audio or video selected');return Object.freeze({legacy:true,audioOnly:false,videoMode,audioRate:0,audioChannels:0,blockMs:0,blockSamples:0,headerSamples:0,guardSamples:0,audioFramesPerBlock:0,audioSamplesPerBlock:0,videoSamplesPerBlock:0,videoFrameSamples,blocksPerVideoFrame:null,videoFrameSeconds:videoFrameSamples/FS,videoFps:FS/videoFrameSamples,overheadSamplesPerSecond:0});}
  const audioIndex=AUDIO_MODES.findIndex(m=>m.rate===audioRate&&m.channels===audioChannels);if(audioIndex<0)throw RangeError('Unsupported AV audio mode');
  const wireVersion=config.wireVersion??(audioChannels===2?VERSION:LEGACY_VERSION);
  if(wireVersion!==LEGACY_VERSION&&(wireVersion!==VERSION||audioChannels!==2))throw RangeError('Unsupported AV audio layout');
  const planarStereo=wireVersion===VERSION;
  const key=videoIndex+':'+audioIndex+(planarStereo?':'+wireVersion:'');let cache=C&&typeof C==='object'?caches.get(C):null;if(!cache&&C&&typeof C==='object'){cache=new Map();caches.set(C,cache);}if(cache?.has(key))return cache.get(key);
  const audioFramesPerBlock=integer(audioRate*BLOCK_MS/1000,'Nonintegral audio cadence',1),audioSamplesPerBlock=audioFramesPerBlock*audioChannels;
  const videoSamplesPerBlock=BLOCK_SAMPLES-OVERHEAD_SAMPLES-audioSamplesPerBlock;
  if(videoSamplesPerBlock<1)throw RangeError('Audio mode leaves no video slots');
  const blocksPerVideoFrame=videoMode===null?0:Math.ceil(videoFrameSamples/videoSamplesPerBlock),videoFrameSeconds=blocksPerVideoFrame*BLOCK_MS/1000;
  const p=Object.freeze({legacy:false,audioOnly:videoMode===null,videoMode,videoIndex,audioIndex,audioRate,audioChannels,wireVersion,planarStereo,blockMs:BLOCK_MS,blockSamples:BLOCK_SAMPLES,
   headerSamples:HEADER_SAMPLES,guardSamples:GUARD_SAMPLES,guardPerSide:GUARD,audioFramesPerBlock,audioSamplesPerBlock,audioLookaheadFrames:GUARD/audioChannels,
   audioPayloadStart:HEADER_SAMPLES+(planarStereo?GUARD/2:GUARD),videoPayloadStart:HEADER_SAMPLES+audioSamplesPerBlock+GUARD*3,
   videoSamplesPerBlock,videoFrameSamples,blocksPerVideoFrame,videoFrameSeconds,videoFps:videoMode===null?0:1/videoFrameSeconds,
   videoPaddingPerFrame:videoMode===null?0:blocksPerVideoFrame*videoSamplesPerBlock-videoFrameSamples,
   overheadSamplesPerSecond:OVERHEAD_SAMPLES*1000/BLOCK_MS,signature:key});
  cache?.set(key,p);return p;
 }
 function headerBytes(m){
  const a=new Uint8Array(HEADER_BYTES);a[0]=m.plan.wireVersion;a[1]=m.plan.videoIndex;a[2]=m.plan.audioIndex;a[3]=!m.plan.audioOnly&&m.offset===0?1:0;
  a[4]=m.sessionId&255;a[5]=m.sessionId>>>8;put32(a,6,m.audioFrame>>>0);put32(a,10,m.frameId>>>0);put32(a,14,m.offset>>>0);put32(a,18,m.videoPTSFrame>>>0);put32(a,HEADER_BODY,crc32(a,0,HEADER_BODY));return a;
 }
 function writeHeader(dst,m){let at=0;for(const value of PILOT_LEVELS){dst.fill(value&255,at,at+PILOT_RUN);at+=PILOT_RUN;}for(const byte of headerBytes(m))for(let shift=6;shift>=0;shift-=2){dst.fill(PAM[(byte>>>shift)&3]&255,at,at+SYMBOL_SAMPLES);at+=SYMBOL_SAMPLES;}}
 function audioByte(value){return(AUDIO_CENTER+Math.round(AUDIO_PEAK*clip(Number.isFinite(value)?value:0,-1,1)))&255;}
 // Version 2 gives each stereo channel its own contiguous RF slots and guards.
 // It uses the same audio and guard budget as version 1's interleaved L/R.
 function audioSlot(p,frame,channel){
  return p.audioPayloadStart+(p.planarStereo?channel*(p.audioFramesPerBlock+GUARD)+frame:frame*p.audioChannels+channel);
 }
 class Muxer{
  constructor(C,config={},callbacks={}){this.C=C;this.plan=plan(C,config);if(this.plan.legacy)throw Error('Video without audio uses the legacy path');this.readAudio=callbacks.readAudio;this.getVideoFrame=callbacks.getVideoFrame;if(typeof this.readAudio!=='function')throw TypeError('readAudio callback required');if(!this.plan.audioOnly&&typeof this.getVideoFrame!=='function')throw TypeError('getVideoFrame callback required');this.sessionId=callbacks.sessionId===undefined?(++sessionCounter&65535):integer(callbacks.sessionId,'AV session ID',0,65535);this.nextAudioFrame=integer(callbacks.audioStartFrame??0,'Audio start frame');this._nextFrameId=(callbacks.frameId??0)>>>0;this._video=null;this._offset=0;this._tail=new Uint8Array(GUARD);this._tail.fill((-48)&255);this.counters={blocks:0,audioFrames:0,videoFrames:0,videoSamples:0,audioSourceNonfinite:0};this.lastBlockMetadata=null;}
  get requiredAudioEndFrame(){return this.nextAudioFrame+this.plan.audioFramesPerBlock+this.plan.audioLookaheadFrames;}
  _read(start,count){if(start<0)return new Float32Array(count*this.plan.audioChannels);const data=this.readAudio(start,count);if(!data||data.length!==count*this.plan.audioChannels)throw Error('readAudio returned the wrong sample count');return data;}
  nextBlock(){
   const p=this.plan,start=this.nextAudioFrame,look=p.audioLookaheadFrames;
   const audio=this._read(start,p.audioFramesPerBlock),audioPre=this._read(start-look,look),audioPost=this._read(start+p.audioFramesPerBlock,look);
   if(!p.audioOnly&&!this._video){const result=this.getVideoFrame({pts:start/p.audioRate,frameId:this._nextFrameId,audioFrame:start,plan:p});if(!result||!(result.pcm instanceof Uint8Array)||result.pcm.length!==p.videoFrameSamples)throw Error('getVideoFrame returned an invalid waveform');const timestamp=result.timestamp??result.pts??start/p.audioRate;if(!Number.isFinite(timestamp)||timestamp<0)throw RangeError('Invalid video source timestamp');this._video=result.pcm;this._videoPTSFrame=integer(Math.round(timestamp*p.audioRate),'Video source timestamp');this._frameId=this._nextFrameId;this._offset=0;this.counters.videoFrames++;}
   const m={plan:p,sessionId:this.sessionId,audioFrame:start,frameId:p.audioOnly?0:this._frameId,offset:p.audioOnly?0:this._offset,videoPTSFrame:p.audioOnly?0:this._videoPTSFrame};
   const dst=new Uint8Array(BLOCK_SAMPLES);dst.fill((-48)&255);writeHeader(dst,m);
   for(let frame=0;frame<look;frame++)for(let channel=0;channel<p.audioChannels;channel++){
    const i=frame*p.audioChannels+channel;
    dst[audioSlot(p,frame-look,channel)]=audioByte(audioPre[i]);
    dst[audioSlot(p,p.audioFramesPerBlock+frame,channel)]=audioByte(audioPost[i]);
   }
   for(let frame=0;frame<p.audioFramesPerBlock;frame++)for(let channel=0;channel<p.audioChannels;channel++){
    const value=audio[frame*p.audioChannels+channel];
    if(!Number.isFinite(value))this.counters.audioSourceNonfinite++;
    dst[audioSlot(p,frame,channel)]=audioByte(value);
   }
   let count=0,complete=false;
   if(!p.audioOnly){
    const source=this._video,offset=this._offset;count=Math.min(p.videoSamplesPerBlock,source.length-offset);
    for(let i=0;i<GUARD;i++)dst[p.videoPayloadStart-GUARD+i]=offset>=GUARD?source[offset-GUARD+i]:this._tail[i];
    dst.set(source.subarray(offset,offset+count),p.videoPayloadStart);
    for(let i=0;i<GUARD;i++)dst[p.videoPayloadStart+count+i]=offset+count+i<source.length?source[offset+count+i]:(-110)&255;
    this._offset+=count;complete=this._offset===source.length;this.counters.videoSamples+=count;
    if(complete){this._tail.set(source.subarray(source.length-GUARD));this._video=null;this._nextFrameId=(this._frameId+1)>>>0;}
   }
   this.nextAudioFrame+=p.audioFramesPerBlock;this.counters.blocks++;this.counters.audioFrames+=p.audioFramesPerBlock;
   this.lastBlockMetadata={...m,timestamp:m.videoPTSFrame/p.audioRate,audioTimestamp:start/p.audioRate,frameStart:!p.audioOnly&&m.offset===0,frameComplete:complete,videoCount:count};return dst;
  }
 }
 function pilot(read,start){
  let sx=0,sy=0,sxx=0,sxy=0,n=0;
  for(let segment=0;segment<PILOT_LEVELS.length;segment++)for(let j=3;j<9;j++){const x=PILOT_LEVELS[segment],y=read(start+segment*PILOT_RUN+j);if(y===-128)return null;sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;n++;}
  const gain=(sxy-sx*sy/n)/(sxx-sx*sx/n),offset=(sy-gain*sx)/n;if(!Number.isFinite(gain)||gain<.1||gain>3||Math.abs(offset)>150)return null;
  let center=0,timing=0;for(let i=0;i<PILOT_SAMPLES;i++){const y=read(start+i);if(y===-128)return null;const e=(y-offset)/gain-PILOT_LEVELS[Math.floor(i/PILOT_RUN)];timing+=e*e;if(i%PILOT_RUN>=3&&i%PILOT_RUN<9)center+=e*e;}
  if(Math.sqrt(center/n)>18)return null;return {gain,offset,timingError:timing/PILOT_SAMPLES,noise:Math.sqrt(center/n)};
 }
 function parseHeader(C,bytes,calibration){
  if(get32(bytes,HEADER_BODY)!==crc32(bytes,0,HEADER_BODY))return {reason:'crc-error',pilot:calibration};
  if((bytes[0]!==LEGACY_VERSION&&bytes[0]!==VERSION)||bytes[2]>=AUDIO_MODES.length||bytes[3]>1||(bytes[1]!==255&&bytes[1]>=VIDEO_MODES.length))return {reason:'invalid-header',pilot:calibration};
  try{const a=AUDIO_MODES[bytes[2]],p=plan(C,{videoMode:bytes[1]===255?null:VIDEO_MODES[bytes[1]],audioRate:a.rate,audioChannels:a.channels,wireVersion:bytes[0]}),offset=get32(bytes,14);if(p.audioOnly?(offset!==0||bytes[3]!==0):(offset>=p.videoFrameSamples||(bytes[3]===1)!==(offset===0)))return {reason:'invalid-offset',pilot:calibration};
   return {reason:'valid',pilot:calibration,raw:{plan:p,sessionId:bytes[4]|bytes[5]<<8,audioFrame:get32(bytes,6),frameId:get32(bytes,10),offset,videoPTSFrame:get32(bytes,18)}};
  }catch(_){return {reason:'unsupported-config',pilot:calibration};}
 }
 function readHeader(C,read,start){
  const cal=pilot(read,start);if(!cal)return {reason:'pilot-missing'};
  let last={reason:'crc-error',pilot:cal};
  for(const samples of [[0,1,2],[1],[0,1],[1,2]]){
   const bytes=new Uint8Array(HEADER_BYTES);let usable=true;
   for(let s=0;s<HEADER_BYTES*4;s++){let sum=0;for(const phase of samples){const value=read(start+PILOT_SAMPLES+s*SYMBOL_SAMPLES+phase);if(value===-128){usable=false;break;}sum+=value;}if(!usable)break;const value=(sum/samples.length-cal.offset)/cal.gain;let symbol=0,error=Infinity;for(let k=0;k<4;k++){const d=Math.abs(value-PAM[k]);if(d<error){symbol=k;error=d;}}bytes[s>>>2]|=symbol<<(6-(s&3)*2);}
   if(!usable)return {reason:'header-missing',pilot:cal};const result=parseHeader(C,bytes,cal);if(result.raw)return result;last=result;
  }return last;
 }
 function counters(){return {blocks:0,validHeaders:0,headerCrcErrors:0,headerRejected:0,holdoverBlocks:0,signalLosses:0,unverifiedPilotBlocks:0,resyncs:0,phaseCorrections:0,globalSearchSamples:0,globalResyncs:0,clockRebases:0,clockRecoveryAttempts:0,clockRecoveredHeaders:0,clockPilotHoldoverBlocks:0,clockResampledBlocks:0,clockSearchSamples:0,audioFrames:0,audioMissingFrames:0,audioClockGapFrames:0,videoSamples:0,videoMissingSamples:0,videoDuplicateSamples:0,videoFramesSkipped:0,callbackErrors:0,largeGaps:0,maxBufferedSamples:0};}
 class Demuxer{
  constructor(C,callbacks={},options={}){this.C=C;this.callbacks=callbacks;this.clockRecovery=options.clockRecovery!==false;this.signalTimeout=options.signalTimeout!==false;this.dcRestoration=options.dcRestoration===false?null:new (Control?.Corrector||DC.Corrector)();this._videoDCPolicies=new Map();this._ring=new Int16Array(CAPACITY);this.reset();}
  reset(){this.dcRestoration?.reset();this.lastRestoration=null;this.counters=counters();this.stats=this.counters;this.plan=null;this.sessionId=null;this._floor=0;this._end=0;this._searchAt=0;this._locked=false;this._start=0;this._expected=null;this._pending=null;this._recovery=null;this._futureAnchor=null;this._flushing=false;this._clockTracking=false;this._clockRatio=1;this._cal=null;this._clockHint=null;this._frameHint=null;this._lead=0;this._lastVideo=null;this._pilotLossBlocks=0;this._signalLost=false;this.lastError=null;this.state='searching';}
  _read(at){return at<this._floor||at>=this._end?-128:this._ring[at&MASK];}
  _status(state,reason,extra={}){this.state=state;const p=this.plan;const record={state,reason,sessionId:this.sessionId,videoMode:p?.videoMode??null,audioRate:p?.audioRate??null,audioChannels:p?.audioChannels??null,plan:p,counters:{...this.counters},...extra};try{this.callbacks.onStatus?.(record);}catch(error){this.counters.callbackErrors++;this.lastError={callback:'onStatus',message:String(error?.message||error).slice(0,200)};}}
  _emit(name,...args){try{this.callbacks[name]?.(...args);}catch(error){this.counters.callbackErrors++;this.lastError={callback:name,message:String(error?.message||error).slice(0,200)};this._status('error','callback-error',this.lastError);}}
  _coarse(at){let low=0,high=0;for(let i=3;i<6;i++){const a=this._read(at+i),b=this._read(at+PILOT_RUN+i);if(a===-128||b===-128)return false;low+=a;high+=b;}return(high-low)/3>=24;}
  _bestNear(start,radius=SEARCH_MARGIN){let best=null;for(let d=-radius;d<=radius;d++){const at=start+d;if(at<this._floor||at+HEADER_SAMPLES>this._end||!this._coarse(at))continue;const result=readHeader(this.C,n=>this._read(n),at);if(result.raw&&(!best||result.pilot.timingError<best.pilot.timingError))best={...result,start:at};}return best;}
  _find(){
   const last=this._end-HEADER_SAMPLES-SEARCH_MARGIN;
   while(this._searchAt<=last){const at=this._searchAt++;if(at<this._floor)continue;
    if(!this._coarse(at))continue;
    const result=readHeader(this.C,n=>this._read(n),at);if(result.raw){const best=this._bestNear(at);if(best)return best;}
   }
   this._floor=Math.max(this._floor,this._searchAt-SEARCH_MARGIN);return null;
  }
  _recoverHeader(){
   // A finite RAW-TX underrun inserts RF samples without moving the source
   // clock. Searching only +/-512 could otherwise misroute audio forever.
   if(this._futureAnchor)return this._futureAnchor;
   if(!this._recovery||this._recovery.origin!==this._start)this._recovery={origin:this._start,at:Math.max(this._floor,this._start-RESYNC_MARGIN)};
   const last=Math.min(this._start+BLOCK_SAMPLES,this._end-HEADER_SAMPLES-SEARCH_MARGIN);
   while(this._recovery.at<=last){
    const at=this._recovery.at++;this.counters.globalSearchSamples++;
    if(!this._coarse(at))continue;
    const result=readHeader(this.C,n=>this._read(n),at);
    if(result.raw){const best=this._bestNear(at)||{...result,start:at};best.recovered=true;return best;}
   }
   return null;
  }
  _futurePhase(found){
   const current=this._expected,r=found.raw,p=current?.plan;
   if(!p||r.sessionId!==this.sessionId||r.plan.signature!==p.signature)return null;
   const audioFrame=unwrap32(r.audioFrame,current.audioFrame),next=this._predict(current);
   if(audioFrame!==next.audioFrame||r.frameId!==next.frameId||r.offset!==next.offset)return null;
   const phase=found.start-(this._start+BLOCK_SAMPLES),start=this._start+phase;
   // A nearby future CRC confirms the current window after an isolated bad
   // header. Keep that intact analog payload instead of skipping one song block.
   return Math.abs(phase)<=RESYNC_MARGIN&&start>=this._floor?start:null;
  }
  _recoveredMetadata(found){
   const same=found.raw.sessionId===this.sessionId&&found.raw.plan.signature===this.plan?.signature;
   const frame=unwrap32(found.raw.audioFrame,this._expected?.audioFrame),jump=same&&this._expected?frame-this._expected.audioFrame:0;
   const rebase=same&&(jump<0||jump>found.raw.plan.audioRate*2);
   const oldLead=this._lead,oldVideo=this._lastVideo;
   if(rebase){this._locked=false;this._lastVideo=null;this._lead=0;}
   const metadata=this._metadata(found);this._locked=true;
   if(rebase){if(metadata)this.dcRestoration?.reset();else{this._lead=oldLead;this._lastVideo=oldVideo;}}
   if(metadata&&found.recovered){this.counters.globalResyncs++;this.counters.resyncs++;if(rebase)this.counters.clockRebases++;this._status('locked','header-reacquired',{sessionChanged:rebase,clockRebased:rebase,audioJumpFrames:jump});}
   return metadata;
  }
  _linear(at){const index=Math.floor(at),fraction=at-index,a=this._read(index);if(a===-128||fraction===0)return a;const b=this._read(index+1);return b===-128?-128:a+(b-a)*fraction;}
  _clockPilots(center,reference){
   const candidates=[];
   for(let shift=this._clockTracking?-96:-CLOCK_HISTORY;shift<=(this._clockTracking?96:RESYNC_MARGIN);shift++){
    const start=Math.round(center)+shift;if(start<this._floor||start+76>=this._end)continue;
    if(this._read(start+16)-this._read(start+4)<20)continue;
    this.counters.clockSearchSamples++;
    let best=null;for(const scale of CLOCK_SCALES){
     const cal=pilot(i=>this._linear(start+i*scale),0);
     if(!cal||cal.gain<reference.gain*.65||cal.gain>reference.gain*1.5||cal.noise>12||cal.timingError>1600)continue;
     if(!best||cal.timingError<best.cal.timingError)best={start,cal};
    }
    if(best){candidates.push(best);candidates.sort((a,b)=>a.cal.timingError-b.cal.timingError);if(candidates.length>16)candidates.pop();}
   }
   candidates.sort((a,b)=>a.cal.timingError-b.cal.timingError);
   const best=[];for(const candidate of candidates){if(best.some(value=>Math.abs(value.start-candidate.start)<.9))continue;best.push(candidate);if(best.length===4)break;}return best;
  }
  _clockHeaderMatches(raw,next=false){
   const expected=next?this._predict(this._expected):this._expected;
   if(!raw||!expected||raw.sessionId!==this.sessionId||raw.plan.signature!==expected.plan.signature||raw.audioFrame!==(expected.audioFrame>>>0)||raw.frameId!==expected.frameId||raw.offset!==expected.offset)return false;
   const pts=unwrap32(raw.videoPTSFrame,expected.audioFrame);
   return raw.plan.audioOnly||Math.abs(pts-expected.audioFrame)<=raw.plan.audioRate*(raw.plan.videoFrameSeconds+5);
  }
  _recoverClock(nativeFuture=null){
   if(!this.clockRecovery||!this._expected||!this._cal)return null;
   this.counters.clockRecoveryAttempts++;
   const first=this._clockPilots(this._start,this._cal);if(!first.length)return null;
   const second=nativeFuture&&this._clockHeaderMatches(nativeFuture.raw,true)?[{start:nativeFuture.start,cal:nativeFuture.pilot,native:nativeFuture}]:this._clockPilots(this._start+BLOCK_SAMPLES*(this._clockTracking?this._clockRatio:1),this._cal);
   const deltas=[0,-.0002083333,.0002083333,-.0004166667,.0004166667,-.000625,.000625,-.0008333333,.0008333333,-.00125,.00125,-.0016666667,.0016666667,-.0025,.0025],phases=[0,-.5,.5,-.125,.125,-.25,.25,-.375,.375,-.625,.625,-.75,.75,-.875,.875,-1,1];
   let trials=0;
   for(const a of first)for(const b of second){
    const ratio=(b.start-a.start)/BLOCK_SAMPLES;if(ratio<CLOCK_MIN||ratio>CLOCK_MAX)continue;
    if(b.native&&Math.abs(ratio-1)<.001)return null;
    for(const delta of deltas)for(const phase of phases){
     const scale=ratio+delta;if(scale<CLOCK_MIN||scale>CLOCK_MAX)continue;
     if(++trials>512)return null;
     const origin=a.start+phase,read=i=>this._linear(origin+i*scale),header=readHeader(this.C,read,0);
     if(this._clockHeaderMatches(header.raw))return {found:{...header,start:Math.round(origin),recovered:true},read,nextStart:b.start,ratio:scale,confirmed:'current-header-crc'};
    }
    // Only a verified following header can authorize pilot-only holdover.
    // Exactly flat windows retain their original byte path.
    if(Math.abs(ratio-1)>.0005){
     let following=b.native;
     if(!following){for(const delta of deltas){const next=readHeader(this.C,i=>this._linear(b.start+i*(ratio+delta)),0);if(this._clockHeaderMatches(next.raw,true)){following={...next,start:b.start};break;}}}
     if(following&&this._clockHeaderMatches(following.raw,true)){
      const read=i=>this._linear(a.start+i*ratio),cal=pilot(read,0);
      if(cal&&cal.noise<12&&cal.gain>this._cal.gain*.65&&cal.gain<this._cal.gain*1.5)return {found:null,read,cal,start:a.start,nextStart:b.start,ratio,confirmed:'next-header-crc'};
     }
    }
   }
   return null;
  }
  _metadata(found){
   const r=found.raw,p=r.plan,same=this._locked&&this._expected&&this.sessionId===r.sessionId&&this.plan?.signature===p.signature;
   const reference=same?this._expected.audioFrame:this._clockHint;
   let audioFrame=unwrap32(r.audioFrame,reference),frameSequence=unwrap32(r.frameId,same?this._expected.frameSequence:this._frameHint);
   let restarted=false;
   if(same){const jump=audioFrame-this._expected.audioFrame;if(jump!==0&&r.frameId===0&&r.offset===0){audioFrame=r.audioFrame;frameSequence=0;restarted=true;}else if(jump<0||jump>p.audioRate*2)return null;else if(jump>0){this.counters.audioClockGapFrames+=jump;this.counters.audioMissingFrames+=jump;}}
   const changed=this.sessionId!==r.sessionId||this.plan?.signature!==p.signature||restarted;
   if(changed){audioFrame=r.audioFrame;frameSequence=r.frameId;this._lastVideo=null;this._lead=0;}
   const videoPTSFrame=p.audioOnly?0:unwrap32(r.videoPTSFrame,audioFrame);
   if(!p.audioOnly&&Math.abs(videoPTSFrame-audioFrame)>p.audioRate*(p.videoFrameSeconds+5))return null;
   const meta={plan:p,sessionId:r.sessionId,audioFrame,frameId:r.frameId,frameSequence,offset:r.offset,videoPTSFrame,timestampEstimated:false,headerValid:true,discontinuity:this._signalLost};
   this.plan=p;this.sessionId=r.sessionId;if(!p.audioOnly&&r.offset===0)this._lead=videoPTSFrame-audioFrame;
   if(changed)this._status('locked','new-session',{sessionChanged:true,restarted});return meta;
  }
  _predict(m){const p=m.plan,next={...m,audioFrame:m.audioFrame+p.audioFramesPerBlock,headerValid:false};if(!p.audioOnly){const count=Math.min(p.videoSamplesPerBlock,p.videoFrameSamples-m.offset);next.offset+=count;if(next.offset>=p.videoFrameSamples){next.offset=0;next.frameId=(m.frameId+1)>>>0;next.frameSequence=m.frameSequence+1;next.videoPTSFrame=next.audioFrame+this._lead;next.timestampEstimated=true;}}return next;}
  _videoMissing(meta,from,to){for(let offset=from;offset<to;offset+=BLOCK_SAMPLES){const size=Math.min(BLOCK_SAMPLES,to-offset),pcm=new Uint8Array(size);pcm.fill(128);this.counters.videoSamples+=size;this.counters.videoMissingSamples+=size;this._emit('onVideo',pcm,{...meta,offset,frameStart:offset===0,frameComplete:offset+size===meta.frameSamples,missingSamples:size,headerValid:false,holdover:true});}}
  _video(pcm,meta){
   const prior=this._lastVideo;
   if(prior&&prior.frameSequence!==meta.frameSequence){this._videoMissing(prior,prior.nextOffset,prior.frameSamples);if(meta.frameSequence>prior.frameSequence+1)this.counters.videoFramesSkipped+=meta.frameSequence-prior.frameSequence-1;this._lastVideo=null;}
   const expected=this._lastVideo?.nextOffset??0;
   if(meta.offset>expected)this._videoMissing(meta,expected,meta.offset);
   if(meta.offset<expected){const skip=Math.min(pcm.length,expected-meta.offset);this.counters.videoDuplicateSamples+=skip;pcm=pcm.subarray(skip);meta={...meta,offset:meta.offset+skip,frameStart:false};if(!pcm.length)return;}
   this.counters.videoSamples+=pcm.length;this.counters.videoMissingSamples+=meta.missingSamples;this._emit('onVideo',pcm,meta);
   this._lastVideo=meta.frameComplete?null:{...meta,nextOffset:meta.offset+pcm.length};
  }
  _restoreVideoFor(p){
   if(!p.videoMode)return false;
   if(!this._videoDCPolicies.has(p.videoMode)){
    const longest=this.C.plan(p.videoMode).rows.reduce((n,row)=>Math.max(n,row.len),0);
    // Frequent black/white porches already clamp short lines. Keep their raw
    // video unchanged when a line spans <=10% of the firmware DC time constant.
    this._videoDCPolicies.set(p.videoMode,longest*DC.BETA>.10);
   }
   return this._videoDCPolicies.get(p.videoMode);
  }
  _route(start,m,cal,headerValid,restoration=null,sourceRead=null,clock=null){
   const original=sourceRead||((i)=>this._read(start+i)),corrected=!!restoration?.active,read=corrected?restoration.read:original;
   if(corrected)cal=restoration.calibration;
   const p=m.plan,samples=new Float32Array(p.audioSamplesPerBlock),valid=new Uint8Array(p.audioFramesPerBlock);valid.fill(1);let missing=0;
   // Validity belongs to the received byte. A valid restored float may itself
   // equal -128; that amplitude is not the missing-byte sentinel.
   for(let frame=0;frame<p.audioFramesPerBlock;frame++)for(let channel=0;channel<p.audioChannels;channel++){
    const at=audioSlot(p,frame,channel),index=frame*p.audioChannels+channel;
    if(original(at)===-128)valid[frame]=0;
    else samples[index]=clip(((read(at)-cal.offset)/cal.gain-AUDIO_CENTER)/AUDIO_PEAK,-1,1);
   }
   for(const value of valid)if(!value)missing++;
   this.counters.audioFrames+=p.audioFramesPerBlock;this.counters.audioMissingFrames+=missing;
   const common={sessionId:m.sessionId,videoMode:p.videoMode,audioRate:p.audioRate,audioChannels:p.audioChannels,sampleRate:p.audioRate,channels:p.audioChannels,plan:p,headerValid,holdover:!headerValid,discontinuity:!!m.discontinuity,clockRecovered:!!clock,clockRatio:clock?.ratio||1,clockConfirmedBy:clock?.confirmed||null,dcRestored:corrected,dcReason:restoration?.reason||'disabled'};
   this._emit('onAudio',{...common,timestamp:m.audioFrame/p.audioRate,audioStartFrame:m.audioFrame,samples,valid,missingFrames:missing});
   if(!p.audioOnly){
    const restoreVideo=corrected&&!restoration.audioOnly&&this._restoreVideoFor(p),readVideo=restoreVideo?read:original;
    if(this.lastRestoration)this.lastRestoration.videoApplied=restoreVideo;
    const count=Math.min(p.videoSamplesPerBlock,p.videoFrameSamples-m.offset),video=new Uint8Array(count);let unavailable=0;
    const videoOffset=restoreVideo?(restoration.videoOffset||0):0;
    for(let i=0;i<count;i++){const at=p.videoPayloadStart+i,missing=original(at)===-128;video[i]=missing?128:clip(Math.round(readVideo(at)+videoOffset),-127,127)&255;if(missing)unavailable++;}
    const frameComplete=m.offset+count===p.videoFrameSamples;
    const metadata={...common,dcRestored:restoreVideo,dcAudioRestored:corrected,timestamp:m.videoPTSFrame/p.audioRate,videoPTSFrame:m.videoPTSFrame,frameId:m.frameId,frameSequence:m.frameSequence,offset:m.offset,frameStart:m.offset===0,frameComplete,frameSamples:p.videoFrameSamples,timestampEstimated:!!m.timestampEstimated,missingSamples:unavailable};
    this._video(video,metadata);
   }
  }
  _process(){
   for(let guard=0;guard<64;guard++){
    if(!this._locked){const found=this._find();if(!found)return;const meta=this._metadata(found);if(!meta){this._searchAt=found.start+1;continue;}this._locked=true;this._start=found.start;this._expected=meta;this._pending=found;this._cal=found.pilot;this.counters.resyncs++;}
    if(this._end<this._start+BLOCK_SAMPLES+SEARCH_MARGIN)return;
    let found=this._pending||(this._futureAnchor?.start===this._start?this._futureAnchor:null),phaseFromFuture=null,nativeFuture=null,clock=null;
    this._pending=null;
    if(found===this._futureAnchor)this._futureAnchor=null;
    if(!found&&!this._recovery)found=this._bestNear(this._start)||this._bestNear(this._start,RESYNC_MARGIN);
    if(!found){
     found=this._recoverHeader();
     if(found){phaseFromFuture=this._futurePhase(found);if(phaseFromFuture!==null){nativeFuture=found;this._futureAnchor=found;found=null;}}
     else if(!this._flushing&&this._end<this._start+BLOCK_SAMPLES+HEADER_SAMPLES+SEARCH_MARGIN)return;
    }
    if(!found&&this.clockRecovery){
     if(!this._flushing&&this._end<this._start+CLOCK_LOOKAHEAD)return;
     clock=this._recoverClock(nativeFuture);
     if(clock){this._futureAnchor=null;phaseFromFuture=null;found=clock.found;}
    }
    // A phase correction may move the required payload end beyond the current
    // input chunk. Commit metadata/session callbacks and counters only once the
    // complete corrected block is available; a retry must have no side effects.
    if(found&&this._end<found.start+BLOCK_SAMPLES+SEARCH_MARGIN){this._pending=found;return;}
    let meta=null,valid=false,start=clock?.start??phaseFromFuture??this._start,cal=clock?.cal||this._cal;
    if(this._end<start+BLOCK_SAMPLES+SEARCH_MARGIN)return;
    if(found){meta=found.recovered?this._recoveredMetadata(found):this._metadata(found);if(!meta&&!found.recovered){found.recovered=true;meta=this._recoveredMetadata(found);}if(meta){valid=true;start=found.start;cal=found.pilot;if(start!==this._start)this.counters.phaseCorrections++;this._cal=cal;this.counters.validHeaders++;}}
    if(phaseFromFuture!==null&&start!==this._start)this.counters.phaseCorrections++;
    let pilotPresent=valid||!!clock?.cal;
    if(!meta){meta={...this._expected,headerValid:false,discontinuity:false};const observed=readHeader(this.C,clock?clock.read:n=>this._read(n),clock?0:start);pilotPresent=pilotPresent||!!observed.pilot;if(observed.reason==='crc-error')this.counters.headerCrcErrors++;else this.counters.headerRejected++;if(clock?.cal)cal=clock.cal;else if(observed.pilot&&phaseFromFuture!==null)cal=observed.pilot;this.counters.holdoverBlocks++;}
    this._pilotLossBlocks=pilotPresent?0:this._pilotLossBlocks+1;
    if(!pilotPresent)this.counters.unverifiedPilotBlocks++;
    // Keep holdover while the pilot survives. Without a pilot for 120 ms,
    // mark the last block missing and reacquire from a verified header.
    if(this.signalTimeout&&this._pilotLossBlocks>=SIGNAL_HOLDOVER_BLOCKS){
     this._route(start,meta,cal,false,null,()=>-128,null);this.counters.blocks++;this.counters.signalLosses++;
     this._clockHint=meta.audioFrame+meta.plan.audioFramesPerBlock;this._frameHint=meta.frameSequence;
     this._start=start+BLOCK_SAMPLES;this._floor=Math.max(this._floor,this._start-RESYNC_MARGIN);this._searchAt=this._start;
     this._locked=false;this._expected=this._pending=this._recovery=this._futureAnchor=null;this._clockTracking=false;this._clockRatio=1;this._signalLost=true;this._lastVideo=null;
     this.dcRestoration?.reset();this.lastRestoration=null;this._status('searching','signal-lost');continue;
    }
    const sourceRead=clock?.read||((i)=>this._read(start+i));
    const restoration=this.dcRestoration?.process(sourceRead,meta,{crcValid:valid,calibration:cal,clockRatio:clock?.ratio||1});
    this.lastRestoration=restoration?{active:!!restoration.active,audioOnly:!!restoration.audioOnly,reason:restoration.reason,beta:restoration.beta,history:restoration.history,holdover:!!restoration.holdover,uncertainty:restoration.uncertainty,videoOffset:restoration.videoOffset}:null;
    if(clock){this.counters.clockResampledBlocks++;if(valid)this.counters.clockRecoveredHeaders++;else this.counters.clockPilotHoldoverBlocks++;this._clockRatio=clock.ratio;this._clockTracking=true;}else if(valid){this._clockRatio=1;this._clockTracking=false;}
    this._route(start,meta,cal,valid,restoration,clock?.read||null,clock);if(valid)this._signalLost=false;this.counters.blocks++;this._expected=this._predict(meta);this._clockHint=this._expected.audioFrame;this._frameHint=this._expected.frameSequence;
    this._start=clock?Math.round(clock.nextStart):start+BLOCK_SAMPLES;this._recovery=null;this._floor=Math.max(this._floor,this._start-(this.clockRecovery?CLOCK_HISTORY:RESYNC_MARGIN));this._status(valid?'locked':'holdover',clock?'clock-recovered':valid?'header-valid':'header-unverified');
   }
  }
  _append(value){if(this._end-this._floor>=CAPACITY){this._floor=this._end-CAPACITY+1;this._locked=false;this._pending=this._recovery=this._futureAnchor=null;this._clockTracking=false;this._clockRatio=1;this._searchAt=this._floor;this._status('searching','buffer-overrun');}this._ring[this._end&MASK]=value;this._end++;this.counters.maxBufferedSamples=Math.max(this.counters.maxBufferedSamples,this._end-this._floor);}
  feedBytes(bytes){if(!(bytes instanceof Uint8Array))throw TypeError('AV PCM input must be Uint8Array');for(let at=0;at<bytes.length;at+=512){const end=Math.min(bytes.length,at+512);for(let i=at;i<end;i++)this._append(signed(bytes[i]));this._process();}}
  feedMissing(count){
   integer(count,'Missing sample count',0);if(!count)return;
   if(count>MAX_GAP){
    this.dcRestoration?.reset();
    this.lastRestoration=null;
    this.counters.largeGaps++;const p=this.plan;if(p){const missing=Math.round(count*p.audioRate/FS),timestamp=(this._expected?.audioFrame??this._clockHint??0)/p.audioRate;this.counters.audioMissingFrames+=missing;this._emit('onAudio',{sessionId:this.sessionId,videoMode:p.videoMode,audioRate:p.audioRate,audioChannels:p.audioChannels,sampleRate:p.audioRate,channels:p.audioChannels,plan:p,timestamp,samples:new Float32Array(0),valid:new Uint8Array(0),missingFrames:missing,gapSeconds:count/FS,discontinuity:true});this._clockHint=(this._expected?.audioFrame??this._clockHint??0)+missing;}
    if(this._lastVideo){const m=this._lastVideo;this._videoMissing(m,m.nextOffset,m.frameSamples);this._lastVideo=null;}
    this._end+=count;this._floor=this._end;this._searchAt=this._end;this._locked=false;this._pending=this._recovery=this._futureAnchor=null;this._clockTracking=false;this._clockRatio=1;this._status('searching','large-index-gap');return;
   }
   for(let at=0;at<count;at+=512){const end=Math.min(count,at+512);for(let i=at;i<end;i++)this._append(-128);this._process();}
  }
  flush(){this._flushing=true;try{this._process();if(this._locked&&this._end-this._start>SEARCH_MARGIN){const needed=this._start+BLOCK_SAMPLES+SEARCH_MARGIN-this._end;if(needed>0&&needed<=BLOCK_SAMPLES+SEARCH_MARGIN)this.feedMissing(needed);this._process();}}finally{this._flushing=false;}return this.counters;}
 }
 return Object.freeze({VERSION,FS,BLOCK_MS,BLOCK_SAMPLES,HEADER_BYTES,HEADER_SAMPLES,GUARD_SAMPLES,OVERHEAD_SAMPLES,AUDIO_CENTER,AUDIO_PEAK,VIDEO_MODES,AUDIO_RATES,AUDIO_MODES,PAM,PILOT_LEVELS,PILOT_RUN,crc32,unwrap32,plan,Muxer,Demuxer});
});
