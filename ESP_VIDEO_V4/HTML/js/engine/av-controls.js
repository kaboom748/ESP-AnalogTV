
/* Analog A/V controls. This module never starts a microphone, camera or radio
 * without the corresponding user action. Capacity comes from the RF planner. */
(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.CBAVUI=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const AUDIO_RATES=Object.freeze([8000,12000,16000,24000,32000,44100,48000]);
 const finite=value=>typeof value==='number'&&Number.isFinite(value);
 function create({document:doc,hooks={},navigator:nav=globalThis.navigator}={}){
  if(!doc)throw Error('Document is required');
  const $=id=>{const el=doc.getElementById(id);if(!el)throw Error('Missing A/V control: '+id);return el;};
  const listeners=[],state={locked:false,receiving:false,micActive:false,micLevel:0,canListen:false,listening:false};
  let destroyed=false,refreshId=0,lastPlan=null;
  const listen=(id,event,fn)=>{const el=$(id);el.addEventListener(event,fn);listeners.push({el,event,fn});};
  const setText=(id,value)=>{const el=$(id),text=String(value??'');if(el.textContent!==text)el.textContent=text;};
  function readLevels(){return {
   micGain:Math.max(0,Math.min(4,Number($('avMicGain').value)||0)),muted:$('avMute').checked,
   volume:Math.max(0,Math.min(1,Number($('avVolume').value)||0))};}
  function getConfig(){
   const usage=$('avUsage').value,audioRate=Number($('avRate').value),audioChannels=Number($('avChannels').value);
   const fpsPolicy=$('avFpsPolicy').value,requestedMinFps=Number($('avMinFps').value);
   const validMinFps=Number.isFinite(requestedMinFps)&&requestedMinFps>0&&requestedMinFps<=120;
   if(!['video','av','audio'].includes(usage))throw RangeError('Unknown audio/video usage.');
   if(!AUDIO_RATES.includes(audioRate)||![1,2].includes(audioChannels))throw RangeError('Unsupported audio sample rate or channel count.');
   if(!['auto','floor'].includes(fpsPolicy)||(usage==='av'&&fpsPolicy==='floor'&&!validMinFps))throw RangeError('Minimum FPS must be greater than zero and no higher than 120.');
   return {usage,audioRate,audioChannels,fpsPolicy,minFps:validMinFps?requestedMinFps:1,
    cameraDeviceId:$('avCameraDevice').value,micDeviceId:$('avMicDevice').value,
    ...readLevels(),
    videoEnabled:usage!=='audio',audioEnabled:usage!=='video'};
  }
  function showMessage(text,error=false){
   setText('avMediaStatus',text||'');$('avMediaStatus').classList.toggle('error',!!error);
  }
  const slotText=value=>finite(value)?Math.round(value).toLocaleString('en-US'):'pending';
  function renderPlan(plan,config){
   lastPlan=plan||null;
   if(!config.videoEnabled)setText('avExpectedFps','No video · continuous audio');
   else{
    const fps=plan?.videoFps??plan?.expectedFps??plan?.fps??plan?.maxVideoFps;
    setText('avExpectedFps',finite(fps)&&fps>0
     ?fps.toFixed(3)+' FPS'+(fps<1?' · '+(1/fps).toFixed(2)+' s/frame':'')
     :'Calculating video frame rate…');
   }
   if(!plan){setText('avBudget','Waiting for the bandwidth calculation.');setText('avPlanStatus','');return;}
   const capacity=plan.radioRate??plan.rate??120000;
   const audio=plan.audioSlotsPerSecond??plan.audioSamplesPerSecond??(config.audioEnabled?config.audioRate*config.audioChannels:0);
   const video=plan.videoSlotsPerSecond??plan.videoSamplesPerSecond;
   const overhead=plan.overheadSlotsPerSecond??plan.overheadSamplesPerSecond;
   const spare=plan.spareSlotsPerSecond??plan.spareSamplesPerSecond??(finite(video)&&finite(overhead)?capacity-audio-video-overhead:undefined);
   setText('avBudget','Radio: '+slotText(capacity)+' slots/s · audio: '+slotText(audio)+
    ' · video: '+slotText(video)+' · markers/guards: '+slotText(overhead)+' · spare: '+slotText(spare)+'.');
   const allowed=(plan.admitted??plan.allowed??true)!==false;
   setText('avPlanStatus',allowed
    ?'This combination fits the calculated budget. Displayed FPS is predicted, not measured over the air.'
    :'Combination unavailable: '+(plan.reason||'the requested rate exceeds the available capacity.'));
   $('avPlanStatus').classList.toggle('error',!allowed);
   // Admission applies to a full selection, including the requested FPS.
   // Keep the selected value visible when it becomes impossible; explain it.
   if(hooks.getPlan)for(const [id,key] of [['avRate','audioRate'],['avChannels','audioChannels']]){
    for(const option of $(id).options||[]){
     try{option.disabled=config.usage==='av'&&config.fpsPolicy==='floor'&&hooks.getPlan({...config,[key]:Number(option.value)}).admitted===false;}
     catch(_){option.disabled=true;}
    }
   }
   const delay=plan.syncDelayMs??plan.audioDelayMs;
   if(!('syncState' in state))setText('avSyncState',!config.audioEnabled
    ?'Video only: original analog signal path.'
    :config.videoEnabled
     ?'Continuous audio synchronized with complete frames'+(finite(delay)?' · predicted delay: '+(delay/1000).toFixed(2)+' s.':' · delay pending.')
     :'Audio only: continuous playback without waiting for a video frame.');
  }
  function update(next={}){
   if(destroyed)return;
   Object.assign(state,next);let config;
   const levels=readLevels();
   setText('avMicGainOut',levels.micGain.toFixed(2)+'×');setText('avVolumeOut',Math.round(levels.volume*100)+'%');
   try{config=getConfig();}catch(error){showMessage(error.message,true);return;}
   const hasAudio=config.audioEnabled,hasVideo=config.videoEnabled;
   for(const id of ['avUsage','avRate','avChannels','avFpsPolicy','avMinFps','avCameraDevice','avMicDevice'])$(id).disabled=!!state.locked;
   for(const id of ['avRate','avChannels','avMicDevice'])$(id).disabled=!!state.locked||!hasAudio;
   $('avCameraDevice').disabled=!!state.locked||!hasVideo;
   $('avFpsPolicy').disabled=!!state.locked||!hasVideo||!hasAudio;
   $('avMinFps').disabled=!!state.locked||!hasVideo||!hasAudio||config.fpsPolicy!=='floor';
   $('avMicEnable').disabled=!!state.locked||!hasAudio||!!state.micActive;
   $('avMicStop').disabled=!!state.locked||!state.micActive;
   $('avMicGain').disabled=!hasAudio;$('avMute').disabled=!hasAudio;
   $('avListen').disabled=!state.canListen||!!state.listening;
   $('avPause').disabled=!state.listening;
   $('avAudioSettings').classList.toggle('hidden',!hasAudio);
   $('avAudioPlayback').classList.toggle('hidden',!hasAudio&&!state.receiving);
   const level=finite(state.micLevel)?Math.max(0,Math.min(1,state.micLevel)):0;
   $('avMicMeter').value=level;setText('avMicMeter',Math.round(level*100)+'%');
   if('plan' in next)renderPlan(next.plan,config);
   else if(hooks.getPlan){try{renderPlan(hooks.getPlan(config),config);}catch(error){renderPlan(null,config);showMessage(error.message,true);}}
   else renderPlan(lastPlan,config);
   for(const [key,id]of [['syncState','avSyncState'],['audioStats','avAudioStats'],['rxConfig','avRxConfig']])if(key in next)setText(id,next[key]);
   if('message' in next)showMessage(next.message,next.error);
  }
  async function call(name,...args){
   try{const result=await hooks[name]?.(...args);if(!destroyed)update();return result;}
   catch(error){if(!destroyed)showMessage(error.message||String(error),true);return undefined;}
  }
  function changed(){
   if(state.locked)return;
   try{const config=getConfig();update();void call('onChange',config);}
   catch(error){showMessage(error.message,true);}
  }
  for(const id of ['avUsage','avRate','avChannels','avFpsPolicy','avMinFps','avCameraDevice','avMicDevice'])listen(id,'change',changed);
  listen('avCameraDevice','change',()=>{if(!state.locked)void call('onCameraChange',$('avCameraDevice').value);});
  for(const id of ['avMicGain','avMute'])listen(id,id==='avMute'?'change':'input',()=>{const levels=readLevels();update();void call('onGain',levels);});
  listen('avVolume','input',()=>{const levels=readLevels();update();void call('onVolume',levels.volume);});
  listen('avMicEnable','click',()=>{if(state.locked)return;try{const config=getConfig();if(config.audioEnabled)void call('enableMic',config);}catch(error){showMessage(error.message,true);}});
  listen('avMicStop','click',()=>{if(!state.locked&&state.micActive)void call('stopMic');});
  listen('avListen','click',()=>{if(state.canListen&&!state.listening)void call('listen');});
  listen('avPause','click',()=>{if(state.listening)void call('pause');});
  listen('avRefreshDevices','click',()=>void refreshDevices());
  function fillDevices(id,devices,kind,label){
   const el=$(id),previous=el.value;
   if(el.replaceChildren)el.replaceChildren();
   else if(Array.isArray(el.children))el.children.length=0;
   else while(el.firstChild)el.removeChild(el.firstChild);
   const append=(value,text)=>{const option=doc.createElement('option');option.value=value;option.textContent=text;el.appendChild(option);};
   append('',label+' (default)');
   let index=0;for(const device of devices)if(device.kind===kind){index++;append(device.deviceId,device.label||label+' '+index+' · name available after permission');}
   const exists=!previous||devices.some(device=>device.kind===kind&&device.deviceId===previous);
   el.value=exists?previous:'';
   if(!exists){showMessage(label+' selection disconnected; check the source before the next transmission.',true);void call('onDeviceLost',{kind,deviceId:previous});}
  }
  async function refreshDevices(){
   const request=++refreshId;
   try{
    if(!nav?.mediaDevices?.enumerateDevices){showMessage('Device list unavailable. Open this page on localhost in Chrome or Edge.',true);return [];}
    const devices=await nav.mediaDevices.enumerateDevices();if(destroyed||request!==refreshId)return [];
    fillDevices('avCameraDevice',devices,'videoinput','Webcam');fillDevices('avMicDevice',devices,'audioinput','Microphone');
    update();void call('onDevicesChanged',devices);return devices;
   }catch(error){if(!destroyed)showMessage('Devices: '+(error.message||error),true);return [];}
  }
  const deviceChange=()=>void refreshDevices();nav?.mediaDevices?.addEventListener?.('devicechange',deviceChange);
  update();
  return Object.freeze({getConfig,update,refreshDevices,
   getState:()=>({...state,plan:lastPlan}),
   destroy(){destroyed=true;refreshId++;for(const {el,event,fn}of listeners)el.removeEventListener?.(event,fn);nav?.mediaDevices?.removeEventListener?.('devicechange',deviceChange);}});
 }
 return Object.freeze({AUDIO_RATES,create});
});
