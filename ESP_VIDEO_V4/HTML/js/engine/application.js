
/* CB-VIDEO HTMLv4 — Web Serial RX displays real PCM8; missing samples render red. */
(()=>{
'use strict';
const C=globalThis.CBStrictVideo.createFacade(globalThis.CBAnalogV8),$=id=>document.getElementById(id);
globalThis.CBVideoMAX=C;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),ascii=new TextEncoder();
const RATE=C.FS,PREBUFFER=12000,WRITE_BLOCK=2400,PREFIX=[77,80,88,51];
const SERIAL_BAUD=1500000,SERIAL_PACE=150000;
const {createProbe,compare}=globalThis.CBRadioAcquisition;
const {detectRadioModel,defaultTxPowerForModel}=globalThis.CBRadioPower;
const FINE_STEPS=[0,35000,45000,25000,-35000,-45000,-25000,10000,-10000,50000,-50000];
const lastFineByPort=new WeakMap();
const txPowerByPort=new WeakMap();
const rxCapture=new globalThis.CBRXCapture.RXCapture({seconds:16,rate:RATE});
let modeId='col320',cameraStream=null,cameraActive=false,imageSource='pattern';
let cameraGeneration=0,cameraPending=false;
let preparedSource=null,sourceRGBA=null,scanFrame=null,scanOffset=0,txFieldCount=0;
let txBytes=0,txBytesAtLast=0,txRateAtLast=performance.now(),txMaxLate=0;
let rxBytes=0,rxBytesAtLast=0,rxRateAtLast=performance.now();
let rxLastIndex=null,lastRxPacketAt=0,rxLossShown=false,rxFramesWindow=[],session=null,pending=[],connecting=false;
let rxDecode=null, autoLineProbe=null,avApp=null;
/* RX_PROGRESS_OBSERVER_BEGIN */
const rxProgress=globalThis.CBRXProgress.create({C});
globalThis.CBReceiverProgress=Object.freeze({snapshot:()=>rxProgress.snapshot({
 role:$('role').value,connected:session?.state==='rx',usage:$('avUsage').value
})});
function feedObservedVideo(bytes,meta){
 if(meta){rxDecode.feedBytes(bytes);rxProgress.observeAV(bytes,meta);return;}
 const last=globalThis.CBRXProgress.lastReceivedIndex(bytes);
 if(last<0){rxDecode.feedBytes(bytes);return;}
 const split=last+1;
 const prefix=split===bytes.length?bytes:bytes.subarray(0,split);
 rxDecode.feedBytes(prefix);
 rxProgress.observeLegacy(rxDecode,prefix);
 if(split<bytes.length)rxDecode.feedBytes(bytes.subarray(split));
}
/* RX_PROGRESS_OBSERVER_END */
let easyApp=null,connectGeneration=0,activeConnectGeneration=0,easySelectedPort=null,easyVideoSource='camera',activeCameraSelection='';
const easyAction={generation:0,busy:false,message:'',error:false,ownedMic:null,ownedCamera:null,pendingMic:false,pendingCamera:false};
const previewCtx=$('preview').getContext('2d',{alpha:false}),receivedCtx=$('received').getContext('2d',{alpha:false});
const scratch=document.createElement('canvas'),scratchCtx=scratch.getContext('2d',{willReadFrequently:true});
const imgCam=$('cameraVideo');
const fmt=()=>C.getFormat(modeId),plan=()=>C.plan(modeId);
// Application integration: bounded two-frame ownership and optional TX7.
let maxFrameCache=null,maxFrameLease=null,maxPrepareTimer=null,maxCacheKey='';
let maxSourceScratch={},maxAcquisitionSequence=0;
let maxCaptureSettings=null;
function maxControls(){return {grayLevels:Number($('grayLevels').value),contrast:Number($('contrast').value)};}
function maxReadRGBA(forceCamera=false){
 const m=fmt();
 if(forceCamera&&cameraActive&&imgCam.readyState>=2&&imgCam.videoWidth){
  try{scratchCtx.drawImage(imgCam,0,0,m.w,m.h);sourceRGBA=scratchCtx.getImageData(0,0,m.w,m.h).data;}
  catch(error){log('Webcam capture: '+error.message);}
 }
 if(!sourceRGBA||sourceRGBA.length!==m.w*m.h*4)sourceRGBA=C.patternRGBA(modeId);
 return sourceRGBA;
}
function maxResetFrames(){
 if(maxPrepareTimer!==null){clearTimeout(maxPrepareTimer);maxPrepareTimer=null;}
 if(maxFrameLease&&maxFrameCache)maxFrameCache.release(maxFrameLease);
 maxFrameLease=null;if(maxFrameCache)maxFrameCache.cancelQueued();
 maxFrameCache=null;maxCacheKey='';scanFrame=null;scanOffset=0;
}
function maxEnsureCache(){
 const key=modeId+':'+C.getProfile();
 if(!maxFrameCache||maxCacheKey!==key){
  maxResetFrames();maxCacheKey=key;
  maxFrameCache=globalThis.CBSourceWaveCache.create({C,mode:modeId,slots:2});
 }
 return maxFrameCache;
}
function maxPrepareFrame(){
 const cache=maxEnsureCache();if(cache.getState().queued||!cache.getState().free)return;
 const frame=cache.prepareFrom(()=>maxReadRGBA(imageSource==='camera'),maxControls(),{acquisitionSequence:maxAcquisitionSequence++});
 preparedSource=frame.source;drawPreview(frame.pixels);maxUpdateUI();
 return frame;
}
function maxScheduleFrame(){
 if(avApp?.isMixed())return; // Capture at actual A/V frame boundaries, not ahead.
 if(maxPrepareTimer!==null||!session?.txRunning||!maxFrameCache||maxFrameCache.getState().queued)return;
 maxPrepareTimer=setTimeout(()=>{
  maxPrepareTimer=null;
  if(!session?.txRunning||session.closing)return;
  try{maxPrepareFrame();}catch(error){session.txRunning=false;status('Video preparation: '+error.message,true);log(error.message);}
 },0);
}
function maxGetPcm(count){
 if(!Number.isSafeInteger(count)||count<0)throw RangeError('Invalid PCM request');
 const dst=new Uint8Array(count);let at=0;
 while(at<count){
  const cache=maxEnsureCache();
  if(!maxFrameLease){
   if(!cache.getState().queued)maxPrepareFrame();
   maxFrameLease=cache.next();scanFrame=maxFrameLease.pcm;scanOffset=0;txFieldCount++;
  }
  const take=Math.min(count-at,scanFrame.length-scanOffset);
  dst.set(scanFrame.subarray(scanOffset,scanOffset+take),at);at+=take;scanOffset+=take;
  if(scanOffset===scanFrame.length){cache.release(maxFrameLease);maxFrameLease=null;scanFrame=null;scanOffset=0;}
  else if(scanFrame.length-scanOffset<=WRITE_BLOCK*3)maxScheduleFrame();
 }
 return dst;
}
async function maxConfigureTX7(own){
 own.tx7Capability=null;
 try{
  const reply=await commandAwait('TX7?\n',line=>!!globalThis.ESPVideoTX7.parseCapability(line),900,own);
  own.tx7Capability=globalThis.ESPVideoTX7.parseCapability(reply);
 }catch(error){log('TX transport: direct PCM compatible with the connected firmware.');}
 maxUpdateUI();
}
async function maxWritePCM(pcm,own){
 if(!own||own!==session||own.closing)throw Error('Inactive video stream');
 const payload=own.tx7Encoder?own.tx7Encoder.encode(pcm):pcm;
 const writeStartedAt=performance.now();
 await write(payload,own);own.maxUsbBytes=(own.maxUsbBytes||0)+payload.length;
 return {wireBytes:payload.length,writeStartedAt};
}
function maxUpdateUI(){
 const item=C.descriptor(modeId),gain=(item.fpsRatio-1)*100;
 $('maxInfo').textContent=`${item.target.w} × ${item.target.h} · all Y${item.target.kind==='color'?'/U/V':''} pixels transmitted · ${item.group} line(s) per guard · ${item.radioGrayLevels} RF levels · ${item.fps.toFixed(3)} calculated FPS${gain>0?' (+'+gain.toFixed(1)+'%)':''}.`;
 $('auto320').disabled=!!avApp?.isMixed();
 const own=session;
 $('maxTxTransport').textContent=own?.tx7Capability?'TX7 available · indices + CRC, unchanged RF PCM':'Direct TX · 1,500,000 baud · 120,000 samples/s';
 const state=maxFrameCache?.getState();
 $('maxPrepState').textContent=state?`${state.queued} prepared frame(s) · ${state.inFlight} in flight · ${(state.stats.explicitPoolBytes/1048576).toFixed(2)} MiB in bounded TX buffers`:'Two-bank video preparation without an accumulated history.';
 $('maxSourceInfo').textContent=maxCaptureSettings?`Camera: ${maxCaptureSettings.width||'?'} × ${maxCaptureSettings.height||'?'} · ${maxCaptureSettings.frameRate||'?'} frames/s reported by the device`:'The displayed rate is the RF scan rate; the camera may provide fewer distinct frames.';
 if($('mode').options)for(const option of $('mode').options){
  if(!C.formats.some(format=>format.id===option.value))continue;
  const m=C.getFormat(option.value),p=C.plan(option.value);
  let fps=p.frameFps;option.disabled=false;
  if(avApp?.isMixed()){
   const config=avApp.config();
   if(config.usage!=='audio'){
    fps=globalThis.CBAnalogAV.plan(C,{videoMode:option.value,audioRate:Number(config.audioRate),audioChannels:Number(config.audioChannels)}).videoFps;
    option.disabled=config.fpsPolicy==='floor'&&fps+1e-10<Number(config.minFps);
   }
  }
  option.textContent=m.label+' · '+fps.toFixed(3)+' FPS'+(avApp?.isMixed()?' with this audio':'');
 }
 if(avApp){
  const p=avApp.getPlan();$('targetFps').textContent=p.videoFps.toFixed(3)+' predicted FPS';
  $('fieldDuration').textContent=(p.legacy?plan().fieldSamples*1000/RATE:(p.videoFrameSeconds||0)*1000).toFixed(1)+' ms';
  $('lineHz').textContent=(plan().rows.length*(p.videoFps||0)).toFixed(1)+' Hz (average)';
  if(!p.legacy){
   $('maxInfo').textContent=`${item.target.w} × ${item.target.h} · all Y${item.target.kind==='color'?'/U/V':''} pixels preserved · ${p.videoFps.toFixed(3)} predicted FPS with this audio (${item.fps.toFixed(3)} without audio).`;
  }
  avApp.update();
 }
}
function maxInitUI(){
 maxUpdateUI();
}
function getMaxState(){return {profile:C.getProfile(),descriptor:C.descriptor(modeId),cache:maxFrameCache?.getState()||null,
 acquisitions:maxAcquisitionSequence,tx7:!!session?.tx7Encoder,usbBytes:session?.maxUsbBytes||0};}

function log(message){
 const t=new Date().toLocaleTimeString('en-US',{hour12:false});
 $('log').textContent=($('log').textContent+`[${t}] ${message}\n`).split('\n').slice(-60).join('\n');
 $('log').scrollTop=$('log').scrollHeight;
}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function formatNumber(n,places=2){return n.toFixed(places);}
function resizeCanvases(){
 const m=fmt();
 for(const id of ['preview','received']){$(id).width=m.w;$(id).height=m.h;}
 scratch.width=m.w;scratch.height=m.h;
}
function presentReceivedVideo(rgba,info){
  // Never invent RF noise: valid PCM pixels are shown as received.
  // Pure red pixels indicate unavailable 0x80 or missing MPX3 samples.
  if(rgba.length===fmt().w*fmt().h*4){
   receivedCtx.putImageData(new ImageData(rgba,fmt().w,fmt().h),0,0);
   const count=info.redPixels||0,amount=info.totalPixels||fmt().w*fmt().h;
   $('redPixels').textContent=count.toLocaleString('en-US')+' / '+amount.toLocaleString('en-US');
   $('rxLossStatus').textContent=info.signalLoss
     ? 'NO PCM DATA — '+info.signalLoss+' · screen marked red (not RF noise)'
     : 'Latest raster: '+(100*count/amount).toFixed(1)+'% unavailable pixels marked red; real received PCM is never synthesized.';
   if(!info.signalLoss)rxFramesWindow.push(performance.now());
  }
}
function makeDecoder(){
 /* RX_PROGRESS_RESET */ rxProgress.reset(modeId);
 rxDecode=new C.Decoder({mode:modeId,onFrame:(rgba,info)=>{
  if(avApp?.isMixed()&&!info.signalLoss)avApp.queuePicture(rgba,info);
  else presentReceivedVideo(rgba,info);
 }});
 rxDecode.onHSignal=start=>{if(!avApp?.isMixed()&&autoLineProbe && $('auto320').checked && ['bw320','bw320stable'].includes(modeId))autoLineProbe.acceptH(start);};
 updateRxControls();
}
function drawPreview(rgba){
 const m=fmt();
 previewCtx.putImageData(new ImageData(rgba,m.w,m.h),0,0);
}
function createSource(forceCamera=false){
 const rgba=maxReadRGBA(forceCamera),prepared=C.prepareSourceInto(modeId,rgba,maxControls(),maxSourceScratch);
 preparedSource=prepared.source;drawPreview(prepared.pixels);return preparedSource;
}
function selectedMode(){
 maxResetFrames();maxSourceScratch={};
 const m=fmt(),p=plan();
 $('grayLevels').disabled=m.kind==='color';
 $('saturationRow').classList.toggle('hidden',m.kind!=='color');
 $('srcRes').textContent=`${m.w} × ${m.h}`;
 $('targetFps').textContent=formatNumber(p.frameFps)+' FPS';
 $('fieldFps').textContent='Progressive';
 $('lineHz').textContent=formatNumber(C.FS/(p.fieldSamples-C.VBLANK)*(p.rows.length),1)+' Hz (average)';
 $('fieldDuration').textContent=formatNumber(p.fieldSamples*1000/RATE,1)+' ms';
 $('modeKind').textContent=m.kind==='color'?'Analog YUV 4:2:0':'Progressive B&W';
 $('rxLabel').textContent=m.kind==='color'?'RX · COLOR':'RX · B&W';
 const hMax=m.w; // HTMLv3: H-POSITION also spans the new 640-pixel raster.
 $('hPosition').min=String(-hMax);$('hPosition').max=String(hMax);
 if(Math.abs(+$('hPosition').value)>hMax)$('hPosition').value='0';
 resizeCanvases();makeDecoder();maxUpdateUI();
 rxLastIndex=null;scanFrame=null;scanOffset=0;
 preparedSource=null;sourceRGBA=null;
 createSource(false);
 status(session?.state==='rx'?'RX: automatically searching for H pulses, then V pulses. TX and RX must use the same video format.':`Format ${m.label} · ${formatNumber(p.frameFps)} theoretical FPS.`);
 log(`Mode ${m.id}: ${p.fieldSamples} samples/frame, ${formatNumber(p.frameFps,3)} frames/s (progressive).`);
}
function initModes(){
 const groups=[['Progressive black and white',C.formats.filter(f=>f.kind==='mono')],['Progressive YUV 4:2:0 color',C.formats.filter(f=>f.kind==='color')]];
 for(const [label,formats] of groups){
  const g=document.createElement('optgroup');g.label=label;
  for(const mode of formats){
   const p=C.plan(mode.id),op=document.createElement('option');op.value=mode.id;
   op.textContent=`${mode.label} · ${formatNumber(p.frameFps)} FPS`;
   g.append(op);
  }
  $('mode').append(g);
 }
 $('mode').value=modeId;
}
async function startCamera(){
 easyVideoSource='camera';
 const generation=++cameraGeneration;let acquired=null;cameraPending=true;
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access blocked. Try http://localhost in Chrome/Edge.');
  if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());
  cameraStream=null;cameraActive=false;imageSource='pattern';maxCaptureSettings=null;imgCam.srcObject=null;
  status('Waiting for the selected webcam…');
  const video={width:{ideal:640},height:{ideal:480},frameRate:{ideal:24}};
  const device=avApp?.config().cameraDeviceId;if(device)video.deviceId={exact:device};
  acquired=await navigator.mediaDevices.getUserMedia({video,audio:false});
  if(generation!==cameraGeneration||avApp?.config().usage==='audio'){acquired.getTracks().forEach(t=>t.stop());return;}
  cameraStream=acquired;imgCam.srcObject=acquired;await imgCam.play();
  if(generation!==cameraGeneration){acquired.getTracks().forEach(t=>t.stop());return;}
  maxCaptureSettings=acquired.getVideoTracks?.()[0]?.getSettings?.()||null;maxUpdateUI();
  imageSource='camera';cameraActive=true;activeCameraSelection=avApp?.config().cameraDeviceId||'';
  for(const track of acquired.getVideoTracks?.()||[])track.addEventListener?.('ended',()=>{
   if(generation===cameraGeneration&&cameraStream===acquired){usePattern();status('Webcam disconnected. The test pattern is now selected.',true);}
  },{once:true});
  createSource(true);
  if(avApp)await avApp.ui.refreshDevices();
  if(generation!==cameraGeneration)return;
  log('Webcam connected. One capture is taken at the beginning of each progressive frame.');
  status('Webcam active.');
 }catch(e){
  if(generation!==cameraGeneration)return;
  acquired?.getTracks().forEach(t=>t.stop());cameraStream=null;cameraActive=false;imageSource='pattern';
  imgCam.srcObject=null;maxCaptureSettings=null;sourceRGBA=null;createSource(false);maxUpdateUI();
  status('Webcam: '+e.message,true);log('Webcam: '+e.message);
 }finally{if(generation===cameraGeneration)cameraPending=false;}
}
function usePattern(options={}){
 if(!options.preserveEasyChoice)easyVideoSource='pattern';
 cameraGeneration++;cameraPending=false;
 if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());
 cameraStream=null;cameraActive=false;imageSource='pattern';sourceRGBA=null;maxCaptureSettings=null;imgCam.srcObject=null;
 createSource(false);log('Analog test pattern selected.');
}
function getPcm(count){return avApp?.tx?avApp.getPcm(count):maxGetPcm(count);}
// Independent analog H-line timing probe. It only reads the original TX sync
// waveform (H pulse + black + white porch), never examines/checks video pixels.
// Allows 320x240 RX to distinguish 388-sample fast lines from 708-sample
// stable lines without requiring any radio firmware change or framing bytes.
// The shape separator itself supplies H edges. Do NOT run a second old-style
// detector with a fixed <-78 PCM threshold; that was the V7 acquisition bug.
class Auto320LineProbe{
 constructor(onDetected){this.onDetected=onDetected;this.reset();}
 reset(){this.prevH=null;this.kind=null;this.streak=0;this.lastSwitch=-1e12;}
 skip(n){if(n>1400)this.reset();}
 acceptH(start){
  if(this.prevH!==null){
   const distance=start-this.prevH;
   const which=Math.abs(distance-388)<=15?'bw320':Math.abs(distance-708)<=15?'bw320stable':null;
   if(which){this.streak=this.kind===which?this.streak+1:1;this.kind=which;}
   else{this.kind=null;this.streak=0;}
   if(this.streak>=5 && start-this.lastSwitch>RATE*2){
    this.lastSwitch=start;this.onDetected(which);this.streak=0;
   }
  }
  this.prevH=start;
 }
}
function autoDetect320(which){
 if(avApp?.isMixed())return; // CRC-validated A/V metadata owns the video format.
 if(!$('auto320').checked||$('role').value!=='rx'||!session||session.state!=='rx')return;
 if(!['bw320','bw320stable'].includes(modeId)||which===modeId)return;
 modeId=which;$('mode').value=which;selectedMode();
 log('AUTO 320: '+(which==='bw320stable'?'STABLE · 708':'FAST · 388')+' samples/line detected. Waiting for the next V pulse.');
 status('RX: '+(which==='bw320stable'?'320×240 Stable (0.71 FPS)':'320×240 Fast (1.29 FPS)')+' detected from H pulses.');
}
class ByteParser{
 constructor(onFrame,onLine,onReady,controlExpected=()=>false){
  this.rest=new Uint8Array(0);this.onFrame=onFrame;this.onLine=onLine;this.onReady=onReady;
  this.controlExpected=controlExpected;
  this.wireVersion=null;this.expectedIndex=null;this.seeking=false;
  this.stats={packets:0,crcErrors:0,shortPackets:0,badHeaders:0,resyncs:0,discardedBytes:0};
 }
 setWireVersion(version){this.wireVersion=version;this.expectedIndex=null;}
 static crc32(bytes,start,length){
  if(!this.crcTable){this.crcTable=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xEDB88320:0);this.crcTable[i]=c>>>0;}}
  let crc=0xFFFFFFFF;for(let i=start;i<start+length;i++)crc=(crc>>>8)^this.crcTable[(crc^bytes[i])&255];
  return (crc^0xFFFFFFFF)>>>0;
 }
 header(data,at,version=3){
  if(at+10>data.length||data[at]!==77||data[at+1]!==80||data[at+2]!==88||data[at+3]!==48+version)return null;
  const view=new DataView(data.buffer,data.byteOffset+at,10),index=view.getUint32(4,true),strength=view.getUint16(8,true);
  return strength<=30000?{index,strength}:null;
 }
 forward(before,after,minimum=128){const difference=(after-before)>>>0;return difference>=minimum&&difference<RATE*20;}
 plausible(index){if(this.expectedIndex===null)return true;const difference=(index-this.expectedIndex)>>>0;return difference===0||difference<RATE*20;}
 control(data,at){
  if(data[at]===239&&data[at+1]===239&&data[at+2]===239&&data[at+3]===239)return {length:4,ready:true};
  let prefix;if(data[at]===79)prefix=[79,75,32];else if(data[at]===69)prefix=[69,82,82,32];else return null;
  if(at+prefix.length>data.length)return null;
  for(let i=0;i<prefix.length;i++)if(data[at+i]!==prefix[i])return null;
  for(let end=at+prefix.length;end<Math.min(data.length,at+150);end++){
   if(data[end]===10||data[end]===13)return {length:end-at+(data[end]===13&&data[end+1]===10?2:1),line:new TextDecoder().decode(data.subarray(at,end))};
   if(data[end]<32||data[end]>126)return null;
  }
  return null;
 }
 terminalControl(data,at,maximum){
  for(let candidate=at+10;candidate<=Math.min(data.length-4,at+maximum);candidate++){
   const control=this.control(data,candidate);
   if(control&&candidate+control.length===data.length&&this.controlExpected(control.ready?'ready':'line',control.line)){
    // Firmware precedes READY with a complete zero boundary. A run of 0xEF
    // in ordinary PCM cannot be used as an early legacy packet boundary.
    if(control.ready&&(candidate<138||!data.subarray(candidate-138,candidate).every(byte=>byte===0)))continue;
    return candidate;
   }
  }
  return -1;
 }
 emit(data,at,header){
  if(this.seeking){this.stats.resyncs++;this.seeking=false;}
  this.stats.packets++;this.expectedIndex=(header.index+128)>>>0;
  this.onFrame(header.index,header.strength,data.subarray(at+10,at+138));
 }
 discard(count){this.stats.discardedBytes+=count;this.seeking=true;}
 feed(chunk){
  let data;if(this.rest.length){data=new Uint8Array(this.rest.length+chunk.length);data.set(this.rest);data.set(chunk,this.rest.length);}else data=chunk;
  let at=0;
  while(at<data.length){
   const c=data[at];
   if(c===77){
    const available=data.length-at;
    if(available<4&&[77,80,88].slice(0,available).every((b,i)=>data[at+i]===b))break;
    const version=data[at+1]===80&&data[at+2]===88?data[at+3]-48:0;
    if((version===3||version===4)&&(this.wireVersion===null||version===this.wireVersion)){
     if(available<10)break;
     const header=this.header(data,at,version);
     if(version===4){
      if(available<142)break;
      const expected=new DataView(data.buffer,data.byteOffset+at+138,4).getUint32(0,true);
      if(ByteParser.crc32(data,at,138)!==expected){this.stats.crcErrors++;this.discard(1);at++;continue;}
      if(!header){this.stats.badHeaders++;this.discard(142);at+=142;continue;}
      if(this.expectedIndex!==null&&((header.index-this.expectedIndex)>>>0)>=0x80000000){this.stats.badHeaders++;this.discard(142);at+=142;continue;}
      // The CRC covers the index too. No unverified index reaches the raster.
      this.emit(data,at,header);at+=142;continue;
     }
     if(!header||!this.plausible(header.index)){this.stats.badHeaders++;this.discard(1);at++;continue;}
     const next=this.header(data,at+138);
     if(next&&this.forward(header.index,next.index)){
      this.emit(data,at,header);at+=138;continue;
     }
     const boundary=this.control(data,at+138);
     if(boundary){this.emit(data,at,header);at+=138;continue;}
     if(available!==138){
      const terminal=this.terminalControl(data,at,552);
      if(terminal>=0){if(terminal-at<138)this.stats.shortPackets++;else this.stats.badHeaders++;this.discard(terminal-at);at=terminal;continue;}
     }
     if(available<138)break;
     // Confirm a replacement boundary with its following packet. Merely
     // finding "MPX3" inside PCM is not enough to discard a healthy packet.
     let replacement=-1;
     const limit=Math.min(data.length-148,at+552);
     for(let candidate=at+1;candidate<=limit;candidate++){
      const h=this.header(data,candidate),following=this.header(data,candidate+138);
      if(h&&following&&this.plausible(h.index)&&this.forward(h.index,following.index)){replacement=candidate;break;}
     }
     if(replacement>=0){
      const distance=replacement-at;
      // A healthy packet can precede an unreadable header. Preserve it only
      // when there is no earlier confirmed shortened-packet boundary.
      const later=this.header(data,at+276);
      let earlyBoundary=false;
      for(let candidate=at+10;candidate<at+138&&candidate+10<=data.length;candidate++){
       const early=this.header(data,candidate);
       if(early&&this.forward(header.index,early.index)){earlyBoundary=true;break;}
      }
      if(!earlyBoundary&&distance>=276&&later&&this.forward(header.index,later.index,256)){
       this.emit(data,at,header);at+=138;continue;
      }
      if(distance<138)this.stats.shortPackets++;else this.stats.badHeaders++;
      this.discard(distance);at=replacement;continue;
     }
     if(available<562)break;
     this.stats.badHeaders++;this.discard(1);at++;continue;
    }
   }
   // CR and LF may arrive in separate USB chunks. Both are legitimate line
   // delimiters, not evidence of a serial loss or a resynchronization.
   if(c===10||c===13){at++;continue;}
   const control=this.control(data,at);
   if(control){
    if(control.ready)this.onReady();else{if(/^OK RX /.test(control.line))this.expectedIndex=null;this.onLine(control.line);}
    at+=control.length;continue;
   }
   if((c===239&&data.length-at<4)||((c===79||c===69)&&data.length-at<150&&data.subarray(at).every(b=>b>=32&&b<=126)))break;
   this.discard(1);at++;
  }
  this.rest=data.slice(at);
 }
 finish(){
  // Only an exactly aligned complete legacy tail may be committed at EOF.
  // MPX4 packets are already committed immediately after CRC validation.
  if(this.rest.length===138&&(this.wireVersion===null||this.wireVersion===3)){
   const header=this.header(this.rest,0);
   if(header&&this.plausible(header.index))this.emit(this.rest,0,header);
   else this.discard(this.rest.length);
  }else if(this.rest.length)this.discard(this.rest.length);
  this.rest=new Uint8Array(0);
 }
}
function rxFrame(index,_strength,bytes){
 const own=session;
 if(own?.state!=='rx'||own.disconnecting||$('role').value!=='rx')return;
 if(own.acquisition?.probe){
  const attempt=own.acquisition.probe;
  if(attempt.next!==null){
   const gap=(index-attempt.next)>>>0;
   if(gap>0)attempt.decoder.gap(gap);
  }
  attempt.next=(index+bytes.length)>>>0;
  attempt.decoder.feed(bytes);
  lastRxPacketAt=performance.now();rxBytes+=bytes.length;
  return;
 }
 rxCapture.record(index,bytes); // Preserve received PCM before A/V processing.
 lastRxPacketAt=performance.now();rxLossShown=false;rxBytes+=bytes.length;
 if(rxLastIndex!==null){
  const diff=(index-rxLastIndex)>>>0;
  if(diff>0&&diff<RATE*20){
   // Missing MPX3 payload is NEVER recreated as fake RF noise.
   // Keep timeline moving; paint red ONLY where PCM values are unavailable.
   if(avApp?.isMixed())avApp.feedMissing(diff);
   else if(diff<=384)rxDecode.feedMissing(diff);
   else rxDecode.skipMissing(diff);
   if(autoLineProbe)autoLineProbe.skip(diff);
  }else if(diff>=RATE*20){
   /* RX_PROGRESS_DISCONTINUITY */ rxProgress.discontinuity(rxDecode);
   if(avApp?.isMixed())avApp.discontinuity();
   rxDecode.showSignalLoss('Serial index discontinuity');if(autoLineProbe)autoLineProbe.skip(0);
   log('Serial sample-timeline discontinuity: video data unavailable, marked RED.');
  }
 }
 const mixed=avApp?.isMixed();
 const before=mixed?avApp.rx?.counters.validHeaders||0:rxDecode.horizontalSyncs;
 if(mixed)avApp.feedBytes(bytes);else feedObservedVideo(bytes); /* RX_PROGRESS_FEED */
 const synchronized=mixed?avApp.rx?.state==='locked'&&avApp.rx.counters.validHeaders>before
  :rxDecode.hLocked&&rxDecode.horizontalSyncs>before;
 if(synchronized&&own.acquisition)own.acquisition.lastSync=performance.now();
 rxLastIndex=(index+bytes.length)>>>0;
}
const radioRxAck=/^OK RX \d+ 120000 HQ$/;
function response(line){
 log(line);
 const own=session;
 if(own?.state==='tuning'&&own.tuneAck?.(line)&&own.tuneCurrent?.()&&!own.disconnecting){
  // An RX acknowledgement starts a new sample-index epoch. A USB read can
  // contain that acknowledgement and the first MPX packets together.
  own.parser.setWireVersion(own.wireVersion);
  own.state='rx';
 }
 for(const item of [...pending])if(item.test(line)){
  pending=pending.filter(p=>p!==item);clearTimeout(item.timer);item.resolve(line);
 }
 if(/^ERR /.test(line)){
  for(const item of pending){clearTimeout(item.timer);item.reject(new Error(line));}pending=[];
  if(session?.state==='tx'){session.txRunning=false;session.maxTxFault=true;session.state='rx';avApp?.cancelPacing();setButtons();status('Radio fault: '+line,true);}
 }
}
function ready(){if(session?.state==='keying'){session.ready?.();session.ready=null;}}
function waitLine(test,ms=4500){
 let item;const reply=new Promise((resolve,reject)=>{
  item={test,resolve,reject,timer:0};item.timer=setTimeout(()=>{pending=pending.filter(x=>x!==item);reject(Error('Serial response timed out'));},ms);pending.push(item);
 });
 reply.cancel=()=>{clearTimeout(item.timer);pending=pending.filter(x=>x!==item);};return reply;
}
function readFrequency(){
 const hz=Math.round(Number($('frequency').value)*1e6);
 if(!Number.isSafeInteger(hz)||hz<2401000000||hz>2482500000)throw Error('RF frequency must be 2401–2482.5 MHz');
 return hz;
}
function txPowerSettings(port){
 if(!port)return null;
 let settings=txPowerByPort.get(port);
 if(!settings){
  settings={model:null,automatic:null,manual:null};
  txPowerByPort.set(port,settings);
 }
 return settings;
}
function selectedTxPowerSettings(){
 return txPowerSettings(session?.port||easySelectedPort);
}
function updateTxPowerControls(state){
 const power=selectedTxPowerSettings(),field=$('apwr');
 field.value=power?.manual??power?.automatic??'';
 field.dataset.mode=power?.manual!=null?'manual':'auto';
 field.disabled=!power||$('role').value!=='tx'||easyAction.busy||!['off','rx'].includes(state);
 $('txPowerAuto').disabled=field.disabled||power?.manual==null;
 $('radioModel').textContent=power?.model||'—';
}
$('apwr').addEventListener('input',()=>{
 const field=$('apwr'),power=selectedTxPowerSettings(),value=Number(field.value);
 if(!field.disabled&&power&&field.value!==''&&Number.isInteger(value)&&value>=0&&value<=191){
  power.manual=value;
 }
 setButtons();
});
$('txPowerAuto').addEventListener('click',()=>{
 if($('txPowerAuto').disabled)return;
 selectedTxPowerSettings().manual=null;
 setButtons();
});
async function identifyRadio(own){
 own.model=await detectRadioModel((command,match,timeout)=>commandAwait(command,match,timeout,own));
 own.txPower=defaultTxPowerForModel(own.model);
 const power=txPowerSettings(own.port);
 power.model=own.model;power.automatic=own.txPower;
 if(own.txPower!==null)log('Automatic TX power for '+own.model+': APWR '+own.txPower);
}
async function write(bytes,own=session){
 if(!own||own.closing)throw Error('Serial port unavailable');
 try{await own.writer.write(typeof bytes==='string'?ascii.encode(bytes):bytes);}
 catch(error){serialFault(own,error);throw error;}
}
async function commandAwait(command,test,ms=4500,own=session){
 const reply=waitLine(test,ms);
 try{const [,line]=await Promise.all([write(command,own),reply]);return line;}
 finally{reply.cancel();}
}
async function readSerial(own){
 const parser=new ByteParser(rxFrame,response,ready,(kind,line)=>kind==='ready'?own.state==='keying':pending.some(item=>item.test(line)||/^ERR /.test(line)));
 own.parser=parser;
 try{
  while(session===own&&!own.closing){
   const reader=own.port.readable.getReader();own.reader=reader;
   try{while(session===own&&!own.closing){const {value,done}=await reader.read();if(done){own.readEnded=true;if(!own.closing)serialFault(own,Error('USB serial stream ended. Disconnect and reconnect.'));return;}if(value?.length)parser.feed(value);}}
   finally{reader.releaseLock();own.reader=null;}
  }
 }catch(e){if(!own.closing)serialFault(own,e);}
 finally{parser.finish();}
}
function serialFault(own,error){
 if(own!==session||own.closing)return;
 own.acquisition=null;
 own.readError=error;own.txRunning=false;own.state='fault';own.cancelReady?.();own.cancelReady=null;own.ready=null;
 for(const item of pending){clearTimeout(item.timer);item.reject(error);}pending=[];
 avApp?.cancelPacing(error);avApp?.resetReceive();
 if(easyAction.resources&&!easyAction.busy)void easyReleaseMedia(easyAction.resources).catch(failure=>log('Source cleanup: '+failure.message));
 log('Serial RX: '+error.message);status('USB reading interrupted: '+error.message,true);
 rxDecode?.showSignalLoss('USB serial stream unavailable');setButtons();
}
// BEGIN SERIAL CONNECTION
async function openSerialSession(port,isCurrent=()=>true){
 await port.open({baudRate:SERIAL_BAUD,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:65536});
 if(!isCurrent()){await port.close();throw Error('Serial connection cancelled');}
 let writer;
 try{writer=port.writable.getWriter();}catch(e){await port.close();throw e;}
 const own={port,baudRate:SERIAL_BAUD,writer,reader:null,state:'connecting',closing:false,txRunning:false,txTask:null,readTask:null,ready:null,readError:null,readEnded:false};
 session=own;own.readTask=readSerial(own);setButtons();return own;
}
async function closeSerialSession(own){
 if(!own)return;own.closing=true;own.txRunning=false;
 for(const p of pending){clearTimeout(p.timer);p.reject(Error('Serial session ended'));}pending=[];
 if(session===own)session=null;
 let failure=null;
 try{await own.reader?.cancel();}catch(e){failure=e;}
 try{await own.readTask;}catch(e){failure=failure||e;}
 try{own.writer.releaseLock();}catch(e){failure=failure||e;}
 try{await own.port.close();}catch(e){failure=failure||e;}
 if(failure)throw failure;
}
async function identifySerialSession(own){
 await sleep(280); // Also allows a previous abandoned TX stream to time out.
 for(let attempt=0;attempt<3;attempt++){
  if(own.closing||session!==own)throw Error('Serial connection cancelled');
  if(own.readError)throw own.readError;
  if(own.readEnded)throw Error('USB serial stream ended during identification');
  try{
   await commandAwait('STATUS\n',line=>/^OK STATUS CB_FM_STEREO 4$/.test(line),2200,own);
   return;
  }catch(e){
   if(own.readError)throw own.readError;
   if(own.readEnded)throw Error('USB serial stream ended during identification');
   if(e.message!=='Serial response timed out')throw e;
   if(attempt===2)throw Error('No compatible firmware response at '+SERIAL_BAUD+' baud');
   await sleep(430);
  }
 }
}
async function establishSerialPort(port,isCurrent=()=>true){
 let own=null;
 try{
  own=await openSerialSession(port,isCurrent);await identifySerialSession(own);
  if(!isCurrent())throw Error('Serial connection cancelled');
  log('Serial rate confirmed by firmware response: '+SERIAL_BAUD.toLocaleString('en-US')+' baud.');return own;
 }catch(e){if(own)await closeSerialSession(own);throw e;}
}
async function configureSerialTransport(own){
 await commandAwait('STOP\n',line=>line==='OK STOP',3500,own);
 const unsupported='Video firmware required. Flash the ESP_VIDEO_V4 firmware for this board and reconnect.';
 let info;
 try{
  info=await commandAwait('INFO\n',line=>/^OK INFO\b/.test(line),2200,own);
 }catch(error){
  if(error.message==='ERR COMMAND')throw Error(unsupported);
  throw error;
 }
 const link=/^OK INFO LINK 1 BAUD (\d+) WIRE [34] PACE \d+ CRC32 IEEE TX7 1$/.exec(info);
 if(!link)throw Error(unsupported);
 if(Number(link[1])!==own.baudRate)throw Error('Firmware serial rate does not match the opened port');
 log('Firmware link capabilities: '+info);
 try{
  await commandAwait('WIRE 4\n',line=>line==='OK WIRE 4',2200,own);
  own.parser.setWireVersion(4);own.wireVersion=4;
  try{
   await commandAwait('PACE '+SERIAL_PACE+'\n',line=>line==='OK PACE '+SERIAL_PACE,2200,own);
   own.pace=SERIAL_PACE;
  }catch(e){if(e.message!=='ERR COMMAND')throw e;own.pace=0;}
  log('Serial transport confirmed: MPX4 CRC32; pacing '+own.pace.toLocaleString('en-US')+' bytes/s.');
 }catch(e){
  if(e.message!=='ERR COMMAND')throw e;
  own.parser.setWireVersion(3);own.wireVersion=3;own.pace=0;
  log('Serial transport confirmed: legacy MPX3 with validated boundaries.');
 }
}
// END SERIAL CONNECTION
function setButtons(){
 const state=session?.state||(connecting?'connecting':'off'),on=state!=='off'&&state!=='connecting';
 updateTxPowerControls(state);
 $('connect').disabled=state!=='off';$('disconnect').disabled=!on||state==='disconnecting';
 $('startTx').disabled=state!=='rx'||$('role').value!=='tx'||session?.txPower===null||!!(avApp&&!avApp.ready());
 $('stopTx').disabled=!['tx','keying','stopping'].includes(state);
 $('role').disabled=state!=='off';$('frequency').disabled=state!=='off';
 $('mode').disabled=['tx','keying','stopping'].includes(state);maxUpdateUI();
 if(avApp){
  const audioOnly=avApp.config().usage==='audio';
  $('mode').disabled=$('mode').disabled||audioOnly;
  $('camera').disabled=audioOnly;$('pattern').disabled=audioOnly;
  $('videoGrid').classList.toggle('hidden',audioOnly);$('maxPanel').classList.toggle('hidden',audioOnly);
 }
 easyApp?.refresh();
}
function resetReceiverEpoch(clearPicture){
 rxLastIndex=null;lastRxPacketAt=performance.now();rxLossShown=false;rxFramesWindow=[];
 rxDecode.reset(true);rxDecode.packedClock?.reset();updateRxControls();rxProgress.reset(modeId);
 autoLineProbe=new Auto320LineProbe(autoDetect320);
 rxCapture.clear();$('saveRxCapture').disabled=true;
 if(clearPicture)receivedCtx.clearRect(0,0,$('received').width,$('received').height);
 $('lockStatus').textContent='Searching for H / V';
}
async function tuneRadio(own,cfg,current,{initial=true}={}){
 if(initial&&$('role').value==='rx')resetReceiverEpoch(true);
 const expected=cfg.hz+cfg.fine;
 const matches=line=>radioRxAck.test(line)&&Math.abs(Number(line.split(' ')[2])-expected)<2000;
 own.state='tuning';own.tuneCurrent=current;own.tuneAck=matches;
 try{
  const reply=await commandAwait('RX '+cfg.hz+' HQ '+cfg.fine+'\n',matches,5500,own);
  if(!current()||session!==own||own.disconnecting||own.state!=='rx')throw Error('Radio start cancelled');
  if(initial){
   log('Radio RX 120000 HQ: '+reply);
   status($('role').value==='rx'?'RX active · finding the best tuning':'Radio ready · enable webcam or test pattern, then select Start TX');
  }
 }finally{own.tuneCurrent=null;own.tuneAck=null;}
 if(initial)setButtons();
}
function makeTuningProbe(){
 return {decoder:createProbe({C,AV:globalThis.CBAnalogAV,mode:modeId,mixed:avApp.isMixed(),
  auto320:$('auto320').checked}),next:null};
}
function validFine(hz,fine){
 return hz+fine>=2401000000&&hz+fine<=2482500000;
}
async function acquireRadio(own,track,initial){
 const current=()=>session===own&&own.acquisition===track&&!own.disconnecting&&!own.closing;
 const startingFine=track.fine;
 track.searching=true;track.probe=initial?track.probe:makeTuningProbe();
 $('lockStatus').textContent='Automatic tuning…';
 status('RX active · finding the best tuning');
 if(!initial)avApp.resetReceive({preserveListening:true});
 setButtons();
 const candidates=[...new Set([startingFine,...FINE_STEPS])].filter(fine=>validFine(track.hz,fine));
 let best=null;
 try{
  for(const fine of candidates){
   if(!current())return;
   if(fine!==track.fine){
    track.probe=makeTuningProbe();
    await tuneRadio(own,{hz:track.hz,fine},current,{initial:false});
    track.fine=fine;
   }
   const probe=track.probe.decoder;
   const enoughSamples=RATE*((initial&&fine===startingFine) ? 0.55 : 0.43);
   const end=performance.now()+950;
   let evidence=probe.snapshot();
   while(current()&&evidence.samples<enoughSamples&&performance.now()<end){
    await sleep(45);
    evidence=probe.snapshot();
   }
   if(!current())return;
   log('RX fine '+fine+' Hz · sync '+Math.round(evidence.score*100)+'%'+
    (evidence.headers===undefined?'':' · '+evidence.headers+' verified headers'));
   const result={fine,evidence};
   if(evidence.qualified&&(!best||compare(evidence,best.evidence)<0))best=result;
   // The ESP8266 needs a comparison with both nearby positive offsets on
   // first acquisition. A previously verified offset can lock immediately.
   const checkNearby=own.model==='ESP8266'&&startingFine===0&&[0,35000].includes(fine);
   if(evidence.strong&&evidence.score>=.90&&!checkNearby)break;
  }
  const fine=best?.fine??startingFine;
  resetReceiverEpoch(false);
  if(fine!==track.fine)await tuneRadio(own,{hz:track.hz,fine},current,{initial:false});
  if(!current())return;
  track.fine=fine;track.probe=null;track.searching=false;track.verified=!!best;
  track.lastSync=performance.now();track.retryAt=track.lastSync+(best?2500:5000);
  $('fine').value=fine;
  if(best)lastFineByPort.set(own.port,{hz:track.hz,fine});
  log(best?'Automatic RX fine selected: '+fine+' Hz':'Automatic RX fine: waiting for valid sync');
  status(best?'RX active · tuned automatically':'RX active · waiting for signal');
  setButtons();
 }catch(error){
  if(!current())return;
  log('Automatic RX tuning: '+error.message);
  await disconnect();
  status('Automatic RX tuning failed: '+error.message,true);setButtons();
 }
}
async function connect(options={}){
 if(session||connecting)return session;let own=null;const request=++connectGeneration;activeConnectGeneration=request;
 const current=()=>request===connectGeneration&&(!options.isCurrent||options.isCurrent());
 connecting=true;setButtons();
 try{
  const hz=readFrequency();
  if(!navigator.serial)throw Error('Web Serial is unavailable. Use desktop Chrome/Edge, preferably via localhost.');
  const port=options.port||await navigator.serial.requestPort();
  if(!current())throw Error('Serial connection cancelled');
  status('Checking radio serial link...');own=await establishSerialPort(port,current);
  await configureSerialTransport(own);await maxConfigureTX7(own);
  await identifyRadio(own);
  if(!current())throw Error('Serial connection cancelled');
  // TX firmware uses RX to select its channel before accepting TX7.
  if($('role').value==='tx'){
   if(own.txPower===null)throw Error('TX power unavailable for this radio model.');
   await tuneRadio(own,{hz,fine:0},current);
  }
  else{own.state='idle';status('USB connected · press Start RX to receive.');}
  easySelectedPort=port;
  return own;
 }catch(e){const cancelled=!current(),message=cancelled?'USB serial connection cancelled.':'Connection: '+e.message;log(message);if(own&&session===own)await disconnect();status(message,!cancelled);}
 finally{connecting=false;setButtons();}
}
async function disconnect(){
 const own=session;if(!own||own.closing||own.disconnecting)return;
 own.disconnecting=true;
 own.acquisition=null;
 /* RX_PROGRESS_RESET */ rxProgress.reset(modeId);
 ++connectGeneration;
 maxResetFrames();
 if(avApp){avApp.endTransmit();avApp.resetReceive();}
 if(['rx','tuning'].includes(own.state)){
  own.state='disconnecting';setButtons();
  try{await commandAwait('STOP\n',line=>line==='OK STOP',1500,own);}catch(error){log('Radio stop: '+error.message);}
 }
 own.closing=true;own.txRunning=false;
 own.txAttempt=(own.txAttempt||0)+1;own.cancelReady?.();own.cancelReady=null;own.ready=null;
 for(const p of pending){clearTimeout(p.timer);p.reject(Error('Disconnected'));}pending=[];
 if(['tx','keying'].includes(own.state))await sleep(200);
 session=null;autoLineProbe=null;
 if($('role').value==='rx'){
  receivedCtx.clearRect(0,0,$('received').width,$('received').height);
 }
 try{await own.reader?.cancel();}catch(_){}
 try{await own.readTask;}catch(_){}
 try{own.writer.releaseLock();}catch(_){}
 try{await own.port.close();}catch(_){}
 setButtons();status('USB serial disconnected.');log('USB serial disconnected.');
}
async function txLoop(own,attempt=own.txAttempt){
 try{
  txBytes=0;txBytesAtLast=0;txRateAtLast=performance.now();txMaxLate=0;
  const prefill=own.maxPrefill;own.maxPrefill=null;
  const prefillWrite=await maxWritePCM(prefill,own);txBytes+=prefill.length;
  // A resolved Web Serial write can mean queued in the OS, not drained over
  // UART. Keep the complete prefill, then wait its minimum physical wire time.
  const prefillFloor=prefillWrite.writeStartedAt+prefillWrite.wireBytes*1000/SERIAL_PACE;
  while(session===own&&own.txRunning&&!own.closing&&own.txAttempt===attempt&&performance.now()<prefillFloor){
   if(avApp?.tx)await avApp.paceUntil(prefillFloor);
   else await sleep(Math.min(20,prefillFloor-performance.now()));
  }
  if(session!==own||!own.txRunning||own.closing||own.txAttempt!==attempt)return;
  let clock=performance.now(),sent=0;
  while(session===own&&own.txRunning&&!own.closing&&own.txAttempt===attempt){
   const goal=clock+sent*1000/RATE,wait=goal-performance.now();
   if(wait>1){if(avApp?.tx)await avApp.paceUntil(goal);else await sleep(Math.min(wait,50));}
   if(session!==own||!own.txRunning||own.txAttempt!==attempt)break;
   const late=performance.now()-goal;if(late>txMaxLate)txMaxLate=Math.ceil(late);
   if(late>120){clock=performance.now()-sent*1000/RATE;log('Browser scheduling delayed: resumed stream without a catch-up USB burst.');}
   await maxWritePCM(getPcm(WRITE_BLOCK),own);sent+=WRITE_BLOCK;txBytes+=WRITE_BLOCK;
  }
 }catch(e){if(own.txAttempt===attempt)own.maxTxFault=true;if(session===own&&!own.closing&&own.txAttempt===attempt){status('TX error: '+e.message,true);log('TX error: '+e.message);}}
 finally{
  if(session===own&&own.txAttempt===attempt){own.txRunning=false;
   if(own.state==='tx'&&own.tx7Encoder&&!own.maxTxFault){try{await write(own.tx7Encoder.finish(),own);}catch(error){log('TX7 finish: '+error.message);}}
   maxResetFrames();
   avApp?.endTransmit();
   if(own.state==='tx'){own.state='stopping';setButtons();await sleep(310);if(session===own&&own.state==='stopping'){own.state='rx';status('TX stopped; returning to HQ reception.');setButtons();}}
  }
 }
}
async function startTx(){
 const own=session;if(!own||own.state!=='rx'||$('role').value!=='tx')return;
 const attempt=own.txAttempt=(own.txAttempt||0)+1;
 const current=()=>session===own&&!own.closing&&own.txAttempt===attempt;
 try{
  if(own.txPower===null)throw Error('TX power unavailable for this radio model.');
  const apwr=txPowerSettings(own.port).manual??own.txPower;
  if(avApp&&!avApp.getPlan().admitted)throw Error(avApp.getPlan().reason);
  maxResetFrames();txFieldCount=0;maxAcquisitionSequence=0;
  own.state='keying';setButtons();
  if(avApp)await avApp.beginTransmit({isCurrent:current});
  if(!current()||own.state!=='keying')return;
  own.maxTxFault=false;own.maxUsbBytes=0;own.tx7Encoder=own.tx7Capability?new globalThis.ESPVideoTX7.Encoder():null;
  own.maxPrefill=getPcm(PREBUFFER);
  own.state='keying';setButtons();status('Issuing RF TX command, waiting for READY...');
  const readyP=new Promise((resolve,reject)=>{
   const t=setTimeout(()=>{if(own.txAttempt===attempt){own.ready=null;own.cancelReady=null;}reject(Error('RF READY signal not received'));},3500);
   own.cancelReady=()=>{clearTimeout(t);reject(Error('TX canceled.'));};
   own.ready=()=>{clearTimeout(t);own.cancelReady=null;resolve();};
  });
  await Promise.all([write(`${own.tx7Encoder?'TX7':'TX'} ${apwr}\n`,own),readyP]);
  if(!current()||own.state!=='keying')return;
  own.state='tx';own.txRunning=true;setButtons();
  const media=avApp?.getPlan();
  log(`TX PCM8 120 kHz - ${media?.audioOnly?'audio seul':modeId} - ${formatNumber(media?.videoFps??plan().frameFps,3)} FPS - APWR ${apwr}`);
  status(avApp?.isMixed()?'Continuous analog audio active · video synchronized with audio playback.':'Continuous video transmission active — keep this tab in the foreground.');own.txTask=txLoop(own,attempt);
 }catch(e){if(!current())return;own.cancelReady?.();own.cancelReady=null;avApp?.endTransmit();maxResetFrames();if(session===own){own.ready=null;own.txRunning=false;own.state=own.readError?'fault':'rx';setButtons();status('Unable to start TX: '+e.message,true);log('TX error: '+e.message);}}
}
async function stopTx(){
 const own=session;if(!own||!['tx','keying','stopping'].includes(own.state))return;
 own.txRunning=false;avApp?.cancelPacing();
 if(own.state==='keying'){
  own.txAttempt=(own.txAttempt||0)+1;own.cancelReady?.();own.cancelReady=null;own.ready=null;
  avApp?.endTransmit();own.state='stopping';setButtons();await sleep(330);
  if(session===own&&own.state==='stopping'){own.state='rx';setButtons();}return;
 }
 if(own.txTask)await own.txTask;
}
function updateRxControls(){
 if(!rxDecode)return;
 rxDecode.setLevels({brightness:Number($('rxBrightness').value),contrast:Number($('rxContrast').value),saturation:Number($('saturation').value),
  autoLevel:$('autoLevel').checked,hPosition:Number($('hPosition').value),hHold:Number($('hHold').value),vHold:Number($('vHold').value),hLock:Number($('hLock').value)/100});
 for(const [id,out,suffix] of [['hPosition','hPositionOut',' px'],['vHold','vHoldOut',' samples/frame'],['hLock','hLockOut','%'],['rxBrightness','rxBrightnessOut','']])$(out).textContent=$ (id).value+suffix;
 for(const [id,out,suffix] of [['hHold','hHoldOut',' samples/line'],['rxContrast','rxContrastOut','×'],['saturation','saturationOut','×']])$(out).textContent=formatNumber(Number($(id).value))+suffix;
}
function selfTest(){
 const m=fmt(),p=plan(),rgba=C.patternRGBA(modeId),source=C.sourceFromRGBA(modeId,rgba);
 let last=null,meta=null;const test=new C.Decoder({mode:modeId,onFrame:(pic,s)=>{last=pic;meta=s;}});
 // Explicit LOCAL TEST (not live radio): inject a 42-sample unavailable PCM span.
 for(let field=0;field<p.fieldsPerFrame;field++){
  const wave=C.makeWave(source,modeId,field);
  const testWave=wave.slice();
  testWave.fill(128,Math.round(wave.length*.55),Math.round(wave.length*.55)+42);
  for(let i=0;i<testWave.length;i+=128)test.feedBytes(testWave.subarray(i,i+128));
 }
 if(last){receivedCtx.putImageData(new ImageData(last,m.w,m.h),0,0);$('redPixels').textContent=meta.redPixels.toLocaleString('en-US')+' / '+meta.totalPixels.toLocaleString('en-US');$('rxLossStatus').textContent='LOCAL TEST: injected 0x80 missing values shown red. NOT live radio.';$('selfTestResult').textContent=`Local test OK: ${meta.frames} frame(s), ${meta.verticalSyncs} V pulses, ${meta.horizontalSyncs} H pulses, ${meta.redPixels} red pixels. No artificial radio noise.`;}
 else $('selfTestResult').textContent='Local test incomplete: no frame displayed.';
 log($('selfTestResult').textContent);
}
function updateStats(){
 const now=performance.now(),elapsed=Math.max(.001,(now-txRateAtLast)/1000);
 $('txRate').textContent=((txBytes-txBytesAtLast)/elapsed/1000).toFixed(1);txBytesAtLast=txBytes;txRateAtLast=now;
 const elapsedRx=Math.max(.001,(now-rxRateAtLast)/1000);
 $('rxRate').textContent=((rxBytes-rxBytesAtLast)/elapsedRx/1000).toFixed(1);
 rxBytesAtLast=rxBytes;rxRateAtLast=now;
 rxFramesWindow=rxFramesWindow.filter(t=>now-t<5000);
 $('rxFps').textContent=formatNumber(rxFramesWindow.length/5);
 $('missed').textContent=rxDecode.totalMissing.toLocaleString('en-US');
 $('invalidSamples').textContent=rxDecode.invalidSamples.toLocaleString('en-US');
 $('gapSamples').textContent=rxDecode.gapSamples.toLocaleString('en-US');
 const wire=session?.parser?.stats;
 for(const [id,key] of [['wirePackets','packets'],['wireCrcErrors','crcErrors'],['wireShortPackets','shortPackets'],['wireBadHeaders','badHeaders'],['wireResyncs','resyncs'],['wireDiscardedBytes','discardedBytes']])$(id).textContent=(wire?.[key]||0).toLocaleString('en-US');
 $('rxSync').textContent=rxDecode.verticalSyncs.toLocaleString('en-US');
 $('rxHSync').textContent=rxDecode.horizontalSyncs.toLocaleString('en-US');
 const vRecent=rxDecode.verticalSyncs>0 && rxDecode.totalSamples-rxDecode.lastVAt<rxDecode.p.fieldSamples*1.6;
 const own=session,acquisition=own?.acquisition;
 $('lockStatus').textContent=acquisition?.searching?'Automatic tuning…':
  rxDecode.hLocked?(vRecent?'H + V locked':'H locked · searching for V'):(vRecent?'Acquiring H · V detected':'Searching for H / V');
 $('syncDetails').textContent=`H: ${rxDecode.horizontalSyncs} · V: ${rxDecode.verticalSyncs} · candidates: ${rxDecode.hCandidates} · false H: ${rxDecode.falseH} · missing H: ${rxDecode.hLost} · sync margin: ${rxDecode.markerContrast.toFixed(0)} PCM`;
 $('lockStatus').style.color=rxDecode.hLocked?'#7de2ae':'#f4c17a';
 $('txJitter').textContent=String(txMaxLate);
 $('markerLevels').textContent=rxDecode.rxSyncMean===null?'Received reference levels: searching for H/V…':`SYNC ${rxDecode.rxSyncMean.toFixed(0)} · Black ${rxDecode.rxBlackMean.toFixed(0)} · White ${rxDecode.rxWhiteMean.toFixed(0)} PCM`;
 $('saveRxCapture').disabled=rxCapture.stats().retainedSamples===0;
 if(own?.state==='rx'&&$('role').value==='rx'&&acquisition&&!acquisition.searching
    &&now>=acquisition.retryAt&&(!acquisition.verified||now-acquisition.lastSync>1800)){
  void acquireRadio(own,acquisition,false);
 }
 if(own?.state==='rx'&&$('role').value==='rx'&&!acquisition?.searching&&lastRxPacketAt&&now-lastRxPacketAt>1600&&!rxLossShown){
  rxLossShown=true;
  rxDecode.showSignalLoss('no serial packets for more than 1.6 seconds');
  log('RX: serial packets stopped. Marked missing image RED; no RF noise invented.');
 }
}
function rxDiagnosticSnapshot(){
 const config=avApp?.config()||{},number=id=>String($(id).value).trim()?Number($(id).value):NaN;
 return rxCapture.snapshot({version:'ESP_VIDEO_V4',transportVersion:avApp?.rx?.plan?.wireVersion,
  settings:{usage:config.usage,videoMode:config.usage==='audio'?null:modeId,audioRate:Number(config.audioRate),audioChannels:Number(config.audioChannels),
   rfHz:number('frequency')*1e6,fineHz:number('fine'),apwr:number('apwr'),serialBaud:SERIAL_BAUD,wireVersion:session?.wireVersion,
   grayLevels:number('grayLevels'),sourceContrast:number('contrast'),brightness:number('rxBrightness'),contrast:number('rxContrast'),
   saturation:number('saturation'),hPosition:number('hPosition'),hHold:number('hHold'),vHold:number('vHold'),hLock:number('hLock'),
   autoLevel:$('autoLevel').checked,auto320:$('auto320').checked},
  counters:{serial:session?.parser?.stats||{},av:avApp?.rx?.counters||{},audio:avApp?.playback?.stats?.()||{},dc:avApp?.rx?.dcRestoration?.counters||{}}});
}
function saveRxDiagnosticCapture(){
 try{
  if(!rxCapture.stats().retainedSamples)throw Error('No received PCM samples are available to save.');
  const capture=rxDiagnosticSnapshot(),blob=new Blob([JSON.stringify(capture)],{type:'application/json'}),url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download='ESP_VIDEO_V4-RX-diagnostic.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  log('Local RX diagnostic download requested: '+capture.durationSeconds.toFixed(2)+' s of received audio/video samples.');
 }catch(error){status('RX diagnostic: '+error.message,true);log('RX diagnostic: '+error.message);}
}
function easyFailure(error){easyAction.message=error?.message||String(error);easyAction.error=true;status(easyAction.message,true);easyApp?.refresh();}
async function easyReleaseMedia(resources){
 if(!resources)return;
 if((resources.camera&&cameraStream===resources.camera)||(resources.pendingCamera&&cameraGeneration===resources.cameraRequest))usePattern({preserveEasyChoice:true});
 if((resources.mic&&avApp?.capture===resources.mic)||(resources.pendingMic&&avApp?.micRequest===resources.micRequest))await avApp.stopMicrophone();
 resources.camera=resources.mic=null;resources.pendingMic=resources.pendingCamera=false;
}
const easyBridge={
 getState(){
  const state=session?.state||(connecting?'connecting':'off'),role=$('role').value;
  const config={usage:$('avUsage').value,audioRate:Number($('avRate').value),audioChannels:Number($('avChannels').value),cameraDeviceId:$('avCameraDevice').value,micDeviceId:$('avMicDevice').value,volume:Number($('avVolume').value)};
  const connected=['idle','tuning','rx','tx','keying','stopping','disconnecting'].includes(state),transmitting=['tx','keying','stopping'].includes(state);
  const acquisition=session?.acquisition;
  const receiving=role==='rx'&&(state==='rx'||state==='tuning'&&!!acquisition);
  const cleanupPending=connecting&&activeConnectGeneration!==connectGeneration;
  const busy=easyAction.busy||(connecting&&!cleanupPending)||['keying','stopping','tuning','disconnecting'].includes(state);
  const running=(state==='tx'&&!!session?.txRunning)||receiving;
  const p=avApp?.rxPlan,rxPlan=p?{...p,syncDelayMs:Math.round(((p.videoFrameSeconds||0)+.24)*1000)}:null;
  let rfStatus={state:'searching',label:'Waiting for signal'};
  if(transmitting)rfStatus={state:'tx',label:state==='keying'?'Starting transmission…':state==='stopping'?'Stopping transmission…':'Transmitting'};
  else if(receiving){
   if(acquisition?.searching)rfStatus={state:'searching',label:'Automatic tuning…'};
   else if(config.usage==='video')rfStatus={state:'analog',label:$('lockStatus').textContent||'Searching for H/V'};
   else if(avApp?.lastAudioAt&&performance.now()-avApp.lastAudioAt<300){
    if(avApp.rx?.state==='locked')rfStatus={state:'locked',label:'Receiving · metadata verified'};
    else if(avApp.rx?.state==='holdover')rfStatus={state:'holdover',label:'Synchronization degraded · held clock'};
   }
  }
  const options=id=>Array.from($(id).options||[],option=>({id:option.value,label:option.textContent}));
  const coreError=$('status').classList.contains('error'),error=easyAction.error||coreError;
  let message=easyAction.message;
  if(cleanupPending)message='Cancelled · waiting for the serial port to finish closing.';
  else if(coreError)message=$('status').textContent;
  else if(!busy&&!error)message=transmitting?'Broadcasting':running?'Receiving':connected?'USB ready':(easySelectedPort?'ESP selected · ready to start':'Choose your ESP to get started');
  return {role,usage:config.usage||'video',videoMode:modeId,audioRate:Number(config.audioRate||16000),audioChannels:Number(config.audioChannels||1),
   cameraDeviceId:config.cameraDeviceId||'',micDeviceId:config.micDeviceId||'',videoSource:easyVideoSource,
   devices:{cameras:options('avCameraDevice'),microphones:options('avMicDevice')},
   portLabel:connected?(session?.model||'ESP')+' · USB Serial':easySelectedPort?'ESP · selected':'No ESP selected',portSelected:!!(easySelectedPort||session?.port),
   connected,receiving,connecting:connecting&&!cleanupPending,cleanupPending,busy,running,roleLocked:connected||busy||cleanupPending,settingsLocked:running||busy||cleanupPending,
   canStart:!!(easySelectedPort||session?.port)&&!connecting&&!busy&&!running,canChooseESP:!connecting&&!busy&&!running,
   plan:avApp?.getPlan(),rxPlan,rfStatus,listening:!!avApp?.playback,volume:Number(config.volume??.7),micLevel:avApp?.capture?.stats?.().level||0,
   cameraActive,micActive:!!avApp?.capture,frequencyMHz:Number($('frequency').value),message,error,state};
 },
 setConfig(patch={}){
  const s=this.getState(),keys=Object.keys(patch),volumeOnly=keys.every(key=>key==='volume');
  if(!volumeOnly&&(s.busy||s.running))throw Error('Stop before changing the stream settings.');
  if(patch.role!==undefined&&patch.role!==s.role&&s.connected)throw Error('Disconnect before changing the radio role.');
  if(patch.role!==undefined&&!['tx','rx'].includes(patch.role))throw RangeError('Unknown radio role.');
  if(patch.usage!==undefined&&!['video','av','audio'].includes(patch.usage))throw RangeError('Unknown stream type.');
  if(patch.videoMode!==undefined)C.getFormat(patch.videoMode);
  if(patch.audioRate!==undefined&&!globalThis.CBAnalogAV.AUDIO_RATES.includes(Number(patch.audioRate)))throw RangeError('Unknown audio rate.');
  if(patch.audioChannels!==undefined&&![1,2].includes(Number(patch.audioChannels)))throw RangeError('Unknown channel count.');
  if(patch.volume!==undefined&&(!Number.isFinite(Number(patch.volume))||Number(patch.volume)<0||Number(patch.volume)>1))throw RangeError('Invalid playback volume.');
  if(patch.videoSource!==undefined&&!['camera','pattern'].includes(patch.videoSource))throw RangeError('Unknown video source.');
  if(patch.role!==undefined)$('role').value=patch.role;
  if(patch.usage!==undefined)$('avUsage').value=patch.usage;
  if(patch.audioRate!==undefined)$('avRate').value=String(patch.audioRate);
  if(patch.audioChannels!==undefined)$('avChannels').value=String(patch.audioChannels);
  if(patch.cameraDeviceId!==undefined){$('avCameraDevice').value=String(patch.cameraDeviceId);if(cameraActive||cameraPending)usePattern({preserveEasyChoice:true});}
  if(patch.micDeviceId!==undefined)$('avMicDevice').value=String(patch.micDeviceId);
  if(patch.videoSource!==undefined){easyVideoSource=patch.videoSource;if(patch.videoSource==='pattern')usePattern();}
  if(patch.videoMode!==undefined){modeId=patch.videoMode;$('mode').value=modeId;selectedMode();autoLineProbe?.reset();}
  if(patch.volume!==undefined){$('avVolume').value=String(patch.volume);avApp?.playback?.setVolume?.(Number(patch.volume));}
  if(patch.role==='rx'){if(cameraActive||cameraPending)usePattern({preserveEasyChoice:true});if(avApp?.capture||avApp?.pendingCapture)void avApp.stopMicrophone().catch(easyFailure);}
  easyAction.error=false;easyAction.message='';
  if(!volumeOnly)avApp?.changed();else avApp?.update();
  $('sourceLabel').textContent=$('role').value==='rx'?'LOCAL PREVIEW (NOT RECEIVED)':'TX SOURCE';setButtons();
 },
 async chooseESP(){
  if(this.getState().running||easyAction.busy||connecting)throw Error('Stop before choosing another ESP.');
  if(!navigator.serial?.requestPort)throw Error('Web Serial is unavailable. Use desktop Chrome/Edge via localhost.');
  const token=++easyAction.generation;easyAction.busy=true;easyAction.error=false;easyAction.message='Choose an ESP in the browser serial picker.';easyApp?.refresh();
  try{const port=await navigator.serial.requestPort();if(token!==easyAction.generation)return;
   if(session)await disconnect();if(token!==easyAction.generation)return;
   easySelectedPort=port;easyAction.message='ESP selected · press Start when ready';status(easyAction.message);return port;
  }catch(error){if(token===easyAction.generation){easyFailure(error);throw error;}}
  finally{if(token===easyAction.generation){easyAction.busy=false;setButtons();}}
 },
 async start(){
  if(easyAction.busy||connecting)throw Error('A device operation is still in progress.');
  const initial=this.getState();if(initial.running)return;
  const plan=avApp?.getPlan();if(initial.role==='tx'&&!plan?.admitted)throw Error(plan?.reason||'Choose a valid stream quality.');
  const receiverPlan=initial.role==='rx'&&initial.usage!=='video'?globalThis.CBAnalogAV.plan(C,{videoMode:initial.usage==='audio'?null:modeId,audioRate:initial.audioRate,audioChannels:initial.audioChannels}):null;
  const port=easySelectedPort||session?.port;if(!port)throw Error('Choose your ESP first.');
  const token=++easyAction.generation,current=()=>token===easyAction.generation;
  const resources={mic:null,camera:null,pendingMic:false,pendingCamera:false};easyAction.resources=resources;
  let opened=null,listenTask=null,receiver=null;
  easyAction.busy=true;easyAction.error=false;easyAction.message='Starting…';setButtons();
  try{
   // Start Web Audio during the click, before awaiting serial configuration.
   if(receiverPlan){listenTask=avApp.listen({plan:receiverPlan});listenTask.catch(()=>{});}
   if(session?.state==='fault')await disconnect();
   if(!current())return;
   if(!session){easyAction.message='Connecting to the selected ESP…';opened=await connect({port,isCurrent:current});}
   if(!current())return;
   if(initial.role==='rx'){
    if(session?.state!=='idle')throw Error($('status').textContent||'The ESP is not ready.');
    receiver=session;
    const hz=readFrequency(),previous=lastFineByPort.get(receiver.port);
    const fine=previous?.hz===hz?previous.fine:0;
    const track={hz,fine,searching:true,probe:makeTuningProbe(),lastSync:0,retryAt:Infinity};
    receiver.acquisition=track;
    $('fine').value=fine;
    await tuneRadio(receiver,{hz,fine},current);
    if(current())void acquireRadio(receiver,track,true);
    if(listenTask)await listenTask;
    if(!current())return;easyAction.message='Receiving';
   }else{
    if(session?.state!=='rx')throw Error($('status').textContent||'The ESP is not ready.');
    if(initial.usage!=='audio'&&easyVideoSource==='camera'&&(!cameraActive||activeCameraSelection!==avApp.config().cameraDeviceId)){
     easyAction.message='Waiting for camera permission…';easyApp?.refresh();resources.pendingCamera=true;
     const task=startCamera();resources.cameraRequest=cameraGeneration;await task;
     if(!current())return;
     resources.pendingCamera=false;if(!cameraActive)throw Error($('status').textContent||'Camera access failed.');resources.camera=cameraStream;
    }else if(initial.usage!=='audio'&&easyVideoSource==='pattern')usePattern();
    if(initial.usage!=='video'&&!avApp.ready()){
     easyAction.message='Waiting for microphone permission…';easyApp?.refresh();resources.pendingMic=true;
     const task=avApp.enableMicrophone();resources.micRequest=avApp.micRequest;await task;
     if(!current())return;
     resources.pendingMic=false;resources.mic=avApp.capture;if(!resources.mic)throw Error('Microphone capture did not start.');
    }
    if(!current())return;easyAction.message='Starting the broadcast…';easyApp?.refresh();await startTx();
    if(!current())return;if(session?.state!=='tx'||!session.txRunning)throw Error($('status').textContent||'The broadcast did not start.');
    easyAction.message='Broadcasting';
   }
  }catch(error){
   await easyReleaseMedia(resources);
   if(current()){await avApp?.pause();if(session&&(session===opened||session===receiver))await disconnect();easyFailure(error);throw error;}
  }finally{if(current()){easyAction.busy=false;setButtons();}}
 },
 async stop(){
  ++easyAction.generation;++connectGeneration;const resources=easyAction.resources;
  easyAction.busy=true;easyAction.error=false;easyAction.message='Stopping…';easyApp?.refresh();
  try{
   if(resources?.pendingCamera&&resources.cameraRequest===cameraGeneration)usePattern({preserveEasyChoice:true});
   if(resources?.pendingMic&&resources.micRequest===avApp?.micRequest)await avApp.stopMicrophone();
   await stopTx();await avApp?.pause();await easyReleaseMedia(resources);
   await disconnect();easyAction.message='Stopped';
  }catch(error){easyFailure(error);throw error;}
  finally{if(easyAction.resources===resources)easyAction.resources=null;easyAction.busy=false;setButtons();}
 },
 async disconnect(){return this.stop();},
 async refreshDevices(){await avApp.ui.refreshDevices();easyApp?.refresh();}
};
initModes();selectedMode();maxInitUI();
avApp=globalThis.CBAVSession.create({C,document,navigator,getVideoMode:()=>modeId,
 getVideoFrame:()=>{
  const cache=maxEnsureCache();
  if(maxFrameLease){cache.release(maxFrameLease);maxFrameLease=null;}
  cache.cancelQueued();
  const frame=cache.prepareFrom(()=>maxReadRGBA(imageSource==='camera'),maxControls(),{acquisitionSequence:maxAcquisitionSequence++});
  maxFrameLease=cache.next();preparedSource=frame.source;drawPreview(frame.pixels);txFieldCount++;
  return {pcm:maxFrameLease.pcm};
 },
 onVideoBytes:(pcm,meta)=>feedObservedVideo(pcm,meta),presentVideo:presentReceivedVideo, /* RX_PROGRESS_AV_FEED */
 onReceiveConfig:p=>{
  $('avUsage').value=p.videoMode?'av':'audio';$('avRate').value=String(p.audioRate);$('avChannels').value=String(p.audioChannels);
  if(p.videoMode&&p.videoMode!==modeId){modeId=p.videoMode;$('mode').value=modeId;selectedMode();}
  else if(p.videoMode)makeDecoder();
  setButtons();
 },
 onChange:()=>{if(avApp?.config().usage==='audio'&&(cameraActive||cameraPending))usePattern();maxUpdateUI();setButtons();},
 onCameraChange:()=>{if(cameraActive||cameraPending)void startCamera();},
 stopTransmit:stopTx,isTransmitLocked:()=>['tx','keying','stopping'].includes(session?.state),
 isReceiving:()=>session?.state==='rx'&&$('role').value==='rx',
 onError:error=>{status(error.message,true);log(error.message);const owned=easyAction.resources;
  const stopping=session?.txRunning?stopTx():Promise.resolve();
  if(owned&&!easyAction.busy)void stopping.then(()=>easyReleaseMedia(owned)).catch(failure=>log('Source cleanup: '+failure.message));
 }
});
setButtons();
$('role').addEventListener('change',()=>{setButtons();$('sourceLabel').textContent=$('role').value==='rx'?'LOCAL PREVIEW (NOT RECEIVED)':'TX SOURCE';});
$('sourceLabel').textContent='LOCAL PREVIEW (NOT RECEIVED)';
$('mode').addEventListener('change',()=>{modeId=$('mode').value;selectedMode();if(autoLineProbe)autoLineProbe.reset();avApp?.changed();});
$('auto320').addEventListener('change',()=>{if(autoLineProbe)autoLineProbe.reset();log('320 fast/stable detection: '+($('auto320').checked?'enabled':'disabled'));});
$('grayLevels').addEventListener('change',()=>{maxFrameCache?.cancelQueued();if(imageSource==='pattern')sourceRGBA=null;createSource(imageSource==='camera');});
$('contrast').addEventListener('input',()=>{maxFrameCache?.cancelQueued();$('contrastOut').textContent=formatNumber(Number($('contrast').value))+'×';if(imageSource==='pattern')sourceRGBA=null;createSource(imageSource==='camera');});
$('camera').addEventListener('click',startCamera);$('pattern').addEventListener('click',usePattern);
$('connect').addEventListener('click',connect);
$('disconnect').addEventListener('click',()=>{void easyBridge.disconnect().catch(()=>{});});
$('startTx').addEventListener('click',startTx);$('stopTx').addEventListener('click',stopTx);
$('selfTest').addEventListener('click',selfTest);
$('saveRxCapture').addEventListener('click',saveRxDiagnosticCapture);
for(const id of ['rxBrightness','rxContrast','hPosition','hHold','vHold','hLock','saturation','autoLevel'])$(id).addEventListener('input',updateRxControls);
$('resetHold').addEventListener('click',()=>{
 for(const [id,val] of [['hPosition','0'],['hHold','0'],['vHold','0'],['hLock','85']])$(id).value=val;
 updateRxControls();log('H/V raster centered.');
});
// Preview remains responsive even with no radio. While TX runs, the source is sampled at each actual video field boundary.
setInterval(()=>{if(cameraActive&&(!session||session.state!=='tx'))createSource(true);},130);
setInterval(()=>{updateStats();maxUpdateUI();easyApp?.refresh();},1000);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&session?.state==='tx'){
 if(avApp?.tx)log('Tab hidden: audio TX is paced by capture instead of page timers. A microphone suspension stops TX with an error.');
 else{log('Tab hidden: stopping TX to avoid browser timer throttling.');void stopTx();}
}});
if(globalThis.CBAVEasy)easyApp=globalThis.CBAVEasy.create({document,bridge:easyBridge});
log('ESP_VIDEO_V4 · 21 video profiles · 14 audio profiles · 1,500,000 baud · 120,000 PCM/s');
})();
