/* CB-VIDEO ANALOG V8 — UI + Web Serial for original CB FM Stereo V12. */
(()=>{
'use strict';
const C=globalThis.CBAnalogV8,$=id=>document.getElementById(id);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),ascii=new TextEncoder();
const RATE=C.FS,PREBUFFER=12000,WRITE_BLOCK=2400,PREFIX=[77,80,88,51];
let modeId='bw160',cameraStream=null,cameraActive=false,imageSource='pattern';
let preparedSource=null,sourceRGBA=null,scanFrame=null,scanOffset=0,txFieldCount=0;
let txBytes=0,txBytesAtLast=0,txRateAtLast=performance.now(),txMaxLate=0;
let rxBytes=0,rxBytesAtLast=0,rxRateAtLast=performance.now();
let rxLastIndex=null,lastRxPacketAt=0,rxFramesWindow=[],session=null,pending=[];
let rxDecode=null, autoLineProbe=null;
const previewCtx=$('preview').getContext('2d',{alpha:false}),receivedCtx=$('received').getContext('2d',{alpha:false});
const scratch=document.createElement('canvas'),scratchCtx=scratch.getContext('2d',{willReadFrequently:true});
const imgCam=$('cameraVideo');
const fmt=()=>C.getFormat(modeId),plan=()=>C.plan(modeId);
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
function makeDecoder(){
 rxDecode=new C.Decoder({mode:modeId,onFrame:(rgba,info)=>{
  // Full raw analog frame. There is NO pixel, scan-line or CRC quality filter.
  if(rgba.length===fmt().w*fmt().h*4){
   receivedCtx.putImageData(new ImageData(rgba,fmt().w,fmt().h),0,0);
   rxFramesWindow.push(performance.now());
  }
 }});
 rxDecode.onHSignal=start=>{if(autoLineProbe && $('auto320').checked && ['bw320','bw320stable'].includes(modeId))autoLineProbe.acceptH(start);};
 updateRxControls();
}
function drawPreview(rgba){
 const m=fmt();
 previewCtx.putImageData(new ImageData(rgba,m.w,m.h),0,0);
}
function createSource(forceCamera=false){
 const m=fmt();
 if(forceCamera&&cameraActive&&imgCam.readyState>=2&&imgCam.videoWidth){
  try{scratchCtx.drawImage(imgCam,0,0,m.w,m.h);sourceRGBA=scratchCtx.getImageData(0,0,m.w,m.h).data;}
  catch(e){log('Webcam capture: '+e.message);}
 }
 if(!sourceRGBA||sourceRGBA.length!==m.w*m.h*4)sourceRGBA=C.patternRGBA(modeId);
 const pixels=new Uint8ClampedArray(sourceRGBA);
 const levels=Number($('grayLevels').value),contrast=Number($('contrast').value);
 for(let i=0;i<pixels.length;i+=4){
  if(m.kind!=='color'){
   let y=Math.round(.299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2]);
   y=Math.max(0,Math.min(255,(y-128)*contrast+128));
   y=Math.round(Math.round(y*(levels-1)/255)*255/(levels-1));
   pixels[i]=pixels[i+1]=pixels[i+2]=y;
  }else{
   for(let k=0;k<3;k++)pixels[i+k]=Math.max(0,Math.min(255,Math.round((pixels[i+k]-128)*contrast+128)));
  }
 }
 drawPreview(pixels);preparedSource=C.sourceFromRGBA(modeId,pixels);
 return preparedSource;
}
function selectedMode(){
 const m=fmt(),p=plan();
 $('grayLevels').disabled=m.kind==='color';
 $('saturationRow').classList.toggle('hidden',m.kind!=='color');
 $('srcRes').textContent=`${m.w} × ${m.h}`;
 $('targetFps').textContent=formatNumber(p.frameFps)+' FPS';
 $('fieldFps').textContent='Progressive';
 $('lineHz').textContent=formatNumber(C.FS/(p.fieldSamples-C.VBLANK)*(p.rows.length),1)+' Hz (moy.)';
 $('fieldDuration').textContent=formatNumber(p.fieldSamples*1000/RATE,1)+' ms';
 $('modeKind').textContent=m.kind==='color'?'Analog YUV 4:2:0':'Progressive B&W';
 $('rxLabel').textContent=m.kind==='color'?'RX · COLOR':'RX · B&W';
 const hMax=Math.min(320,m.w);
 $('hPosition').min=String(-hMax);$('hPosition').max=String(hMax);
 if(Math.abs(+$('hPosition').value)>hMax)$('hPosition').value='0';
 resizeCanvases();makeDecoder();
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
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access blocked. Try http://localhost in Chrome/Edge.');
  if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());
  cameraStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:24}},audio:false});
  imgCam.srcObject=cameraStream;await imgCam.play();
  imageSource='camera';cameraActive=true;
  createSource(true);
  log('Webcam connected. One capture is taken at the beginning of each progressive frame.');
 }catch(e){status('Webcam : '+e.message,true);log('Webcam : '+e.message);}
}
function usePattern(){
 if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());
 cameraStream=null;cameraActive=false;imageSource='pattern';sourceRGBA=null;
 createSource(false);log('Analog test pattern selected.');
}
function getPcm(count){
 const p=plan(),m=fmt(),dst=new Uint8Array(count);let at=0;
 while(at<count){
  if(!scanFrame||scanOffset>=scanFrame.length){
   createSource(imageSource==='camera');
   scanFrame=C.makeWave(preparedSource,modeId);
   scanOffset=0;txFieldCount++;
  }
  const take=Math.min(count-at,scanFrame.length-scanOffset);
  dst.set(scanFrame.subarray(scanOffset,scanOffset+take),at);
  at+=take;scanOffset+=take;
 }
 return dst;
}
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
 if(!$('auto320').checked||$('role').value!=='rx'||!session||session.state!=='rx')return;
 if(!['bw320','bw320stable'].includes(modeId)||which===modeId)return;
 modeId=which;$('mode').value=which;selectedMode();
 log('AUTO 320: '+(which==='bw320stable'?'STABLE · 708':'FAST · 388')+' samples/line detected. Waiting for the next V pulse.');
 status('RX: '+(which==='bw320stable'?'320×240 Stable (0.71 FPS)':'320×240 Fast (1.29 FPS)')+' detected from H pulses.');
}
class ByteParser{
 constructor(onFrame,onLine,onReady){this.rest=new Uint8Array(0);this.onFrame=onFrame;this.onLine=onLine;this.onReady=onReady;}
 feed(chunk){
  let data;if(this.rest.length){data=new Uint8Array(this.rest.length+chunk.length);data.set(this.rest);data.set(chunk,this.rest.length);}else data=chunk;
  let at=0;
  while(at<data.length){
   const c=data[at];
   if(c===77){
    const n=Math.min(4,data.length-at);let good=true;
    for(let j=1;j<n;j++)if(data[at+j]!==PREFIX[j])good=false;
    if(good){
     if(data.length-at<138)break;
     const view=new DataView(data.buffer,data.byteOffset+at,138),index=view.getUint32(4,true),strength=view.getUint16(8,true);
     this.onFrame(index,strength,data.subarray(at+10,at+138));at+=138;continue;
    }
   }
   if(c===0xEF){
    if(data.length-at<4)break;
    if(data[at+1]===0xEF&&data[at+2]===0xEF&&data[at+3]===0xEF){this.onReady();at+=4;continue;}
   }
   if(c===79||c===69){
    const wanted=c===79?[79,75,32]:[69,82,82,32],n=Math.min(wanted.length,data.length-at);let same=true;
    for(let j=1;j<n;j++)if(data[at+j]!==wanted[j])same=false;
    if(same){
     if(data.length-at<wanted.length)break;
     const lim=Math.min(data.length,at+150);let end=at+wanted.length;
     for(;end<lim&&data[end]!==10&&data[end]!==13;end++)if(data[end]<32||data[end]>126)break;
     if(end>=data.length)break;
     if(data[end]===10||data[end]===13){this.onLine(new TextDecoder().decode(data.subarray(at,end)));at=end+(data[end]===13&&data[end+1]===10?2:1);continue;}
    }
   }
   at++;
  }
  this.rest=data.slice(at);if(this.rest.length>4096)this.rest=new Uint8Array(0);
 }
}
function rxFrame(index,_strength,bytes){
 if(!session||session.state!=='rx')return;
 lastRxPacketAt=performance.now();rxBytes+=bytes.length;
 if(rxLastIndex!==null){
  const diff=(index-rxLastIndex)>>>0;
  if(diff>0&&diff<RATE*20){
   // A large hole is not decoded sample-by-sample on the browser thread.
   // Keep the sample timeline moving; show snow where RF samples are absent.
   if(diff<=384)rxDecode.feedMissing(diff);
   else rxDecode.skipMissing(diff);
   if(autoLineProbe)autoLineProbe.skip(diff);
  }else if(diff>=RATE*20){
   rxDecode.drawSnowFrame();if(autoLineProbe)autoLineProbe.skip(0);
   log('MPX3 sample-timeline discontinuity: analog display continues.');
  }
 }
 rxDecode.feedBytes(bytes);rxLastIndex=(index+bytes.length)>>>0;
}
function response(line){
 log(line);
 for(const item of [...pending])if(item.test(line)){
  pending=pending.filter(p=>p!==item);clearTimeout(item.timer);item.resolve(line);
 }
 if(/^ERR /.test(line)){
  for(const item of pending){clearTimeout(item.timer);item.reject(new Error(line));}pending=[];
  if(session?.state==='tx'){session.txRunning=false;session.state='rx';setButtons();status('Radio fault: '+line,true);}
 }
}
function ready(){if(session?.state==='keying'){session.ready?.();session.ready=null;}}
function waitLine(test,ms=4500){return new Promise((resolve,reject)=>{
 const p={test,resolve,reject,timer:0};p.timer=setTimeout(()=>{pending=pending.filter(x=>x!==p);reject(Error('Serial response timed out'));},ms);pending.push(p);
});}
function readConfig(){
 const hz=Math.round(Number($('frequency').value)*1e6),fine=Number($('fine').value),apwr=Number($('apwr').value);
 if(!Number.isSafeInteger(hz)||hz<2401000000||hz>2482500000)throw Error('RF frequency must be 2401–2482.5 MHz');
 if(!Number.isInteger(fine)||Math.abs(fine)>50000)throw Error('RX fine tuning must be within ±50 kHz');
 if(!Number.isInteger(apwr)||apwr<0||apwr>191)throw Error('APWR must be between 0 and 191');
 return {hz,fine,apwr};
}
async function write(bytes,own=session){if(!own||own.closing)throw Error('Serial port unavailable');await own.writer.write(typeof bytes==='string'?ascii.encode(bytes):bytes);}
async function commandAwait(command,test,ms=4500,own=session){const reply=waitLine(test,ms);await write(command,own);return reply;}
async function readSerial(own){
 const parser=new ByteParser(rxFrame,response,ready);
 try{
  while(session===own&&!own.closing){
   const reader=own.port.readable.getReader();own.reader=reader;
   try{while(session===own&&!own.closing){const {value,done}=await reader.read();if(done)return;if(value?.length)parser.feed(value);}}
   finally{reader.releaseLock();own.reader=null;}
  }
 }catch(e){if(!own.closing){log('Serial RX: '+e.message);status('USB reading interrupted: '+e.message,true);}}
}
function setButtons(){
 const state=session?.state||'off',on=state!=='off'&&state!=='connecting';
 $('connect').disabled=state!=='off';$('disconnect').disabled=!on;
 $('startTx').disabled=state!=='rx'||$('role').value!=='tx';
 $('stopTx').disabled=!['tx','keying','stopping'].includes(state);
 $('role').disabled=state!=='off';$('frequency').disabled=state!=='off';$('fine').disabled=state!=='off';$('apwr').disabled=state!=='off';
 $('mode').disabled=['tx','keying','stopping'].includes(state);
}
async function connect(){
 if(session)return;let own=null;
 try{
  const cfg=readConfig();
  if(!navigator.serial)throw Error('Web Serial is unavailable. Use desktop Chrome/Edge, preferably via localhost.');
  const port=await navigator.serial.requestPort();
  await port.open({baudRate:2000000,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:65536});
  own={port,writer:port.writable.getWriter(),reader:null,state:'connecting',closing:false,txRunning:false,txTask:null,readTask:null,ready:null};
  session=own;own.readTask=readSerial(own);setButtons();status('Checking CB FM STEREO V12 firmware...');
  await sleep(280);
  let ok=false;
  for(let i=0;i<3;i++){
   try{await commandAwait('STATUS\n',s=>/^OK STATUS CB_FM_STEREO 4$/.test(s),2200,own);ok=true;break;}
   catch(e){if(i===2||/^ERR /.test(e.message))throw e;await sleep(430);}
  }
  if(!ok)throw Error('V12 firmware not recognized. The 160K firmware is incompatible.');
  await commandAwait('STOP\n',s=>s==='OK STOP',3500,own);
  const reply=await commandAwait(`RX ${cfg.hz} HQ ${cfg.fine}\n`,s=>/^OK RX \d+ 120000 HQ$/.test(s),5500,own);
  log('Original firmware RX 120000 HQ: '+reply);
  rxLastIndex=null;lastRxPacketAt=performance.now();rxDecode.reset(true);updateRxControls();
  autoLineProbe=new Auto320LineProbe(autoDetect320);
  own.state='rx';setButtons();status($('role').value==='rx'?'RX analog TV active · H/V scanning · RF defects visible':'Radio ready · enable webcam or test pattern, then select Start TX');
 }catch(e){const message='Connection: '+e.message;log(message);if(own&&session===own)await disconnect();status(message,true);}
}
async function disconnect(){
 const own=session;if(!own||own.closing)return;
 own.closing=true;own.txRunning=false;
 for(const p of pending){clearTimeout(p.timer);p.reject(Error('Disconnected'));}pending=[];
 if(['tx','keying'].includes(own.state))await sleep(200);
 session=null;autoLineProbe=null;
 try{await own.reader?.cancel();}catch(_){}
 try{await own.readTask;}catch(_){}
 try{own.writer.releaseLock();}catch(_){}
 try{await own.port.close();}catch(_){}
 setButtons();status('USB serial disconnected.');log('USB serial disconnected.');
}
async function txLoop(own){
 try{
  txBytes=0;txBytesAtLast=0;txRateAtLast=performance.now();txMaxLate=0;
  scanOffset=0;scanFrame=null;txFieldCount=0;
  await write(getPcm(PREBUFFER),own);txBytes+=PREBUFFER;
  let clock=performance.now(),sent=0;
  while(session===own&&own.txRunning&&!own.closing){
   const goal=clock+sent*1000/RATE,wait=goal-performance.now();
   if(wait>1)await sleep(Math.min(wait,50));
   if(session!==own||!own.txRunning)break;
   const late=performance.now()-goal;if(late>txMaxLate)txMaxLate=Math.ceil(late);
   if(late>120){clock=performance.now()-sent*1000/RATE;log('Browser scheduling delayed: resumed stream without a catch-up USB burst.');}
   await write(getPcm(WRITE_BLOCK),own);sent+=WRITE_BLOCK;txBytes+=WRITE_BLOCK;
  }
 }catch(e){if(session===own&&!own.closing){status('TX error: '+e.message,true);log('TX error: '+e.message);}}
 finally{
  if(session===own){own.txRunning=false;
   if(own.state==='tx'){own.state='stopping';setButtons();await sleep(310);if(session===own&&own.state==='stopping'){own.state='rx';status('TX stopped; returning to HQ reception.');setButtons();}}
  }
 }
}
async function startTx(){
 const own=session;if(!own||own.state!=='rx'||$('role').value!=='tx')return;
 try{
  const {apwr}=readConfig();own.state='keying';setButtons();status('Issuing RF TX command, waiting for READY...');
  const readyP=new Promise((resolve,reject)=>{const t=setTimeout(()=>{own.ready=null;reject(Error('RF READY signal not received'));},3500);own.ready=()=>{clearTimeout(t);resolve();};});
  await write(`TX ${apwr}\n`,own);await readyP;
  if(session!==own||own.closing||own.state!=='keying')return;
  own.state='tx';own.txRunning=true;setButtons();
  log(`TX PCM8 120 kHz - ${modeId} - ${formatNumber(plan().frameFps)} FPS - APWR ${apwr}`);
  status('Continuous video transmission active — keep this tab in the foreground.');own.txTask=txLoop(own);
 }catch(e){if(session===own){own.ready=null;own.txRunning=false;own.state='rx';setButtons();status('Unable to start TX: '+e.message,true);log('TX error: '+e.message);}}
}
async function stopTx(){const own=session;if(!own||!['tx','keying','stopping'].includes(own.state))return;own.txRunning=false;if(own.txTask)await own.txTask;if(session===own&&own.state==='keying'){own.state='stopping';setButtons();await sleep(330);if(session===own){own.state='rx';setButtons();}}}
function updateRxControls(){
 if(!rxDecode)return;
 rxDecode.setLevels({brightness:Number($('rxBrightness').value),contrast:Number($('rxContrast').value),saturation:Number($('saturation').value),
  autoLevel:$('autoLevel').checked,hPosition:Number($('hPosition').value),hHold:Number($('hHold').value),vHold:Number($('vHold').value),hLock:Number($('hLock').value)/100});
 for(const [id,out,suffix] of [['hPosition','hPositionOut',' px'],['vHold','vHoldOut',' samples/frame'],['hLock','hLockOut',' %'],['rxBrightness','rxBrightnessOut','']])$(out).textContent=$ (id).value+suffix;
 for(const [id,out,suffix] of [['hHold','hHoldOut',' samples/line'],['rxContrast','rxContrastOut','×'],['saturation','saturationOut','×']])$(out).textContent=formatNumber(Number($(id).value))+suffix;
}
function selfTest(){
 const m=fmt(),p=plan(),rgba=C.patternRGBA(modeId),source=C.sourceFromRGBA(modeId,rgba);
 let last=null,meta=null;const test=new C.Decoder({mode:modeId,onFrame:(pic,s)=>{last=pic;meta=s;}});
 // Apply mild analog distortion plus a small hole: it stays visible, never rejected.
 for(let field=0;field<p.fieldsPerFrame;field++){
  const wave=C.makeWave(source,modeId,field);
  let filtered=-48;const distorted=new Uint8Array(wave.length);
  for(let i=0;i<wave.length;i++){
   const x=(wave[i]<<24)>>24;filtered+=.68*(x-filtered);
   distorted[i]=Math.max(-127,Math.min(127,Math.round(filtered*.94+3)))&255;
  }
  distorted.fill(128,Math.round(wave.length*.55),Math.round(wave.length*.55)+42);
  for(let i=0;i<distorted.length;i+=128)test.feedBytes(distorted.subarray(i,i+128));
 }
 if(last){receivedCtx.putImageData(new ImageData(last,m.w,m.h),0,0);$('selfTestResult').textContent=`Simulation OK : ${meta.frames} frame(s), ${meta.verticalSyncs} V pulse(s), ${meta.horizontalSyncs} H pulse(s), visible noise, zero scanlines rejected.`;}
 else $('selfTestResult').textContent='Simulation incomplete: no frame displayed.';
 log($('selfTestResult').textContent);
}
function showSnow(){rxDecode.drawSnowFrame();}
function updateStats(){
 const now=performance.now(),elapsed=Math.max(.001,(now-txRateAtLast)/1000);
 $('txRate').textContent=((txBytes-txBytesAtLast)/elapsed/1000).toFixed(1);txBytesAtLast=txBytes;txRateAtLast=now;
 const elapsedRx=Math.max(.001,(now-rxRateAtLast)/1000);
 $('rxRate').textContent=((rxBytes-rxBytesAtLast)/elapsedRx/1000).toFixed(1);
 rxBytesAtLast=rxBytes;rxRateAtLast=now;
 rxFramesWindow=rxFramesWindow.filter(t=>now-t<5000);
 $('rxFps').textContent=formatNumber(rxFramesWindow.length/5);
 $('missed').textContent=rxDecode.totalMissing.toLocaleString('en-US');
 $('rxSync').textContent=rxDecode.verticalSyncs.toLocaleString('en-US');
 $('rxHSync').textContent=rxDecode.horizontalSyncs.toLocaleString('en-US');
 const vRecent=rxDecode.verticalSyncs>0 && rxDecode.totalSamples-rxDecode.lastVAt<rxDecode.p.fieldSamples*1.6;
 $('lockStatus').textContent=rxDecode.hLocked?(vRecent?'H + V locked':'H locked · searching for V'):(vRecent?'Acquiring H · V detected':'Searching for H / V');
 $('syncDetails').textContent=`H: ${rxDecode.horizontalSyncs} · V: ${rxDecode.verticalSyncs} · candidates: ${rxDecode.hCandidates} · false H: ${rxDecode.falseH} · missing H: ${rxDecode.hLost} · sync margin: ${rxDecode.markerContrast.toFixed(0)} PCM`;
 $('lockStatus').style.color=rxDecode.hLocked?'#7de2ae':'#f4c17a';
 $('txJitter').textContent=String(txMaxLate);
 $('markerLevels').textContent=rxDecode.rxSyncMean===null?'Received reference levels: searching for H/V…':`SYNC ${rxDecode.rxSyncMean.toFixed(0)} · Black ${rxDecode.rxBlackMean.toFixed(0)} · White ${rxDecode.rxWhiteMean.toFixed(0)} PCM`;
 if(session?.state==='rx'&&$('role').value==='rx'&&lastRxPacketAt&&now-lastRxPacketAt>1600)rxDecode.drawSnowFrame();
}
initModes();selectedMode();setButtons();
$('role').addEventListener('change',()=>{setButtons();$('sourceLabel').textContent=$('role').value==='rx'?'LOCAL PREVIEW (NOT RECEIVED)':'TX SOURCE';});
$('sourceLabel').textContent='LOCAL PREVIEW (NOT RECEIVED)';
$('mode').addEventListener('change',()=>{modeId=$('mode').value;selectedMode();if(autoLineProbe)autoLineProbe.reset();});
$('auto320').addEventListener('change',()=>{if(autoLineProbe)autoLineProbe.reset();log('320 fast/stable detection: '+($('auto320').checked?'enabled':'disabled'));});
$('grayLevels').addEventListener('change',()=>{if(imageSource==='pattern')sourceRGBA=null;createSource(imageSource==='camera');});
$('contrast').addEventListener('input',()=>{$('contrastOut').textContent=formatNumber(Number($('contrast').value))+'×';if(imageSource==='pattern')sourceRGBA=null;createSource(imageSource==='camera');});
$('camera').addEventListener('click',startCamera);$('pattern').addEventListener('click',usePattern);
$('connect').addEventListener('click',connect);$('disconnect').addEventListener('click',disconnect);
$('startTx').addEventListener('click',startTx);$('stopTx').addEventListener('click',stopTx);
$('selfTest').addEventListener('click',selfTest);$('snow').addEventListener('click',showSnow);
for(const id of ['rxBrightness','rxContrast','hPosition','hHold','vHold','hLock','saturation','autoLevel'])$(id).addEventListener('input',updateRxControls);
$('resetHold').addEventListener('click',()=>{
 for(const [id,val] of [['hPosition','0'],['hHold','0'],['vHold','0'],['hLock','85']])$(id).value=val;
 updateRxControls();log('H/V raster centered.');
});
// Preview remains responsive even with no radio. While TX runs, the source is sampled at each actual video field boundary.
setInterval(()=>{if(cameraActive&&(!session||session.state!=='tx'))createSource(true);},130);
setInterval(updateStats,1000);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&session?.state==='tx'){log('Tab hidden: stopping TX to avoid browser timer throttling.');void stopTx();}});
log('CB-VIDEO V8: H/V waveform-based sync separation, reserved levels, black-level restoration, original 120K V12 firmware.');
})();
