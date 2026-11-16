
/* Easy controls are projections of the application bridge. Refreshing this
 * view never acquires media, opens serial ports, or changes stream settings. */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;else root.CBAVEasy=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VIDEO_PRESETS=Object.freeze(['bw128','bw320','bw640','col256']);
 const AUDIO_PRESETS=Object.freeze(['8000:1','16000:1','24000:1','48000:1']);
 const finite=value=>typeof value==='number'&&Number.isFinite(value);
 function videoLabel(mode){
  if(!mode)return'No video';
  const found=/^(bw|col)(\d+)(stable)?$/.exec(String(mode));
  return found?found[2]+' × '+Number(found[2])*3/4+' '+(found[1]==='bw'?'B&W':'color')+(found[3]?' · Stable':''):String(mode);
 }
 function audioLabel(rate,channels){return Number(rate)>0?(Number(rate)/1000).toLocaleString('en-US',{maximumFractionDigits:1})+' kHz '+(Number(channels)===2?'stereo':'mono'):'Off';}
 function create({document:doc,bridge}={}){
  if(!doc||!bridge||typeof bridge.getState!=='function')throw TypeError('Easy controls require a document and application bridge.');
  const $=id=>{const element=doc.getElementById(id);if(!element)throw Error('Missing Easy control: '+id);return element;};
  const events=[],signatures={};let view='easy',destroyed=false,pending=null,action=0,error='',lastState=null;
  const text=(id,value)=>{const element=$(id),next=String(value??'');if(element.textContent!==next)element.textContent=next;};
  const hidden=(id,value)=>$(id).classList.toggle('hidden',!!value);
  const attribute=(id,name,value)=>{const element=$(id),next=String(value);if(element.getAttribute?.(name)!==next)element.setAttribute(name,next);};
  const on=(id,event,fn)=>{const element=$(id);element.addEventListener(event,fn);events.push({element,event,fn});};
  const viewLocked=()=>!!lastState?.busy||!!lastState?.connecting||!!lastState?.cleanupPending||pending!==null;
  function setView(next,focus=false){
   if(destroyed||viewLocked())return;view=next==='advanced'?'advanced':'easy';
   $('appRoot').classList.toggle('easy-view',view==='easy');$('appRoot').classList.toggle('advanced-view',view==='advanced');
   attribute('easyTabEasy','aria-selected',view==='easy');attribute('easyTabAdvanced','aria-selected',view==='advanced');
   attribute('easyTabEasy','tabindex',view==='easy'?0:-1);attribute('easyTabAdvanced','tabindex',view==='advanced'?0:-1);
   attribute('easyPanel','aria-hidden',view!=='easy');attribute('advancedPanel','aria-hidden',view!=='advanced');
   if(focus)$(view==='easy'?'easyTabEasy':'easyTabAdvanced').focus?.();
  }
  function fill(id,options){
   const signature=JSON.stringify(options);if(signatures[id]===signature)return;signatures[id]=signature;
   const element=$(id),previous=element.value;
   if(element.replaceChildren)element.replaceChildren();else if(Array.isArray(element.children))element.children.length=0;else while(element.firstChild)element.removeChild(element.firstChild);
   for(const option of options){const node=doc.createElement('option');node.value=option.value;node.textContent=option.label;element.appendChild(node);}
   element.value=options.some(option=>option.value===previous)?previous:options[0]?.value||'';
  }
  function customLabel(id,value){const option=Array.from($(id).options||[]).find(item=>item.value==='custom');if(option&&option.textContent!==value)option.textContent=value;}
  function state(){const snapshot=bridge.getState();if(!snapshot||typeof snapshot!=='object')throw Error('Application state is unavailable.');return snapshot;}
  function refresh(){
   if(destroyed)return;let s;
   try{s=state();lastState=s;}catch(failure){error=failure.message||String(failure);text('easyMessage',error);$('easyMessage').classList.add('error');return;}
   const role=s.role==='tx'?'tx':'rx',usage=['video','av','audio'].includes(s.usage)?s.usage:'video',tx=role==='tx',hasVideo=usage!=='audio',hasAudio=usage!=='video';
   const localBusy=pending==='start'||pending==='stop'||pending==='disconnect',busy=!!s.busy||!!s.connecting||localBusy,locked=busy||!!s.settingsLocked;
   $('easyTabEasy').disabled=viewLocked();$('easyTabAdvanced').disabled=viewLocked();
   $('appRoot').classList.toggle('easy-tx',tx);$('appRoot').classList.toggle('easy-rx',!tx);$('appRoot').classList.toggle('easy-audio',!hasVideo);$('appRoot').classList.toggle('easy-video',hasVideo);
   for(const [id,selected]of [['easyRoleTX',tx],['easyRoleRX',!tx]]){attribute(id,'aria-pressed',selected);$(id).disabled=busy||!!s.roleLocked;}
   for(const [id,value]of [['easyUsageAV','av'],['easyUsageVideo','video'],['easyUsageAudio','audio']]){attribute(id,'aria-pressed',usage===value);$(id).disabled=locked;}
   text('easyPortLabel',s.portLabel||(s.portSelected?'ESP selected':'No ESP selected'));
   text('easyConnection',s.cleanupPending?'Closing USB connection…':s.connecting?'Connecting…':s.connected?'USB connected':s.portSelected?'Selected · not connected':'Not connected');
   $('easyChooseESP').disabled=!!s.connected||busy||pending==='chooseESP'||s.canChooseESP===false;hidden('easyDisconnect',!s.connected);$('easyDisconnect').disabled=busy||!!s.cleanupPending;
   const canonicalFrequency=doc.getElementById('frequency'),hz=finite(s.frequencyHz)?s.frequencyHz:canonicalFrequency?Number(canonicalFrequency.value)*1e6:2442312500;
   text('easyChannel',hz===2442312500?'Default channel':'Custom frequency · Advanced');
   const devices=s.devices||{},cameras=Array.isArray(devices.cameras)?devices.cameras:[],microphones=Array.isArray(devices.microphones)?devices.microphones:[];
   fill('easyCamera',[{value:'pattern',label:'Test pattern · no camera needed'},{value:'camera:',label:'Default webcam'},...cameras.filter(device=>device&&typeof device.id==='string'&&device.id).map((device,index)=>({value:'camera:'+device.id,label:device.label||'Webcam '+(index+1)}))]);
   fill('easyMicrophone',[{value:'',label:'Default microphone'},...microphones.filter(device=>device&&typeof device.id==='string'&&device.id).map((device,index)=>({value:device.id,label:device.label||'Microphone '+(index+1)}))]);
   const cameraValue=s.videoSource==='camera'?'camera:'+(s.cameraDeviceId||''):'pattern';
   if(Array.from($('easyCamera').options||[]).some(option=>option.value===cameraValue))$('easyCamera').value=cameraValue;
   if(Array.from($('easyMicrophone').options||[]).some(option=>option.value===(s.micDeviceId||'')))$('easyMicrophone').value=s.micDeviceId||'';
   hidden('easySourceControls',!tx);hidden('easyCameraField',!hasVideo);hidden('easyMicrophoneField',!hasAudio);
   $('easyCamera').disabled=locked||!tx||!hasVideo;$('easyMicrophone').disabled=locked||!tx||!hasAudio;$('easyRefreshSources').disabled=busy;
   const micLevel=finite(s.micLevel)?Math.max(0,Math.min(1,s.micLevel)):0;$('easyMicMeter').value=micLevel;text('easyMicMeter',Math.round(micLevel*100)+'%');
   const mode=s.videoMode||'bw640',rate=Number(s.audioRate||16000),channels=Number(s.audioChannels||1),audioKey=rate+':'+channels;
   customLabel('easyVideoQuality',VIDEO_PRESETS.includes(mode)?'Custom · Advanced':'Custom · '+videoLabel(mode));
   customLabel('easyAudioQuality',AUDIO_PRESETS.includes(audioKey)?'Custom · Advanced':'Custom · '+audioLabel(rate,channels));
   $('easyVideoQuality').value=VIDEO_PRESETS.includes(mode)?mode:'custom';$('easyAudioQuality').value=AUDIO_PRESETS.includes(audioKey)?audioKey:'custom';
   hidden('easyQualityControls',!tx&&hasAudio);hidden('easyVideoQualityField',!hasVideo);hidden('easyAudioQualityField',!tx||!hasAudio);
   $('easyVideoQuality').disabled=locked||!hasVideo||(!tx&&hasAudio);$('easyAudioQuality').disabled=locked||!tx||!hasAudio;
   text('easyVideoQualityLabel',tx?'Video quality':'Video-only RX format · match transmitter');text('easyQualityTitle',tx?'STREAM QUALITY':'VIDEO-ONLY RECEPTION');
   const received=!tx&&hasAudio?s.rxPlan:null,plan=!tx&&hasAudio?received:s.plan;
   hidden('easyReceivedCard',tx||!hasAudio);
   const receivedText=received?(received.videoMode?videoLabel(received.videoMode)+' · ':'Audio only · ')+audioLabel(received.audioRate,received.audioChannels):'Waiting for signal';
   text('easyReceivedFormat',receivedText);
   text('easyFpsLabel',tx?'Predicted video':hasAudio?'Received video cadence':'Expected video cadence');
   const fps=plan?.videoFps;
   text('easyFps',!hasVideo||(received&&received.videoMode===null)?'No video':!tx&&hasAudio&&!received?'Waiting for signal':finite(fps)&&fps>0?fps.toFixed(3)+' FPS':'Waiting for settings');
   text('easyAudioSummary',!hasAudio?'Off':!tx&&!received?'Waiting for signal':audioLabel(plan?.audioRate||rate,plan?.audioChannels||channels)+' · continuous');
   let delay=plan?.syncDelayMs??plan?.displayDelayMs??plan?.audioDelayMs;
   if(!tx&&received&&!finite(delay)&&s.plan?.videoMode===received.videoMode&&s.plan?.audioRate===received.audioRate&&s.plan?.audioChannels===received.audioChannels)delay=s.plan.syncDelayMs;
   text('easyDelay',hasAudio&&finite(delay)?(delay/1000).toFixed(2)+' s':hasAudio&&!tx?'Waiting for signal':'—');
   text('easyCapacity','Fixed radio bandwidth: 120,000 samples/s.'+(finite(fps)&&fps>0&&fps<1?' One image every '+(1/fps).toFixed(2)+' s.':''));
   hidden('easyVolumeField',tx||!hasAudio);$('easyVolume').disabled=tx||!hasAudio;
   const volume=finite(s.volume)?Math.max(0,Math.min(1,s.volume)):.7;$('easyVolume').value=String(volume);text('easyVolumeOut',Math.round(volume*100)+'%');
   const mainActive=!!s.running||busy;hidden('easyStart',mainActive);hidden('easyStop',!mainActive);
   $('easyStart').disabled=busy||(tx&&s.plan?.admitted===false)||s.canStart===false;
   $('easyStop').disabled=pending==='stop'||pending==='disconnect';
   text('easyStart',tx?'Start broadcasting':s.connected&&hasAudio?'Listen to received audio':'Start receiving');text('easyStop',busy&&!s.running?'Cancel':tx?'Stop broadcasting':'Stop receiving');
   const rf=s.rfStatus,rfState=typeof rf==='object'&&rf?rf.state:typeof rf==='string'&&['Receiving · metadata verified','H + V locked'].includes(rf)?'locked':typeof rf==='string'?rf:'';
   const rfText=typeof rf==='object'&&rf?(rf.label||rf.message||rf.state||'Waiting for signal'):typeof rf==='string'&&rf?rf:'Waiting for signal';
   text('easyRFState',s.cleanupPending?'Closing serial port…':tx?(s.running?'Broadcasting':busy?'Starting transmission…':'Ready to transmit'):rfText);
   $('easyRFState').classList.toggle('is-locked',!s.cleanupPending&&!tx&&rfState==='locked');$('easyRFState').classList.toggle('is-error',!!s.error||rfState==='error');
   const failure=error||(typeof s.error==='string'?s.error:s.error?s.message||'The station reported an error.':'');
   const message=failure||(tx&&s.plan?.admitted===false?s.plan.reason||'These settings exceed the available bandwidth.':s.message||(!tx&&usage==='video'?'Select the video-only format used by the transmitter.':'Sources and permissions are checked when you start.'));
   text('easyMessage',message);$('easyMessage').classList.toggle('error',!!failure||(tx&&s.plan?.admitted===false));
   hidden('easyAudioPanel',hasVideo);text('easyAudioDetail',tx?'Selected audio: '+audioLabel(rate,channels)+'. No webcam is needed.':received?'Received audio: '+audioLabel(received.audioRate,received.audioChannels)+'.':'Waiting for an analog audio stream.');
   text('easyAudioSignal',tx?(s.running?'Broadcasting analog audio':busy?'Starting…':'Ready to broadcast'):rfText);
  }
  function configure(patch){
   if(destroyed)return;error='';try{bridge.setConfig(patch);}catch(failure){error=failure.message||String(failure);}refresh();
  }
  async function invoke(name){
   if(destroyed)return;const token=++action;pending=name;error='';refresh();
   try{if(typeof bridge[name]!=='function')throw Error('This station action is unavailable.');await bridge[name]();}
   catch(failure){if(!destroyed&&token===action)error=failure.message||String(failure);}
   finally{if(!destroyed&&token===action){pending=null;refresh();}}
  }
  on('easyTabEasy','click',()=>{if(!$('easyTabEasy').disabled)setView('easy');});on('easyTabAdvanced','click',()=>{if(!$('easyTabAdvanced').disabled)setView('advanced');});
  for(const id of ['easyTabEasy','easyTabAdvanced'])on(id,'keydown',event=>{if($(id).disabled||viewLocked())return;const key=event.key;if(['ArrowLeft','ArrowRight','Home','End'].includes(key)){event.preventDefault?.();setView(key==='Home'?'easy':key==='End'?'advanced':view==='easy'?'advanced':'easy',true);}});
  for(const [id,role]of [['easyRoleTX','tx'],['easyRoleRX','rx']])on(id,'click',()=>{if(!$(id).disabled)configure({role});});
  for(const [id,usage]of [['easyUsageAV','av'],['easyUsageVideo','video'],['easyUsageAudio','audio']])on(id,'click',()=>{if(!$(id).disabled)configure({usage});});
  on('easyCamera','change',()=>{if($('easyCamera').disabled)return;const value=$('easyCamera').value;if(value==='pattern')configure({videoSource:'pattern'});else if(value.startsWith('camera:'))configure({videoSource:'camera',cameraDeviceId:value.slice(7)});});
  on('easyMicrophone','change',()=>{if(!$('easyMicrophone').disabled)configure({micDeviceId:$('easyMicrophone').value});});
  on('easyVideoQuality','change',()=>{if($('easyVideoQuality').disabled)return;const value=$('easyVideoQuality').value;if(value==='custom')setView('advanced',true);else if(VIDEO_PRESETS.includes(value))configure({videoMode:value});});
  on('easyAudioQuality','change',()=>{if($('easyAudioQuality').disabled)return;const value=$('easyAudioQuality').value;if(value==='custom')setView('advanced',true);else if(AUDIO_PRESETS.includes(value)){const [audioRate,audioChannels]=value.split(':').map(Number);configure({audioRate,audioChannels});}});
  on('easyVolume','input',()=>{if(!$('easyVolume').disabled)configure({volume:Math.max(0,Math.min(1,Number($('easyVolume').value)||0))});});
  for(const [id,name]of [['easyChooseESP','chooseESP'],['easyDisconnect','disconnect'],['easyRefreshSources','refreshDevices'],['easyStart','start'],['easyStop','stop']])on(id,'click',()=>{if(!$(id).disabled)return invoke(name);});
  setView('easy');refresh();
  return Object.freeze({refresh,setView,getState:()=>({view,pending,error,snapshot:lastState}),
   destroy(){if(destroyed)return;destroyed=true;action++;for(const {element,event,fn}of events)element.removeEventListener?.(event,fn);}});
 }
 return Object.freeze({VIDEO_PRESETS,AUDIO_PRESETS,videoLabel,audioLabel,create});
});
