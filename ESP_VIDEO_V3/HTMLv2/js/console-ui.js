/* Presentation adapter only. Original controls keep their listeners and IDs.
 * DSP, radio commands, framing, media lifecycles and timing live in engine/.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const text = (id, value) => { const el = $(id); if (el && el.textContent !== String(value)) el.textContent = String(value); };
  const dialog = $('menuDialog');
  const titles = { audio: 'AUDIO', video: 'VIDEO', quality: 'QUALITY', radio: 'RADIO · CHANNEL / TX POWER', port: 'PORT · WEB SERIAL', advanced: 'ADVANCED' };
  const moved = new Set();
  const place = (id, destination, wrapper) => {
    const el = $(id); if (!el) throw Error('Missing control: ' + id);
    const node = wrapper ? el.closest(wrapper) : el;
    if (!node) throw Error('Missing control group: ' + id);
    if (!moved.has(node)) { $(destination).append(node); moved.add(node); }
    return node;
  };
  const field = (id, slot) => place(id, slot, '.field');
  const slider = (id, slot) => place(id, slot, '.sliderField');
  const label = (id, value) => { const el = document.querySelector('label[for="' + id + '"]'); if (el) { const out = el.querySelector('output'); el.replaceChildren(document.createTextNode(value + ' ')); if (out) el.append(out); } };
  const button = (id, value) => text(id, value);
  const dispatch = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  try {
    if (!globalThis.CBAVEasy || !$('mode').options.length) throw Error('The audio/video engine could not start. Check that all package files are present.');

    // Reparent the actual existing controls. No copied state or rewritten radio actions.
    field('avMicDevice', 'audioSourceSlot');
    place('avRefreshDevices', 'audioSourceSlot');
    place('avMicEnable', 'audioSourceSlot', '.row');
    slider('avMicGain', 'audioLevelSlot');
    place('avMute', 'audioLevelSlot', 'label');
    place('avMicMeter', 'audioLevelSlot');
    slider('avVolume', 'audioPlaybackSlot');
    place('avListen', 'audioPlaybackSlot', '.row');
    for (const id of ['avRxConfig', 'avAudioStats', 'avMediaStatus']) place(id, 'audioStatusSlot');

    place('easyCameraField', 'videoSourceSlot');
    // This canonical device picker is retained as a detailed source control.
    field('avCameraDevice', 'videoSourceSlot');
    place('camera', 'videoSourceSlot', '.row');
    slider('contrast', 'videoContrastSlot');
    for (const id of ['maxInfo', 'maxTxTransport', 'maxPrepState', 'maxSourceInfo']) place(id, 'videoInfoSlot');

    for (const id of ['mode', 'grayLevels']) field(id, 'qualityVideoSlot');
    for (const id of ['avRate', 'avChannels']) field(id, 'qualityAudioSlot');
    for (const id of ['avFpsPolicy', 'avMinFps']) field(id, 'qualityFpsSlot');
    place('avExpectedFps', 'qualityPlanSlot', '.avPlan');
    for (const id of ['frequency', 'fine', 'apwr']) field(id, 'radioFieldsSlot');
    $('apwr').closest('.field').dataset.stationRole = 'tx';
    place('status', 'radioStatusSlot');

    place('easyChooseESP', 'portChooseSlot', '.easyPortRow');
    place('easyDisconnect', 'portChooseSlot');
    place('connect', 'portManualSlot'); place('disconnect', 'portManualSlot');
    place('easyMessage', 'portStatusSlot');

    for (const id of ['rxBrightness', 'rxContrast', 'saturation']) slider(id, 'advancedImageSlot');
    place('autoLevel', 'advancedImageSlot', 'label'); place('markerLevels', 'advancedImageSlot');
    for (const id of ['hPosition', 'hHold', 'vHold', 'hLock']) slider(id, 'advancedSyncSlot');
    place('auto320', 'advancedSyncSlot', 'label'); place('resetHold', 'advancedSyncSlot');
    place('lockStatus', 'advancedSyncSlot', '.rateStrip');
    place('rxLossStatus', 'advancedDiagnosticsSlot', '.rxLossLegend');
    place('txRate', 'advancedDiagnosticsSlot', '.metrics');
    place('lineHz', 'advancedDiagnosticsSlot', '.rateStrip');
    place('avRFStats', 'advancedDiagnosticsSlot');
    for (const id of ['selfTest', 'saveRxCapture', 'selfTestResult']) place(id, 'advancedDiagnosticsSlot');
    place('log', 'advancedJournalSlot');
    // The original explanatory details stays available in Journal as well.
    const originalHelp = $('appRoot').querySelector('.under details');
    if (originalHelp) $('advancedJournalSlot').append(originalHelp);
    place('maxPanel', 'advancedJournalSlot');

    place('received', 'mainMonitor', '.screen');
    place('preview', 'inactiveScreens', '.screen');
    $('preview').setAttribute('aria-label', 'Transmitted video');
    $('received').setAttribute('aria-label', 'Received video');
    $('appRoot').hidden = true;
    // Labels are presentation only. Preserve output elements and every ID.
    const labels = {
      avMicDevice: 'Microphone / audio input', avCameraDevice: 'Selected webcam', easyCamera: 'Transmit video source',
      avMicGain: 'Microphone gain', avVolume: 'Speaker volume', contrast: 'TX source contrast',
      mode: 'Video profile', grayLevels: 'Grayscale levels · TX', avRate: 'Audio sample rate', avChannels: 'Audio channels',
      avFpsPolicy: 'Frame-rate policy', avMinFps: 'Minimum requested FPS', frequency: 'CHANNEL · frequency (MHz)',
      fine: 'RX correction (Hz)', apwr: 'TX POWER · APWR (0–191)', rxBrightness: 'RX brightness', rxContrast: 'RX contrast',
      saturation: 'Color saturation', hPosition: 'Horizontal position', hHold: 'H-HOLD · horizontal timing',
      vHold: 'V-HOLD · vertical timing', hLock: 'H-sync lock strength'
    };
    Object.entries(labels).forEach(([id, value]) => label(id, value));
    const staticButtons = {avRefreshDevices: 'Refresh sources', avMicEnable: 'Enable microphone', avMicStop: 'Stop microphone', avListen: 'Listen', avPause: 'Pause', camera: 'Enable webcam', pattern: 'Use test pattern', connect: 'Connect', disconnect: 'Disconnect', resetHold: 'Reset H/V', selfTest: 'Local test · no RF', saveRxCapture: 'Export RX diagnostic capture'};
    Object.entries(staticButtons).forEach(([id, value]) => button(id, value));
    // Replace only text nodes of checkbox labels; the actual inputs stay attached.
    const checkLabel = (id, value) => { const el = $(id), parent = el.parentElement; parent.replaceChildren(el, document.createTextNode(' ' + value)); };
    checkLabel('avMute', 'Mute TX'); checkLabel('autoLevel', 'Automatic black / white levels'); checkLabel('auto320', 'Auto-detect 320 × 240 Fast / Stable');
    // The legacy field has a non-associated wrapper label in the upstream page.
    if (!$('easyCameraField').querySelector('label[for="easyCamera"]')) $('easyCameraField').querySelector('label').textContent = 'Transmit video source';

    const icons = {
      mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
      video: '<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8m-4-4v4"/>',
      sliders: '<path d="M2 6h20M2 12h20M2 18h20"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
      radio: '<path d="m8 22 4-13 4 13M7 8a7 7 0 0 0 0 8M17 8a7 7 0 0 1 0 8M4 4a12 12 0 0 0 0 16M20 4a12 12 0 0 1 0 16"/><circle cx="12" cy="7" r="2"/>',
      usb: '<path d="M3 12h16l-4-4m4 4-4 4M8 12V6h4m0 0-2-2m2 2-2 2M9 12v6h4"/><circle cx="3" cy="12" r="1"/><rect x="13" y="17" width="3" height="3"/>',
      settings: '<path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3z"/><circle cx="12" cy="12" r="4"/>'
    };
    for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[el.dataset.icon] + '</svg>';

    function advancedSection(name) {
      for (const el of document.querySelectorAll('[data-advanced-panel]')) el.hidden = el.dataset.advancedPanel !== name;
      for (const el of document.querySelectorAll('[data-advanced]')) el.setAttribute('aria-pressed', String(el.dataset.advanced === name));
    }
    let returnFocus;
    function openMenu(name, section) {
      if (!titles[name]) return;
      if (!dialog.open) returnFocus = document.activeElement;
      for (const el of document.querySelectorAll('[data-menu-panel]')) el.hidden = el.dataset.menuPanel !== name;
      text('menuTitle', name==='radio'&&$('role').value!=='tx'?'RADIO · CHANNEL':titles[name]);
      dialog.dataset.activeMenu = name;
      for (const el of document.querySelectorAll('.menu-button')) { const selected = el.dataset.menu === name; el.classList.toggle('selected', selected); el.setAttribute('aria-expanded', String(selected)); }
      if (name === 'advanced') advancedSection(section || 'image');
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('.dialog-body').scrollTop = 0;
      $('closeMenu').focus();
    }
    for (const el of document.querySelectorAll('[data-menu]')) el.addEventListener('click', () => openMenu(el.dataset.menu, el.dataset.section));
    for (const el of document.querySelectorAll('.menu-button')) {el.setAttribute('aria-haspopup', 'dialog');el.setAttribute('aria-controls', 'menuDialog');el.setAttribute('aria-expanded', 'false');}
    for (const el of document.querySelectorAll('[data-advanced]')) el.addEventListener('click', () => advancedSection(el.dataset.advanced));
    $('closeMenu').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {for (const el of document.querySelectorAll('.menu-button')) {el.classList.remove('selected');el.setAttribute('aria-expanded','false');}returnFocus?.focus();});
    dialog.addEventListener('click', event => {if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});

    // Proxy user actions to the original Easy controller, preserving its
    // cancellation, port selection and media permission/lifecycle semantics.
    for (const el of document.querySelectorAll('[data-legacy]')) el.addEventListener('click', () => { const target = $(el.dataset.legacy); if (!target.disabled) {target.click(); refresh();} });
    function bindKnob(knobId, targetId, format, outId, {invert = false} = {}) {
      const knob = $(knobId), target = $(targetId);
      const convert = value => invert ? Number(target.min) + Number(target.max) - value : value;
      knob.addEventListener('input', () => {
        if (target.disabled) return;
        target.value = String(convert(Number(knob.value))); dispatch(target, 'input'); dispatch(target, 'change'); refresh();
      });
      const wheel = event => {if(target.disabled)return;event.preventDefault();const step=Number(knob.step)||1;knob.value=String(Math.min(Number(knob.max),Math.max(Number(knob.min),Number(knob.value)+(event.deltaY<0?step:-step))));dispatch(knob,'input');};
      knob.closest('.dial').addEventListener('wheel',wheel,{passive:false});
      const face=knob.closest('.dial').querySelector('.dial-face');
      let drag=null;
      face.addEventListener('pointerdown',event=>{if(target.disabled||event.button!==0)return;event.preventDefault();drag={x:event.clientX,y:event.clientY,value:Number(knob.value)};face.setPointerCapture(event.pointerId);knob.focus();});
      face.addEventListener('pointermove',event=>{if(!drag||target.disabled)return;const span=Number(knob.max)-Number(knob.min),step=Number(knob.step)||1,delta=(drag.y-event.clientY)+(event.clientX-drag.x);knob.value=String(Math.round((drag.value+delta*span/220)/step)*step);dispatch(knob,'input');});
      face.addEventListener('pointerup',()=>{drag=null;});
      face.addEventListener('pointercancel',()=>{drag=null;});
      return () => {knob.value=String(convert(Number(target.value)));knob.disabled=target.disabled;const value=Number(target.value),fraction=(Number(knob.value)-Number(knob.min))/(Number(knob.max)-Number(knob.min));knob.closest('.dial').style.setProperty('--angle',(-135+Math.max(0,Math.min(1,fraction))*270)+'deg');if(outId)text(outId,format(value));knob.setAttribute('aria-valuetext',format(value));};
    }
    const knobs = [bindKnob('knobVolume','avVolume',v=>Math.round(v*100)+' %','knobVolumeOut'),bindKnob('knobPower','apwr',v=>'APWR '+v,'knobPowerOut',{invert:true}),bindKnob('knobMic','avMicGain',v=>v.toFixed(2)+'×','knobMicOut'),bindKnob('knobFrequency','frequency',v=>v.toFixed(4)+' MHz'),bindKnob('knobFine','fine',v=>(v>0?'+':'')+v+' Hz','knobFineOut')];
    // One upstream TX journal entry contains a French phrase. Translate only
    // its displayed text; keep the original engine and radio protocol intact.
    const english = value => String(value ?? '').replaceAll('audio seul', 'audio only');
    let screenRole = '';
    let localTest = false;
    $('selfTest').addEventListener('click', () => { localTest = true; refresh(); });
    for (const el of document.querySelectorAll('[data-legacy]')) el.addEventListener('click', () => { localTest = false; refresh(); });
    $('mode').addEventListener('change', () => { localTest = false; refresh(); });
    function refresh() {
      const tx = $('role').value==='tx', usage=$('avUsage').value, hasVideo=usage!=='audio';
      for (const panel of document.querySelectorAll('[data-station-role]')) panel.hidden = panel.dataset.stationRole !== (tx ? 'tx' : 'rx');
      const active = !$('easyStop').classList.contains('hidden');
      const connected = !$('disconnect').disabled;
      knobs.forEach(update=>update());
      for (const el of document.querySelectorAll('[data-legacy]')) {
        const target = $(el.dataset.legacy);
        el.disabled=target.disabled;
        if(target.hasAttribute('aria-pressed'))el.setAttribute('aria-pressed',target.getAttribute('aria-pressed'));
      }
      $('consoleStart').disabled=$('easyStart').disabled||active;
      $('consoleStop').disabled=!active||$('easyStop').disabled;
      text('consoleStart',tx?'▶ START TX':'▶ START RX');
      text('consoleStop',$('easyStop').textContent==='Cancel'?'✕ CANCEL':'■ STOP');
      text('lcdRole',tx?'TX':'RX');text('lcdUsage',usage==='av'?'AUDIO + VIDEO':usage==='audio'?'AUDIO':'VIDEO');
      text('lcdFrequency',Number($('frequency').value).toFixed(4));text('lcdPower','APWR '+$('apwr').value);
      const selectedVideo=globalThis.CBAnalogV8.getFormat($('mode').value);
      text('lcdVideoQuality',selectedVideo.w+' × '+selectedVideo.h+(selectedVideo.kind==='color'?' COLOR':' B&W'));
      text('lcdAudioQuality',(Number($('avRate').value)/1000)+' kHz '+($('avChannels').value==='2'?'STEREO':'MONO'));
      $('lcdVideoQuality').classList.toggle('quality-inactive',!hasVideo);
      $('lcdAudioQuality').classList.toggle('quality-inactive',usage==='video');
      text('lcdPowerLevel',$('apwr').value==='191'?'MIN POWER':$('apwr').value==='0'?'MAX POWER':'TX POWER');
      $('powerLockNote').hidden=!$('apwr').disabled;
      text('lcdConnection',connected?'USB CONNECTED':$('easyConnection').textContent==='Selected · not connected'?'ESP SELECTED':'USB DISCONNECTED');
      text('consolePortState',connected?'● ESP connected · USB Web Serial':'○ '+english($('easyConnection').textContent));
      $('consolePortState').classList.toggle('is-connected',connected);
      $('rxIndicator').classList.toggle('is-on',connected&&!tx);$('txIndicator').classList.toggle('is-on',connected&&tx&&active);
      const signal=english($('easyRFState').textContent);
      text('consoleSignalState',signal);text('lcdSync',tx?(active?'TX ACTIVE':'TX READY'):connected?english($('lockStatus').textContent):'H / V —');
      const message=$('easyMessage').textContent,hasError=$('easyMessage').classList.contains('error')||$('status').classList.contains('error');
      text('stationMessage',english(message));$('stationMessage').classList.toggle('is-error',hasError);
      text('easyChooseESP','Choose ESP · Web Serial');text('easyDisconnect','Disconnect ESP');
      text('summaryVideoLabel',!tx&&usage!=='video'?'RECEIVED FORMAT':'VIDEO FORMAT');
      text('summaryVideo',hasVideo?(!tx&&usage!=='video'?english($('easyReceivedFormat').textContent):$('mode').selectedOptions[0]?.textContent||'—'):'Audio only');
      text('summaryFps',(tx?'Predicted frame rate · ':'Frame rate · ')+english($('easyFps').textContent));
      text('summaryAudio',english($('easyAudioSummary').textContent));
      text('summarySource',tx?(usage==='video'?'TX source · '+($('easyCamera').value==='pattern'?'Test pattern':$('easyCamera').selectedOptions[0]?.textContent||'Webcam'):'TX input · '+($('avMicDevice').selectedOptions[0]?.textContent||'Microphone')):'RX input · Radio signal');
      text('summarySync',connected?signal:'No signal');text('summaryDelay','Predicted delay · '+english($('easyDelay').textContent));
      text('log',english($('log').textContent));
      text('sourceLabel','TX VIDEO');
      $('consoleMicLevel').value=Number($('avMicMeter').value)||0;
      // The station is simplex: exactly one screen, selected by radio role.
      const nextRole=tx?'tx':'rx';
      if(screenRole!==nextRole){
        // Preserve both engine canvases, but park the inactive one off-screen.
        const primary=nextRole==='tx'?$('preview').closest('.screen'):$('received').closest('.screen');
        const secondary=nextRole==='tx'?$('received').closest('.screen'):$('preview').closest('.screen');
        $('mainMonitor').append(primary);$('inactiveScreens').append(secondary);screenRole=nextRole;
      }
      const showLocalTest=localTest&&!tx;
      globalThis.CBCleanView?.refresh({tx,hasVideo,localTest:showLocalTest,connected});
      text('monitorLabel',showLocalTest?'LOCAL TEST · NO RF':tx?'TX VIDEO':'RX VIDEO');
      $('monitorStack').classList.toggle('audio-only',!hasVideo);
      const waitingForCamera=tx&&hasVideo&&$('easyCamera').value.startsWith('camera:')&&(!$('cameraVideo').srcObject||$('cameraVideo').readyState<2);
      const showPlaceholder=!showLocalTest&&(!hasVideo||waitingForCamera||(!tx&&(!connected||!Number($('rxRate').textContent))));
      $('monitorPlaceholder').hidden=!showPlaceholder;
      text('monitorTitle',!hasVideo?'ANALOG AUDIO':waitingForCamera?'WEBCAM NOT ACTIVE':connected?'SEARCHING FOR SIGNAL':'WAITING FOR SIGNAL');
      text('monitorHint',!hasVideo?(connected?signal:'Choose your ESP, then press START'):waitingForCamera?'Enable the webcam in VIDEO, or press START TX.':connected?'Video appears when samples are received':'Choose your ESP in the PORT menu');
    }
    if(!navigator.serial)text('browserNotice','Web Serial is unavailable here. Open this console in Chrome or Edge on http://localhost.');
    else if(location.protocol==='file:')text('browserNotice','For microphone access and the audio engine, use DEMARRER.cmd or the included localhost server.');
    refresh();
    setInterval(refresh,200);
  } catch (error) {
    $('bootError').hidden=false;$('bootError').textContent=error.message;
    $('legacyRoot').hidden=false;$('legacyRoot').removeAttribute('aria-hidden');
    $('appRoot').hidden=false;
    console.error(error);
  }
})();
