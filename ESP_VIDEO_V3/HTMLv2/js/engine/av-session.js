
/* Browser application coordinator. RF payloads remain analog amplitudes.
 * No serial access: the existing application owns the 1.5 Mbaud connection.
 */
(function(root,factory){
 const api=factory(root);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.CBAVSession=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const now=()=>root.performance?.now?.()??Date.now();
 const sleep=ms=>new Promise(resolve=>root.setTimeout(resolve,ms));
 class Session{
  constructor(options){
   this.o=options;this.C=options.C;this.AV=options.transport||root.CBAnalogAV;
   this.Audio=options.audio||root.CBAnalogAudio;this.capture=null;this.playback=null;
   this.tx=null;this.rx=null;this.rxPlan=null;this.rxConfigKey='';this.rxSessionId=null;this.lastAudioPTS=null;this.pictures=[];
   this.audioEnabled=false;this.wantAudio=false;this.message='';this.syncState='Video only: standard analog reception.';
   this.txFault=null;this.generation=0;this.micRequest=0;this.txGeneration=0;this.pendingCapture=null;this.destroyed=false;this.framePTS=null;this.lastAudioAt=0;this.rxHeaderState='searching';
   this.pacing=[];
   this.ui=(options.ui||root.CBAVUI).create({document:options.document||root.document,navigator:options.navigator||root.navigator,hooks:{
    getPlan:config=>this.getPlan(config),onChange:()=>this.changed(),
    enableMic:()=>this.enableMicrophone(),stopMic:()=>this.stopMicrophone(),
    listen:()=>this.listen(),pause:()=>this.pause(),
    onGain:config=>this.setGain(config),onVolume:value=>this.playback?.setVolume?.(value),
    onCameraChange:()=>options.onCameraChange?.(),
    onDeviceLost:device=>{if(device.kind==='audioinput')void this.stopMicrophone().catch(error=>this.fail(error));this.fail(Error('Device disconnected. Check the source before resuming.'));}
   }});
   this.timer=root.setInterval(()=>{this.checkPacing();this.present();this.update();},30);
  }
  config(){
   try{const config=this.ui.getConfig();this.lastConfig=config;this.configError=null;return config;}
   catch(error){this.configError=error;if(this.lastConfig)return this.lastConfig;throw error;}
  }
  isMixed(){return this.config().usage!=='video';}
  transportConfig(config=this.config()){
   return {videoMode:config.usage==='audio'?null:this.o.getVideoMode(),audioRate:Number(config.audioRate),audioChannels:Number(config.audioChannels)};
  }
  getPlan(config){
   if(config===undefined)config=this.config();else this.configError=null;
   if(this.configError)return {admitted:false,reason:this.configError.message,videoFps:0};
   const videoMode=this.o.getVideoMode(),S=this.C.plan(videoMode).fieldSamples;
   if(config.usage==='video')return {admitted:true,legacy:true,videoMode,videoFps:this.C.FS/S,
    videoSlotsPerSecond:this.C.FS,audioSlotsPerSecond:0,overheadSlotsPerSecond:0,spareSlotsPerSecond:0,syncDelayMs:0};
   try{
    const p=this.AV.plan(this.C,this.transportConfig(config)),floor=Number(config.minFps),fps=p.videoFps||0;
    const admitted=config.usage==='audio'||config.fpsPolicy!=='floor'||(Number.isFinite(floor)&&floor>0&&fps+1e-10>=floor);
    const reason=admitted?'':`Insufficient bandwidth: this audio allows at most ${fps.toFixed(3)} FPS.`;
    return {...p,admitted,reason,videoSlotsPerSecond:p.videoSamplesPerBlock*1000/p.blockMs,
     audioSlotsPerSecond:p.audioSamplesPerBlock*1000/p.blockMs,
     overheadSlotsPerSecond:(p.headerSamples+(p.guardSamples||0))*1000/p.blockMs,
     spareSlotsPerSecond:p.audioOnly?p.videoSamplesPerBlock*1000/p.blockMs:0,
     syncDelayMs:Math.round(((p.videoFrameSeconds||0)+.24)*1000)};
   }catch(error){return {admitted:false,reason:error.message,videoFps:0};}
  }
  ready(){const config=this.config();return this.getPlan().admitted&&(config.usage==='video'||!!this.capture&&!this.captureFault&&this.capture.rate===Number(config.audioRate)&&this.capture.channels===Number(config.audioChannels)&&this.captureKey===[config.audioRate,config.audioChannels,config.micDeviceId].join(':'));}
  fail(error){this.message=error?.message||String(error);this.o.onError?.(error instanceof Error?error:Error(this.message));this.update();}
  changed(){
   if(this.tx||this.destroyed)return;
   const config=this.config();
   if((this.capture||this.pendingCapture)&&(config.usage==='video'||(this.captureKey||this.pendingCaptureKey)!==[config.audioRate,config.audioChannels,config.micDeviceId].join(':')))void this.stopMicrophone().catch(error=>this.fail(error));
   this.resetReceive();this.message='';this.o.onChange?.();this.update();
  }
  captureFrames(){return this.capture?.availableFrames??0;}
  setGain(config=this.config()){
   if(this.capture?.setGain)this.capture.setGain(config.muted?0:Number(config.micGain));
  }
  async enableMicrophone(){
   if(this.destroyed)throw Error('This audio/video session has been closed.');
   if(this.tx)throw Error('Stop TX before changing the microphone.');
   const config=this.config(),request=++this.micRequest;await this.stopMicrophone({keepEnableRequest:true});
   if(this.destroyed||request!==this.micRequest)return;
   const selected=this.config();if([config.usage,config.audioRate,config.audioChannels,config.micDeviceId].join(':')!==[selected.usage,selected.audioRate,selected.audioChannels,selected.micDeviceId].join(':'))return;
   const token=++this.generation;
   this.audioWarning='';
   const capture=this.Audio.createCapture({rate:Number(config.audioRate),channels:Number(config.audioChannels),
    deviceId:config.micDeviceId,workletUrl:'./AUDIO/analog-audio-worklet.js',
    onWarning:message=>{if(token!==this.generation)return;this.audioWarning=message;this.message=message;this.update();},
    onSamples:()=>{if(token===this.generation)this.wakePacing();},
    onError:error=>{if(token!==this.generation)return;this.captureFault=error;this.txFault=error;this.cancelPacing(error);this.fail(error);}});
   this.pendingCapture=capture;this.pendingCaptureKey=[config.audioRate,config.audioChannels,config.micDeviceId].join(':');
   try{
    await capture.start();
    if(token!==this.generation){await capture.stop();return;}
    this.pendingCapture=null;this.pendingCaptureKey='';
    this.capture=capture;this.captureFault=this.txFault=null;this.captureKey=[config.audioRate,config.audioChannels,config.micDeviceId].join(':');
    this.setGain(config);this.message='Microphone active.'+(this.audioWarning?' '+this.audioWarning:'');
    await this.ui.refreshDevices();this.o.onChange?.();this.update();
   }catch(error){await capture.stop();if(this.pendingCapture===capture){this.pendingCapture=null;this.pendingCaptureKey='';}if(token!==this.generation)return;if(this.capture===capture){this.capture=null;this.captureKey='';this.captureFault=error;}this.fail(error);throw error;}
  }
  async stopMicrophone({keepEnableRequest=false}={}){
   if(!keepEnableRequest)this.micRequest++;
   this.generation++;this.txGeneration++;this.cancelPacing();
   const captures=[...new Set([this.capture,this.pendingCapture].filter(Boolean))],transmitting=!!this.tx||!!this.o.isTransmitLocked?.();
   this.capture=this.pendingCapture=null;this.captureKey=this.pendingCaptureKey='';this.captureFault=null;
   let failure=null;
   try{if(transmitting)await this.o.stopTransmit?.();}catch(error){failure=error;}
   finally{
    if(transmitting)this.endTransmit();
    const results=await Promise.allSettled(captures.map(capture=>Promise.resolve().then(()=>capture.stop())));
    for(const result of results)if(result.status==='rejected'&&!failure)failure=result.reason;
    if(!this.destroyed)this.o.onChange?.();this.update();
   }
   if(failure)throw failure;
  }
  async beginTransmit({isCurrent=()=>true}={}){
   if(this.destroyed)throw Error('This audio/video session has been closed.');
   const config=this.config(),plan=this.getPlan(config);
   if(!plan.admitted)throw Error(plan.reason);
   if(config.usage==='video'){this.tx=null;return;}
   if(!this.capture)throw Error('Enable the microphone before starting TX.');
   if(this.captureFault)throw Error('The microphone was interrupted. Enable it again before TX.');
   if(this.capture.rate!==Number(config.audioRate)||this.capture.channels!==Number(config.audioChannels))
    throw Error('Enable the microphone again to apply the new sample rate or channel count.');
   if(this.captureKey!==[config.audioRate,config.audioChannels,config.micDeviceId].join(':'))throw Error('The selected microphone changed. Enable it again before TX.');
   const capture=this.capture,token=++this.txGeneration;
   const current=()=>!this.destroyed&&token===this.txGeneration&&this.capture===capture&&isCurrent();
   this.pause(); // One ESP is half duplex: reception stops while it transmits.
   this.txFault=null;this.pictures=[];
   const minimum=Math.ceil(Number(config.audioRate)*.18),deadline=now()+5000;
   while(this.captureFrames()<minimum){
    if(!current())return;
    if(now()>deadline)throw Error('The microphone is not providing the expected audio samples.');
    if(this.txFault)throw this.txFault;
    await sleep(15);
   }
   if(!current())return;
   const start=Math.max(0,this.captureFrames()-minimum);
   this.tx=new this.AV.Muxer(this.C,this.transportConfig(config),{
    audioStartFrame:start,
    readAudio:(at,count)=>{
     if(!current())throw Error('The audio transmission was cancelled.');
     if(this.txFault)throw this.txFault;
     if(at+count>this.captureFrames())throw Error('Audio capture fell behind. Transmission stopped to avoid a false continuous stream.');
     const block=capture.readBlock(at,count);
     if(block.missingFrames)throw Error('Microphone samples are missing. Transmission stopped.');
     return block.samples;
    },
    getVideoFrame:meta=>{
     const result=this.o.getVideoFrame(meta);
     return {pcm:result.pcm||result,timestamp:this.captureFrames()/Number(config.audioRate)};
    }
   });
   this.txPending=null;this.txPendingOffset=0;
   this.message=`Continuous analog audio · expected video ${plan.videoFps.toFixed(3)} FPS.`;this.update();
  }
  getPcm(count){
   if(!this.tx)throw Error('Audio multiplexing has not started.');
   const out=new Uint8Array(count);let at=0;
   while(at<count){
    if(!this.txPending||this.txPendingOffset===this.txPending.length){this.txPending=this.tx.nextBlock();this.txPendingOffset=0;}
    const n=Math.min(count-at,this.txPending.length-this.txPendingOffset);
    out.set(this.txPending.subarray(this.txPendingOffset,this.txPendingOffset+n),at);at+=n;this.txPendingOffset+=n;
   }
   return out;
  }
  paceUntil(time){
   if(!this.tx||now()>=time)return Promise.resolve();
   return new Promise((resolve,reject)=>this.pacing.push({time,resolve,reject}));
  }
  wakePacing(){
   const waiting=[];
   for(const item of this.pacing){if(now()>=item.time)item.resolve();else waiting.push(item);}
   this.pacing=waiting;
  }
  checkPacing(){
   if(!this.tx||!this.pacing.some(item=>now()>item.time+1000))return;
   const error=Error('Microphone capture stalled. Transmission stopped; enable the microphone again.');
   this.captureFault=this.txFault=error;this.cancelPacing(error);this.fail(error);
  }
  cancelPacing(error){for(const item of this.pacing)error?item.reject(error):item.resolve();this.pacing=[];}
  endTransmit(){this.txGeneration++;this.cancelPacing();this.tx=null;this.txPending=null;this.txPendingOffset=0;this.update();}
  resetReceive(){
   this.rx?.reset();this.rx=null;this.rxPlan=null;this.rxConfigKey='';this.rxSessionId=null;this.lastAudioPTS=null;this.pictures=[];this.framePTS=null;
   this.pause();this.lastAudioAt=0;
  }
  ensureReceiver(){
   if(this.rx)return;
   this.rx=new this.AV.Demuxer(this.C,{
    onAudio:packet=>{
     if(this.lastAudioPTS!==null&&packet.timestamp<this.lastAudioPTS-.001)this.rxConfigKey='';
     this.acceptConfig(packet.discontinuity?{...packet,sessionChanged:true}:packet);this.lastAudioAt=now();
     this.lastAudioPTS=packet.timestamp;
     if(packet.samples.length)this.playback?.push({timestamp:packet.timestamp,samples:packet.samples,valid:packet.valid});
    },
    onVideo:(pcm,meta)=>{
     this.acceptConfig(meta);
     if(meta.frameStart||meta.headerValid)this.framePTS=meta.timestamp;
     this.o.onVideoBytes(pcm,meta);
    },
    onStatus:state=>{
     this.rxHeaderState=state.state;
     if(state.plan)this.acceptConfig(state);
     if(state.state==='error')this.fail(Error(state.reason||'Audio/video reception error.'));
     else this.syncState=state.state==='holdover'?'Damaged marker: clock maintained, analog audio continues.':
      state.state==='locked'?'Multiplexing locked.':'Searching for audio/video markers.';
     this.update();
    }
   });
  }
  acceptConfig(packet){
   const p=packet.plan;if(!p)return;
   const key=[p.videoMode,p.audioRate,p.audioChannels].join(':');
   const epochChanged=this.rxSessionId!==null&&(packet.sessionChanged===true||packet.sessionId!==undefined&&packet.sessionId!==this.rxSessionId);
   if(packet.sessionId!==undefined)this.rxSessionId=packet.sessionId;
   if(key===this.rxConfigKey&&!epochChanged)return;
   const listening=this.wantAudio;
   this.rxPlan=p;this.rxConfigKey=key;this.pictures=[];this.framePTS=null;
   if(epochChanged)this.lastAudioPTS=null;
   this.o.onReceiveConfig?.(p);
   if(this.playback&&(this.playbackKey!==key||epochChanged||this.lastAudioPTS!==null)){
    this.pause();
    if(listening)void this.listen().catch(error=>this.fail(error));
   }
  }
  feedBytes(pcm){this.ensureReceiver();this.rx.feedBytes(pcm);}
  feedMissing(count){this.ensureReceiver();this.rx.feedMissing(count);}
  discontinuity(){this.resetReceive();this.syncState='Serial timeline interrupted: searching for markers.';this.update();}
  async listen({plan:receiverPlan}={}){
   if(this.destroyed)throw Error('This audio/video session has been closed.');
   if(this.o.isTransmitLocked?.())throw Error('Stop TX before listening. One ESP cannot transmit and receive at the same time.');
   const p=receiverPlan||this.rxPlan||this.getPlan();
   if(p.legacy)throw Error('Select Audio only or Audio + video to listen to the receiver.');
   if(!p.audioRate||!p.audioChannels)throw Error(p.reason||'Select a valid audio format before listening.');
   this.pause();
   this.wantAudio=true;
   this.audioWarning='';
   let playback;
   try{playback=this.Audio.createPlayback({rate:p.audioRate,channels:p.audioChannels,
    delaySeconds:(p.videoFrameSeconds||0)+.24,workletUrl:'./AUDIO/analog-audio-worklet.js',
    onPlayhead:()=>{if(this.playback===playback)this.present();},onWarning:message=>{if(this.playback!==playback)return;this.audioWarning=message;this.message=message;this.update();},
    onError:error=>{if(this.playback!==playback)return;this.pause();this.fail(error);}});}
   catch(error){this.wantAudio=false;this.fail(error);throw error;}
   this.playback=playback;
   this.playbackKey=[p.videoMode,p.audioRate,p.audioChannels].join(':');
   this.update();
   try{await playback.start();if(this.playback!==playback){await playback.stop();return;}playback.setVolume?.(Number(this.config().volume));this.audioEnabled=true;
    this.message='Playback armed: filling the synchronization buffer.'+(this.audioWarning?' '+this.audioWarning:'');this.update();
   }catch(error){if(this.playback!==playback){await playback.stop();return;}this.playback=null;this.wantAudio=false;await playback.stop();this.fail(error);throw error;}
  }
  pause(){
   const playback=this.playback;this.playback=null;this.audioEnabled=false;this.wantAudio=false;this.pictures=[];
   return playback?Promise.resolve().then(()=>playback.stop()).catch(error=>this.fail(error)):Promise.resolve();
  }
  queuePicture(rgba,info){
   const picture={rgba:Uint8ClampedArray.from(rgba),info:{...info,sourceTimestamp:this.framePTS},timestamp:this.framePTS};
   if(!this.playback||!Number.isFinite(picture.timestamp)){this.o.presentVideo(picture.rgba,picture.info);return;}
   this.pictures.push(picture);
   // At most a few frame periods can await the synchronized playhead.
   const period=this.rxPlan?.videoFrameSeconds||this.getPlan().videoFrameSeconds||.04;
   const limit=Math.max(2,Math.min(256,Math.floor(32*1048576/rgba.byteLength),Math.ceil((period+.24+.25)/period)+3));
   if(this.pictures.length>limit){this.pictures.shift();this.message='Display fell behind: an outdated frame was discarded.';}
   this.present();
  }
  present(){
   if(!this.playback)return;
   const time=this.playback.getPlayhead();
   if(!Number.isFinite(time))return;
   let picture=null;
   while(this.pictures.length&&this.pictures[0].timestamp<=time+.012)picture=this.pictures.shift();
   if(picture)this.o.presentVideo(picture.rgba,picture.info);
  }
  update(){
   if(!this.ui||this.destroyed)return;
   const p=this.getPlan(),s=this.capture?.stats?.()||{},r=this.playback?.stats?.()||{};
   const locked=!!this.o.isTransmitLocked?.(),mixed=this.isMixed(),rf=this.rx?.counters||{},rfState=this.rx?.state||this.rxHeaderState;
   const recent=this.lastAudioAt>0&&now()-this.lastAudioAt<=Math.max(300,(this.rxPlan?.blockMs||40)*6);
   let reception;
   if(!mixed)reception='Video only: standard analog reception.';
   else if(locked)reception='RF A/V receiver inactive while transmitting.';
   else if(!this.rx||!this.lastAudioAt)reception='Searching for RF audio/video metadata.';
   else if(!recent)reception='No recent RF audio/video blocks; waiting for the signal.';
   else if(rfState==='locked')reception='RF A/V locked: metadata CRC validated.';
   else if(rfState==='holdover')reception='RF A/V holdover: metadata unverified; received audio/video continues on the held clock.';
   else if(rfState==='error')reception='RF A/V error: check the reception diagnostics.';
   else reception='Searching for RF audio/video metadata.';
   const playback=this.playback?(r.started?'Audio playback running':'Playback armed; filling the audio buffer'):'Audio playback paused';
   const delay=((this.rxPlan?.videoFrameSeconds||p.videoFrameSeconds||0)+.24).toFixed(2);
   const syncState=mixed?reception+' · '+playback+(this.playback?' · target delay '+delay+' s.':'.'):reception;
   const count=name=>(rf[name]||0).toLocaleString('en-US');
   const restoration=this.rx?.lastRestoration,dcCounters=this.rx?.dcRestoration?.counters;
   const dcState=restoration?.active?(restoration.holdover?'active on the held RF clock':'active; firmware DC response detected'):
    this.rx?'bypass; flat channel or gathering evidence':'waiting for RF';
   const dcTargets=restoration?.active&&this.rxPlan?.videoMode?(restoration.audioOnly?' · audio restored from control references; video path preserved':restoration.videoApplied?' · audio and long-line video restored':' · audio restored; short-line video clamp unchanged'):'';
   const rfStats=mixed?'RF metadata counters (separate from USB serial CRC): '+count('validHeaders')+' valid · '+
    count('headerCrcErrors')+' CRC failures · '+count('headerRejected')+' rejected · '+count('holdoverBlocks')+' holdover blocks · '+
    count('resyncs')+' resyncs · '+count('phaseCorrections')+' phase corrections · '+count('globalResyncs')+' wide reacquisitions · '+
    count('clockRebases')+' clock reanchors · '+count('clockRecoveredHeaders')+' clock-recovered headers · '+
    count('clockResampledBlocks')+' resampled blocks · '+count('callbackErrors')+' decoder callback errors. '+
    'DC restoration: '+dcState+dcTargets+' · '+(dcCounters?.activeBlocks||0).toLocaleString('en-US')+' corrected blocks.':
    'RF A/V metadata counters inactive in video-only mode. USB serial CRC counters remain below.';
   const rfElement=(this.o.document||root.document)?.getElementById?.('avRFStats');
   if(rfElement&&rfElement.textContent!==rfStats)rfElement.textContent=rfStats;
   this.ui.update({locked,receiving:!!this.o.isReceiving?.(),micActive:!!this.capture&&!this.captureFault,
    micLevel:s.level||0,canListen:mixed&&!locked,listening:!!this.playback,plan:p,
    syncState,
    audioStats:`Capture: ${s.contextSampleRate||'?'} Hz actual → ${this.capture?.rate||p.audioRate||0} Hz transmitted · ${this.capture?.channels===2&&s.reportedChannels===1?'mono source duplicated · ':''}${this.captureFrames()} samples/channel · output: ${r.outputRate||r.rate||'?'} Hz · playback gaps: ${r.underrunFrames||0}.`,
    rxConfig:this.rxPlan?`${this.rxPlan.videoMode||'Audio only'} · ${this.rxPlan.audioRate} Hz · ${this.rxPlan.audioChannels} channel(s)`:'Waiting for the received format.',
    message:this.message,error:!!this.txFault});
  }
  state(){return {config:this.config(),plan:this.getPlan(),capture:!!this.capture,transmitting:!!this.tx,
   receiving:!!this.rx,rxPlan:this.rxPlan,playback:!!this.playback,playhead:this.playback?.getPlayhead()??null,queuedPictures:this.pictures.length};}
  async destroy(){
   if(this.destroyPromise)return this.destroyPromise;
   this.destroyed=true;root.clearInterval(this.timer);
   this.destroyPromise=(async()=>{try{await this.stopMicrophone();}finally{this.endTransmit();await this.pause();this.rx?.reset();this.rx=null;this.ui.destroy();}})();
   return this.destroyPromise;
  }
 }
 return Object.freeze({Session,create:options=>new Session(options)});
});
