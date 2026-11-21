(function(root, factory){
 'use strict';
 if(typeof module === 'object' && module.exports) module.exports = factory();
 else root.CBRadioPower = factory();
})(globalThis, function(){
 'use strict';

 const PROBE_TIMEOUT_MS = 900;
 const UNSUPPORTED = 'ERR COMMAND';
 const V4_STATUS = 'OK STATUS CB_FM_STEREO 4';
 const V4_INFO = /^OK INFO LINK 1 BAUD 1500000 WIRE [34] PACE (?:0|150000|160000) CRC32 IEEE TX7 1$/;
 const TX7_CAPABILITY = 'OK TX7 1 BLOCK 256';
 const hwInfoByModel = [
  ['ESP32-C5', /^OK HWINFO TARGET ESP32-C5 UART0 TX11 RX12 CPU 240000000 RF [01]$/],
  ['ESP32-C6', /^OK HWINFO TARGET ESP32-C6 UART0 TX16 RX17 CPU 160000000 RF [01]$/],
  ['ESP32', /^OK HWINFO TARGET ESP32 UART0 TX1 RX3 CPU 240000000 RF [01]$/]
 ];
 const powerByModel = new Map([
  ['ESP32-C5', 63],
  ['ESP32-C6', 0],
  ['ESP32', 127],
  ['ESP8266', 63]
 ]);

 function radioModelFromHwInfo(line){
  if(typeof line !== 'string') return null;
  return hwInfoByModel.find(([, pattern]) => pattern.test(line))?.[0] ?? null;
 }

 function defaultTxPowerForModel(model){
  return powerByModel.get(model) ?? null;
 }

 async function probe(commandAwait, command, prefix){
  try{
   return await commandAwait(command + '\n', line => line === UNSUPPORTED || line.startsWith(prefix), PROBE_TIMEOUT_MS);
  }catch(error){
   if(error.message === UNSUPPORTED) return UNSUPPORTED;
   if(error.message === 'Serial response timed out') return null;
   throw error;
  }
 }

 // Probe an idle V4 serial session. The ESP8266 build lacks HWINFO, SELFTEST
 // and DIAGHW. Require its V4 link and TX7 responses before using that signature.
 async function detectRadioModel(commandAwait){
  const hwInfo = await probe(commandAwait, 'HWINFO', 'OK HWINFO');
  if(hwInfo !== UNSUPPORTED) return radioModelFromHwInfo(hwInfo);

  if(await probe(commandAwait, 'STATUS', 'OK STATUS') !== V4_STATUS) return null;
  const info = await probe(commandAwait, 'INFO', 'OK INFO');
  if(typeof info !== 'string' || !V4_INFO.test(info)) return null;
  if(await probe(commandAwait, 'TX7?', 'OK TX7') !== TX7_CAPABILITY) return null;
  if(await probe(commandAwait, 'SELFTEST', 'OK SELFTEST') !== UNSUPPORTED) return null;
  if(await probe(commandAwait, 'DIAGHW', 'OK DIAG') !== UNSUPPORTED) return null;
  return 'ESP8266';
 }

 return Object.freeze({detectRadioModel, defaultTxPowerForModel, radioModelFromHwInfo});
});
