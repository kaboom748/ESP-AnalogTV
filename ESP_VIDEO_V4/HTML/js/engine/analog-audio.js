
/* Continuous analog audio. No modem, payload CRC, codec, or file reconstruction.
 * Capture/read indices count AUDIO FRAMES (one sample per channel); playback
 * timestamps are source seconds shared with video. No device opens on import.
 * Serve AUDIO/analog-audio-worklet.js from the same localhost origin. file://
 * can use the audible ScriptProcessor fallback; onWarning reports that choice.
 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CBAnalogAudio=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const RATES=Object.freeze([8000,12000,16000,24000,32000,44100,48000]);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function integer(n,min,max,name){if(!Number.isSafeInteger(n)||n<min||n>max)throw RangeError(name||'Invalid integer');return n;}
function audioRate(n){if(!RATES.includes(n))throw RangeError('Unsupported audio rate');return n;}
function channelCount(n){return integer(n,1,2,'Audio must have one or two channels');}
function duration(n,min,max,name){if(!Number.isFinite(n)||n<min||n>max)throw RangeError(name||'Invalid duration');return n;}
function validateSamples(samples,channels){if(!(samples instanceof Float32Array)||samples.length%channels)throw TypeError('Interleaved Float32 audio frames required');for(let i=0;i<samples.length;i++)if(!Number.isFinite(samples[i]))throw RangeError('Non-finite audio sample');return samples.length/channels;}

function validateMask(valid,frames){if(valid!==undefined&&(!(valid instanceof Uint8Array)||valid.length!==frames))throw TypeError('Audio validity mask must contain one byte per frame');}

// Newly exposed cells are invalidated on every wrap, so a compact validity byte
// distinguishes an actual sample hole without a second Float64 timestamp ring.
class IndexedRing{
 constructor(capacityFrames,channels=1){this.capacity=integer(capacityFrames,2,192000*120,'Audio ring capacity');this.channels=channelCount(channels);this.data=new Float32Array(this.capacity*this.channels);this.tags=new Uint8Array(this.capacity);this.startFrame=0;this.endFrame=0;this.initialized=false;this.overwrittenFrames=0;}
 clear(){this.tags.fill(0);this.startFrame=this.endFrame=0;this.initialized=false;this.overwrittenFrames=0;}
 write(startFrame,samples,valid){integer(startFrame,0,Number.MAX_SAFE_INTEGER,'Audio frame index');const frames=validateSamples(samples,this.channels);validateMask(valid,frames);if(!frames)return 0;integer(startFrame+frames,0,Number.MAX_SAFE_INTEGER,'Audio end index');const nextEnd=Math.max(this.endFrame,startFrame+frames),nextStart=Math.max(this.initialized?this.startFrame:startFrame,nextEnd-this.capacity);if(!this.initialized||nextEnd-this.endFrame>=this.capacity)this.tags.fill(0);else for(let frame=this.endFrame;frame<nextEnd;frame++)this.tags[frame%this.capacity]=0;if(this.initialized&&nextStart>this.startFrame)this.overwrittenFrames+=nextStart-this.startFrame;this.startFrame=nextStart;this.endFrame=nextEnd;this.initialized=true;for(let j=Math.max(0,nextStart-startFrame);j<frames;j++){const frame=startFrame+j,at=frame%this.capacity;this.tags[at]=valid?Number(!!valid[j]):1;for(let c=0;c<this.channels;c++)this.data[at*this.channels+c]=clamp(samples[j*this.channels+c],-1,1);}return frames;}
 at(frame,channel=0){if(frame<this.startFrame||frame>=this.endFrame||!Number.isSafeInteger(frame))return undefined;const at=frame%this.capacity;return this.tags[at]?this.data[at*this.channels+channel]:undefined;}
 read(startFrame,frames){integer(startFrame,0,Number.MAX_SAFE_INTEGER,'Audio read index');integer(frames,0,this.capacity,'Audio read length');const samples=new Float32Array(frames*this.channels);let missingFrames=0;for(let j=0;j<frames;j++){const frame=startFrame+j;if(this.at(frame,0)===undefined){missingFrames++;continue;}for(let c=0;c<this.channels;c++)samples[j*this.channels+c]=this.at(frame,c);}return{startFrame,samples,frames,missingFrames};}
 get availableFrames(){return this.initialized?this.endFrame-this.startFrame:0;}
}

// Windowed-sinc filtering precedes decimation. Integer output indices retain
// exact rational clock phase at 44.1 kHz even after arbitrarily many blocks.
const kernels=new Map();
function kernelFor(sourceRate,targetRate){const key=sourceRate+'/'+targetRate;if(kernels.has(key))return kernels.get(key);const ratio=Math.min(1,targetRate/sourceRate),radius=Math.min(192,Math.ceil(16/ratio)),width=radius*2,phases=256,cutoff=ratio*.94,table=new Float32Array(phases*width);for(let p=0;p<phases;p++){const fraction=p/phases;let sum=0;for(let j=0;j<width;j++){const d=j-radius+1-fraction,r=d/radius,w=Math.abs(r)>=1?0:.42+.5*Math.cos(Math.PI*r)+.08*Math.cos(2*Math.PI*r),z=cutoff*d,value=(Math.abs(z)<1e-12?cutoff:Math.sin(Math.PI*z)/(Math.PI*d))*w;table[p*width+j]=value;sum+=value;}for(let j=0;j<width;j++)table[p*width+j]/=sum;}const result={radius,width,phases,table};if(kernels.size>=8)kernels.delete(kernels.keys().next().value);kernels.set(key,result);return result;}
class StreamingResampler{
 constructor(sourceRate,targetRate,channels=1){this.sourceRate=integer(sourceRate,4000,192000,'Input sample rate');this.targetRate=integer(targetRate,4000,192000,'Output sample rate');this.channels=channelCount(channels);this.kernel=kernelFor(sourceRate,targetRate);this.ring=new IndexedRing(65536+this.kernel.width*2,channels);this.inputFrames=0;this.outputFrames=0;this.finished=false;this.latencySeconds=sourceRate===targetRate?0:this.kernel.radius/sourceRate;}
 push(samples){if(this.finished)throw Error('Audio resampler already flushed');const frames=validateSamples(samples,this.channels);if(frames>65536)throw RangeError('Audio input block exceeds bounded resampler');if(this.sourceRate===this.targetRate){this.inputFrames+=frames;this.outputFrames+=frames;return samples.slice();}this.ring.write(this.inputFrames,samples);this.inputFrames+=frames;return this._produce(false);}
 _produce(final){const k=this.kernel,count=final?Math.round(this.inputFrames*this.targetRate/this.sourceRate):Math.max(0,Math.floor((this.inputFrames-1-k.radius)*this.targetRate/this.sourceRate)+1),frames=Math.max(0,count-this.outputFrames),out=new Float32Array(frames*this.channels);for(let j=0;j<frames;j++){const pos=this.outputFrames*this.sourceRate/this.targetRate,index=Math.floor(pos),phase=Math.min(k.phases-1,Math.floor((pos-index)*k.phases));for(let c=0;c<this.channels;c++){let value=0;for(let t=0;t<k.width;t++){const frame=clamp(index+t-k.radius+1,0,this.inputFrames-1),x=this.ring.at(frame,c);if(x===undefined)throw Error('Resampler input window was overwritten');value+=x*k.table[phase*k.width+t];}out[j*this.channels+c]=clamp(value,-1,1);}this.outputFrames++;}return out;}
 flush(){if(this.finished)return new Float32Array(0);this.finished=true;return this.sourceRate===this.targetRate||!this.inputFrames?new Float32Array(0):this._produce(true);}
}
function interleave(input,channels){const frames=input[0]?.length||0,out=new Float32Array(frames*channels);for(let i=0;i<frames;i++)if(channels===1){let sum=0;for(const ch of input)sum+=ch[i];out[i]=input.length?sum/input.length:0;}else{out[i*2]=input[0]?.[i]||0;out[i*2+1]=(input[1]||input[0])?.[i]||0;}return out;}

// Pure rendering state, shared by AudioWorklet, fallback, and deterministic tests.
// Arrival gaps fade honestly to zero; they never become synthetic exact audio.
class PlaybackState{
 constructor(options={}){this.rate=audioRate(options.rate||16000);this.channels=channelCount(options.channels||1);this.outputRate=integer(options.outputRate||48000,4000,192000,'Playback sample rate');this.delaySeconds=duration(options.delaySeconds===undefined?.25:options.delaySeconds,0,110,'Audio/video delay');this.maxBufferSeconds=duration(options.maxBufferSeconds===undefined?Math.max(2,this.delaySeconds+2):options.maxBufferSeconds,this.delaySeconds+.1,120,'Audio buffer bound');this.ring=new IndexedRing(Math.ceil(this.maxBufferSeconds*this.rate),this.channels);this.kernel=kernelFor(this.rate,this.outputRate);this.position=null;this.firstFrame=null;this.started=false;this.last=new Float32Array(this.channels);this.fade=new Float32Array(this.channels);this.fade.fill(1);this.drift=0;this.framesRendered=0;this.underrunFrames=0;this.rejectedFrames=0;this.receivedFrames=0;this.inputMissingFrames=0;this.concealing=false;}
 push(packet){const timestamp=duration(Number(packet.timestamp),0,Number.MAX_SAFE_INTEGER/this.rate,'Audio timestamp'),frames=validateSamples(packet.samples,this.channels),startFrame=Math.round(timestamp*this.rate);validateMask(packet.valid,frames);if(frames>this.ring.capacity)throw RangeError('Audio packet exceeds jitter buffer');if(!frames)return true;if(this.position===null){this.position=startFrame;this.firstFrame=startFrame;}if(startFrame+frames>Math.floor(this.position)+this.ring.capacity){this.rejectedFrames+=frames;return false;}this.ring.write(startFrame,packet.samples,packet.valid);if(packet.valid)for(const valid of packet.valid)if(!valid)this.inputMissingFrames++;this.receivedFrames+=frames;return true;}
 render(frames){integer(frames,0,65536,'Playback block');const output=Array.from({length:this.channels},()=>new Float32Array(frames));if(this.position===null)return output;const delayFrames=this.delaySeconds*this.rate,lookahead=this.kernel.radius+2;if(!this.started){if(this.ring.endFrame-this.position<Math.max(delayFrames,lookahead))return output;this.started=true;}const elapsed=frames/this.outputRate,error=(this.ring.endFrame-this.position-delayFrames)/this.rate,target=clamp(error/10,-.003,.003);this.drift+=(target-this.drift)*(1-Math.exp(-elapsed/5));const step=this.rate/this.outputRate*(1+this.drift),k=this.kernel;
  for(let i=0;i<frames;i++){const index=Math.floor(this.position),fraction=this.position-index,phase=Math.min(k.phases-1,Math.floor(fraction*k.phases));let valid=true;for(let c=0;c<this.channels;c++){let value=0,channelValid=true;if(this.rate===this.outputRate&&Math.abs(this.drift)<1e-10&&fraction<1e-8){const x=this.ring.at(index,c);if(x===undefined)channelValid=false;else value=x;}else{for(let j=0;j<k.width;j++){const at=Math.max(this.ring.startFrame,index+j-k.radius+1),x=this.ring.at(at,c);if(x===undefined){channelValid=false;break;}value+=x*k.table[phase*k.width+j];}}if(channelValid){this.fade[c]=Math.min(1,this.fade[c]+1/(this.outputRate*.003));this.last[c]=clamp(value,-1,1);output[c][i]=this.last[c]*this.fade[c];}else{valid=false;this.fade[c]=Math.max(0,this.fade[c]-1/(this.outputRate*.01));output[c][i]=this.last[c]*this.fade[c];}}if(!valid)this.underrunFrames++;this.concealing=!valid;this.position+=step;this.framesRendered++;}
  return output;
 }
 getPlayhead(){return this.started?this.position/this.rate:null;}
 stats(){return{rate:this.rate,outputRate:this.outputRate,channels:this.channels,started:this.started,playhead:this.getPlayhead(),firstTimestamp:this.firstFrame===null?null:this.firstFrame/this.rate,delaySeconds:this.delaySeconds,bufferedSeconds:this.position===null?0:Math.max(0,(this.ring.endFrame-this.position)/this.rate),capacitySeconds:this.ring.capacity/this.rate,receivedFrames:this.receivedFrames,inputMissingFrames:this.inputMissingFrames,framesRendered:this.framesRendered,underrunFrames:this.underrunFrames,rejectedFrames:this.rejectedFrames,concealing:this.concealing,driftPpm:this.drift*1e6,memoryBytes:this.ring.data.byteLength+this.ring.tags.byteLength};}
}

function environment(options){return options.environment||globalThis;}
function defaultWorkletUrl(env){const base=env.document?.baseURI||env.location?.href;if(!base)return null;return new URL('./AUDIO/analog-audio-worklet.js',base).href;}
function notify(options,message){if(typeof options.onWarning==='function')options.onWarning(message);}
function reportError(options,error){if(typeof options.onError==='function')options.onError(error instanceof Error?error:new Error(String(error)));else notify(options,error.message||String(error));}
function abortError(){const error=Error('Audio operation cancelled');error.name='AbortError';return error;}
function operation(){
 let cancel;const cancelled=new Promise((_,reject)=>{cancel=()=>reject(abortError());});
 cancelled.catch(()=>{});return{cancelled,cancel,stopped:false,running:false,context:null,owned:false,node:null,source:null,gain:null,stream:null,mode:null,promise:null,cleanup:null};
}
async function pending(promise,run,timeoutMs,message){
 let timer;try{return await Promise.race([promise,run.cancelled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeoutMs);})]);}finally{clearTimeout(timer);}
}
function newContext(options){
 const env=environment(options);if(options.context)return{context:options.context,owned:false};
 const Constructor=env.AudioContext||env.webkitAudioContext;if(!Constructor)throw Error('Web Audio is unavailable in this browser.');
 let context;try{context=new Constructor({latencyHint:'interactive',sampleRate:48000});}catch(_){context=new Constructor({latencyHint:'interactive'});}return{context,owned:true};
}
async function resumeContext(run,options){
 if(run.context.state==='running')return;
 await pending(run.context.resume(),run,integer(options.resumeTimeoutMs??5000,1,30000,'Audio resume timeout'),'Audio could not start. Click Listen or Enable microphone again and allow audio playback.');
 if(run.stopped)throw abortError();if(run.context.state!=='running')throw Error('The audio context did not enter its running state.');
}
function stopTracks(stream){for(const track of stream?.getTracks()||[])try{track.stop();}catch(_){}}
async function cleanup(run){
 if(!run)return;if(run.cleanup)return run.cleanup;
 run.stopped=true;run.running=false;run.cancel();
 run.cleanup=(async()=>{
  try{run.unwatch?.();}catch(_){}run.unwatch=null;
  for(const node of[run.source,run.node,run.gain])try{node?.disconnect();}catch(_){}
  if(run.node){run.node.onaudioprocess=null;run.node.onprocessorerror=null;if(run.node.port){run.node.port.onmessage=null;try{run.node.port.close?.();}catch(_){}}}
  stopTracks(run.stream);run.stream=run.source=run.node=run.gain=null;
  if(run.context&&run.owned){let timer;try{await Promise.race([run.context.close(),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}catch(_){}finally{clearTimeout(timer);}}
  run.context=null;
 })();return run.cleanup;
}
async function workletNode(context,name,options,processorOptions,nodeOptions={},run){
 const env=environment(options),url=options.workletUrl||defaultWorkletUrl(env),Constructor=env.AudioWorkletNode||globalThis.AudioWorkletNode;
 if(!url||!context.audioWorklet?.addModule||!Constructor)throw Error('AudioWorklet is unavailable.');
 const timeout=integer(options.moduleTimeoutMs??3500,1,30000,'Audio module timeout');
 await pending(context.audioWorklet.addModule(url),run,timeout,'AudioWorklet loading timed out; switching to the compatibility audio engine.');
 if(run.stopped)throw abortError();
 return new Constructor(context,name,{numberOfInputs:name==='analog-av-capture'?1:0,numberOfOutputs:1,outputChannelCount:[name==='analog-av-capture'?1:processorOptions.channels],processorOptions,...nodeOptions});
}
function silenceOutput(buffer){try{for(let c=0;c<(buffer?.numberOfChannels||0);c++)buffer.getChannelData(c).fill(0);}catch(_){}}
function watchCapture(context,stream,isRunning,options){
 const remove=[];
 for(const track of stream?.getAudioTracks()||[]){const ended=()=>{if(isRunning())reportError(options,Error('The microphone was disconnected or stopped.'));};track.addEventListener?.('ended',ended,{once:true});remove.push(()=>track.removeEventListener?.('ended',ended));}
 const changed=()=>{if(isRunning()&&context.state!=='running')reportError(options,Error('The audio engine is '+context.state+'. Restart audio before continuing.'));};
 context.addEventListener?.('statechange',changed);remove.push(()=>context.removeEventListener?.('statechange',changed));
 return()=>{for(const callback of remove)callback();};
}
// Power-of-two ScriptProcessor size, at most 32 ms for actual contexts >=8 kHz.
function captureProcessorFrames(actualRate){integer(actualRate,8000,192000,'Actual capture context rate');return clamp(2**Math.floor(Math.log2(actualRate*.032)),256,16384);}
function normalizeOptions(options){const result={...options,rate:audioRate(options.rate||16000),channels:channelCount(options.channels||1)};if(options.bufferSeconds!==undefined)duration(options.bufferSeconds,.1,120,'Capture buffer duration');return result;}
async function listInputs(options={}){
 const devices=environment(options).navigator?.mediaDevices;if(!devices?.enumerateDevices)throw Error('Microphone enumeration is unavailable.');
 return(await devices.enumerateDevices()).filter(d=>d.kind==='audioinput').map(d=>({deviceId:d.deviceId,groupId:d.groupId,label:d.label||'Microphone (allow access to see its name)'}));
}

function createCapture(inputOptions={}){
 const options=normalizeOptions(inputOptions),ring=new IndexedRing(Math.ceil((options.bufferSeconds||2)*options.rate),options.channels);
 let run=null,cursor=0,settings=null,missingFrames=0,receivedFrames=0,reportedChannels=0,workletDroppedFrames=0;
 let gainValue=duration(options.gain===undefined?1:options.gain,0,4,'Microphone gain'),level=0,peak=0;
 const active=r=>run===r&&!r.stopped;
 const requireActive=r=>{if(!active(r))throw abortError();};
 const ingest=(r,samples,startFrame)=>{
  if(!active(r))return;validateSamples(samples,options.channels);let sum=0;peak=0;
  for(let i=0;i<samples.length;i++){samples[i]=clamp(samples[i]*gainValue,-1,1);sum+=samples[i]*samples[i];peak=Math.max(peak,Math.abs(samples[i]));}
  level=samples.length?Math.sqrt(sum/samples.length):0;ring.write(startFrame,samples);receivedFrames+=samples.length/options.channels;
  options.onSamples?.({startFrame,timestamp:startFrame/options.rate,samples});
 };
 const api={rate:options.rate,channels:options.channels,
  async start(){
   if(run?.running)return api;if(run?.promise)return run.promise;
   const r=operation();run=r;ring.clear();cursor=missingFrames=receivedFrames=workletDroppedFrames=0;level=peak=0;settings=null;reportedChannels=0;
   r.promise=(async()=>{try{
    Object.assign(r,newContext(options));await resumeContext(r,options);requireActive(r);
    const media=environment(options).navigator?.mediaDevices;if(!media?.getUserMedia)throw Error('Microphone access is unavailable. Open the page on localhost or HTTPS.');
    const requested={channelCount:{ideal:options.channels},echoCancellation:!!options.echoCancellation,noiseSuppression:!!options.noiseSuppression,autoGainControl:!!options.autoGainControl};
    if(options.deviceId)requested.deviceId={exact:options.deviceId};
    const permission=Promise.resolve(media.getUserMedia({audio:requested,video:false}));
    // getUserMedia itself cannot be aborted. Release a late grant after Stop.
    permission.then(stream=>{if(!active(r))stopTracks(stream);},()=>{});
    r.stream=await pending(permission,r,integer(options.permissionTimeoutMs??60000,1,120000,'Microphone permission timeout'),'Microphone access timed out. Allow access, then enable the microphone again.');
    requireActive(r);const track=r.stream.getAudioTracks()[0];if(!track)throw Error('The selected device does not provide an audio track.');
    settings=track.getSettings?.()||{};reportedChannels=settings.channelCount||0;r.unwatch=watchCapture(r.context,r.stream,()=>active(r)&&r.running,options);
    r.source=r.context.createMediaStreamSource(r.stream);r.gain=r.context.createGain();r.gain.gain.value=0;r.gain.connect(r.context.destination);
    try{
     r.node=await workletNode(r.context,'analog-av-capture',options,{rate:options.rate,channels:options.channels},{channelCountMode:'max',channelInterpretation:'discrete'},r);
     requireActive(r);
     r.node.port.onmessage=e=>{
      if(!active(r))return;const m=e.data;
      if(m.type==='capture'){
       const port=r.node.port,previousDropped=workletDroppedFrames;reportedChannels=settings.channelCount||m.inputChannels||reportedChannels;workletDroppedFrames=m.droppedFrames||0;
       try{ingest(r,m.samples,m.startFrame);if(workletDroppedFrames>previousDropped)reportError(options,Error('Microphone capture fell behind: '+(workletDroppedFrames-previousDropped)+' samples per channel were lost.'));}
       catch(error){reportError(options,error);}
       finally{try{port.postMessage({type:'captureAck'});}catch(_){}}
      }else if(m.type==='error')reportError(options,Error(m.message));
     };r.mode='worklet';
    }catch(error){
     requireActive(r);if(typeof r.context.createScriptProcessor!=='function')throw Error('Audio capture could not start: '+error.message);
     const resampler=new StreamingResampler(r.context.sampleRate,options.rate,options.channels);
     r.node=r.context.createScriptProcessor(captureProcessorFrames(r.context.sampleRate),options.channels,1);
     r.node.onaudioprocess=e=>{
      silenceOutput(e.outputBuffer);if(!active(r))return;
      try{const n=e.inputBuffer.numberOfChannels,planar=Array.from({length:n},(_,c)=>e.inputBuffer.getChannelData(c));reportedChannels=settings.channelCount||n;
       const samples=resampler.push(interleave(planar,options.channels)),startFrame=resampler.outputFrames-samples.length/options.channels;if(samples.length)ingest(r,samples,startFrame);
      }catch(error){silenceOutput(e.outputBuffer);reportError(options,error);}
     };r.mode='compatibility';notify(options,'AudioWorklet is unavailable: microphone capture is active in compatibility mode ('+error.message+').');
    }
    requireActive(r);r.node.onprocessorerror=()=>{if(active(r))reportError(options,Error('The AudioWorklet processor stopped.'));};
    r.source.connect(r.node);r.node.connect(r.gain);r.running=true;
    if(options.channels===2&&reportedChannels===1)notify(options,'This microphone reports one channel. Both transmitted channels will be identical.');
    return api;
   }catch(error){if(run===r)run=null;await cleanup(r);throw error;}finally{r.promise=null;}})();
   return r.promise;
  },
  async stop(){const r=run;run=null;await cleanup(r);},
  setGain(value){gainValue=duration(value,0,4,'Microphone gain');},
  read(startFrame,frames){const block=ring.read(startFrame,frames);missingFrames+=block.missingFrames;return block.samples;},
  readBlock(startFrame,frames){const block=ring.read(startFrame,frames);missingFrames+=block.missingFrames;return block;},
  readNext(frames,{pad=false}={}){integer(frames,0,ring.capacity,'Capture block');cursor=Math.max(cursor,ring.startFrame);if(!pad&&ring.endFrame-cursor<frames)return null;const block=ring.read(cursor,frames);cursor+=frames;missingFrames+=block.missingFrames;return block.samples;},
  seek(frame){cursor=integer(frame,ring.startFrame,ring.endFrame,'Capture cursor');},
  stats(){return{running:!!run?.running,mode:run?.mode||null,rate:options.rate,contextSampleRate:run?.context?.sampleRate||null,channels:options.channels,reportedChannels,trueStereo:reportedChannels>=2,settings:settings?{...settings}:null,startFrame:ring.startFrame,endFrame:ring.endFrame,writeFrames:ring.endFrame,availableFrames:ring.endFrame,bufferedFrames:ring.availableFrames,cursor,receivedFrames,missingFrames,underrunFrames:missingFrames,workletDroppedFrames,overwrittenFrames:ring.overwrittenFrames,gain:gainValue,level,peak,levelDb:level>0?20*Math.log10(level):-Infinity,memoryBytes:ring.data.byteLength+ring.tags.byteLength};},
  get startFrame(){return ring.startFrame;},get endFrame(){return ring.endFrame;},get availableFrames(){return ring.endFrame;},get bufferedFrames(){return ring.availableFrames;}
 };return api;
}

function createPlayback(inputOptions={}){
 const options=normalizeOptions(inputOptions),delaySeconds=duration(options.delaySeconds===undefined?.25:options.delaySeconds,0,110,'Audio/video delay');
 const maxBufferSeconds=duration(options.maxBufferSeconds===undefined?Math.max(2,delaySeconds+2):options.maxBufferSeconds,delaySeconds+.1,120,'Audio buffer duration'),frameBound=Math.ceil(maxBufferSeconds*options.rate);
 let run=null,queued=[],queuedFrames=0;
 const active=r=>run===r&&!r.stopped;
 const requireActive=r=>{if(!active(r))throw abortError();};
 const stateOptions=r=>({rate:options.rate,channels:options.channels,delaySeconds,maxBufferSeconds,outputRate:r.context?.sampleRate||48000});
 const report=(r,stats,contextTime)=>{if(!active(r))return;r.latest={...stats,contextTime};r.lastReportTime=r.context.currentTime;options.onPlayhead?.(api.getPlayhead(),api.stats());};
 const send=(r,packet)=>{
  if(!active(r)||!r.running)return false;
  if(r.mode==='worklet'){
   const frames=packet.samples.length/options.channels;
   if(r.inFlightFrames+frames>frameBound){notify(options,'The audio message buffer is full; this block was not accepted.');return false;}
   r.inFlightFrames+=frames;
   try{r.node.port.postMessage({type:'push',packet},packet.valid?[packet.samples.buffer,packet.valid.buffer]:[packet.samples.buffer]);return true;}
   catch(error){r.inFlightFrames-=frames;reportError(options,error);return false;}
  }
  const accepted=r.state.push(packet);if(!accepted)notify(options,'The audio buffer is full; this block was not accepted. Check synchronization.');return accepted;
 };
 const api={rate:options.rate,channels:options.channels,
  async start(){
   if(run?.running){await resumeContext(run,options);return api;}if(run?.promise)return run.promise;
   const r=operation();Object.assign(r,{inFlightFrames:0,latest:null,lastReportTime:0,state:null});run=r;
   r.promise=(async()=>{try{
    Object.assign(r,newContext(options));await resumeContext(r,options);requireActive(r);r.unwatch=watchCapture(r.context,null,()=>active(r)&&r.running,options);
    r.gain=r.context.createGain();r.gain.gain.value=duration(options.volume===undefined?.8:Number(options.volume),0,1,'Audio volume');r.gain.connect(r.context.destination);
    try{
     r.node=await workletNode(r.context,'analog-av-playback',options,stateOptions(r),{},r);requireActive(r);
     r.node.port.onmessage=e=>{
      if(!active(r))return;const m=e.data;
      if(m.type==='ack'){r.inFlightFrames=Math.max(0,r.inFlightFrames-m.frames);if(!m.accepted)notify(options,'The audio buffer is full; this block was not accepted. Check synchronization.');}
      else if(m.type==='playhead')report(r,m.stats,m.contextTime);
      else if(m.type==='error')reportError(options,Error(m.message));
     };r.mode='worklet';
    }catch(error){
     requireActive(r);if(typeof r.context.createScriptProcessor!=='function')throw Error('Audio playback could not start: '+error.message);
     r.state=new PlaybackState(stateOptions(r));r.node=r.context.createScriptProcessor(captureProcessorFrames(r.context.sampleRate),0,options.channels);
     r.node.onaudioprocess=e=>{
      if(!active(r)){silenceOutput(e.outputBuffer);return;}
      try{const channels=r.state.render(e.outputBuffer.length);for(let c=0;c<e.outputBuffer.numberOfChannels;c++)e.outputBuffer.getChannelData(c).set(channels[c]||channels[0]);report(r,r.state.stats(),(e.playbackTime||r.context.currentTime)+e.outputBuffer.length/r.context.sampleRate);}
      catch(error){silenceOutput(e.outputBuffer);reportError(options,error);}
     };r.mode='compatibility';notify(options,'AudioWorklet is unavailable: audible playback is active in compatibility mode ('+error.message+').');
    }
    requireActive(r);r.node.onprocessorerror=()=>{if(active(r))reportError(options,Error('The AudioWorklet processor stopped.'));};r.node.connect(r.gain);r.running=true;
    const packets=queued;queued=[];queuedFrames=0;for(const packet of packets)send(r,packet);return api;
   }catch(error){if(run===r)run=null;await cleanup(r);throw error;}finally{r.promise=null;}})();return r.promise;
  },
  push(packetOrTimestamp,samples){
   const packet=typeof packetOrTimestamp==='number'?{timestamp:packetOrTimestamp,samples}:packetOrTimestamp;duration(Number(packet.timestamp),0,Number.MAX_SAFE_INTEGER/options.rate,'Audio timestamp');
   const frames=validateSamples(packet.samples,options.channels);validateMask(packet.valid,frames);if(frames>frameBound)throw RangeError('Audio packet exceeds bounded playback queue');
   const copy={timestamp:Number(packet.timestamp),samples:packet.samples.slice()};if(packet.valid)copy.valid=packet.valid.slice();
   if(!run?.running){if(queuedFrames+frames>frameBound){notify(options,'The audio buffer is full before playback; this block was not accepted.');return false;}queued.push(copy);queuedFrames+=frames;return true;}
   return send(run,copy);
  },
  setVolume(volume){duration(volume,0,1,'Audio volume');if(run?.gain)run.gain.gain.value=volume;options.volume=volume;},
  getPlayhead(){
   const r=run;if(!r?.running||!r.latest?.started)return null;
   const outputLatency=(r.context.baseLatency||0)+(r.context.outputLatency||0),elapsed=clamp((r.context.currentTime-r.latest.contextTime)-outputLatency,-.5,.1);
   const playhead=r.latest.playhead+elapsed*(1+(r.latest.driftPpm||0)/1e6);return playhead<(r.latest.firstTimestamp||0)?null:playhead;
  },
  stats(){const r=run,stats=r?.mode==='compatibility'&&r.state?r.state.stats():r?.latest||{started:false,playhead:null,delaySeconds,rate:options.rate,channels:options.channels};return{...stats,running:!!r?.running,mode:r?.mode||null,queuedFrames,inFlightFrames:r?.inFlightFrames||0,lastReportTime:r?.lastReportTime||0,delaySeconds,maxBufferSeconds};},
  async stop(){const r=run;run=null;queued=[];queuedFrames=0;await cleanup(r);}
 };return api;
}
return Object.freeze({RATES,IndexedRing,StreamingResampler,PlaybackState,interleave,kernelFor,captureProcessorFrames,listInputs,createCapture,createPlayback});
});
