
/* Bounded local RX diagnostics. Export is initiated by the page user.
 * A caller supplies already-received PCM packets; this module never opens I/O. */
(function(root,factory){
 const api=factory(root);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.CBRXCapture=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const RATE=120000,INDEX_DISCONTINUITY=RATE*20;
 const SETTINGS_NUMERIC=Object.freeze(['audioRate','audioChannels','rfHz','fineHz','apwr','serialBaud','wireVersion','grayLevels','sourceContrast','brightness','contrast','saturation','hPosition','hHold','vHold','hLock']);
 const COUNTERS=Object.freeze({
  serial:['packets','crcErrors','shortPackets','badHeaders','resyncs','discardedBytes'],
  av:['blocks','validHeaders','headerCrcErrors','headerRejected','holdoverBlocks','signalLosses','unverifiedPilotBlocks','resyncs','phaseCorrections','globalSearchSamples','globalResyncs','clockRebases','clockRecoveryAttempts','clockRecoveredHeaders','clockPilotHoldoverBlocks','clockResampledBlocks','clockSearchSamples','audioFrames','audioMissingFrames','audioClockGapFrames','videoSamples','videoMissingSamples','videoDuplicateSamples','videoFramesSkipped','callbackErrors','largeGaps','maxBufferedSamples'],
  audio:['framesRendered','underrunFrames','rejectedFrames','receivedFrames','outputRate','driftPpm','memoryBytes'],
  dc:['blocks','activeBlocks','modelResets','missingBlocks','missingSamples','holdoverBlocks','pilotReanchors','predictedBlocks','flatBlocks','correctedBlocks','controlActiveBlocks','legacyActiveBlocks','controlEvidenceHeaders','controlModelResets']
 });
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 function integer(n,name,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(n)||n<min||n>max)throw RangeError(name);return n;}
 function metadata(input={}){
  const version=typeof input.version==='string'&&/^[A-Za-z0-9 ._+()-]{1,96}$/.test(input.version)?input.version:'unknown';
  const result={version,settings:{},counters:{}},s=input.settings||{},c=input.counters||{};
  if(typeof input.buildSha256==='string'&&/^[a-fA-F0-9]{64}$/.test(input.buildSha256))result.buildSha256=input.buildSha256.toLowerCase();
  if(Number.isInteger(input.transportVersion)&&input.transportVersion>=0&&input.transportVersion<=255)result.transportVersion=input.transportVersion;
  if(['video','av','audio'].includes(s.usage))result.settings.usage=s.usage;
  if(s.videoMode===null||typeof s.videoMode==='string'&&/^(?:bw|col)(?:64|80|96|128|160|192|256|320|640)(?:stable)?$/.test(s.videoMode))result.settings.videoMode=s.videoMode;
  for(const key of SETTINGS_NUMERIC)if(finite(s[key]))result.settings[key]=s[key];
  for(const key of ['autoLevel','auto320'])if(typeof s[key]==='boolean')result.settings[key]=s[key];
  for(const [group,keys]of Object.entries(COUNTERS)){
   const source=c[group]||{},target={};for(const key of keys)if(finite(source[key]))target[key]=source[key];
   if(Object.keys(target).length)result.counters[group]=target;
  }
  return result;
 }
 function base64(bytes){
  if(typeof root.Buffer?.from==='function')return root.Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');
  if(typeof root.btoa!=='function'){
   const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',parts=[];
   for(let at=0;at<bytes.length;at+=3){const a=bytes[at],b=bytes[at+1],c=bytes[at+2];parts.push(alphabet[a>>>2]+alphabet[((a&3)<<4)|((b||0)>>>4)]+(at+1<bytes.length?alphabet[((b&15)<<2)|((c||0)>>>6)]:'=')+(at+2<bytes.length?alphabet[c&63]:'='));}
   return parts.join('');
  }
  const chunks=[];for(let at=0;at<bytes.length;at+=16384)chunks.push(String.fromCharCode(...bytes.subarray(at,Math.min(bytes.length,at+16384))));
  return root.btoa(chunks.join(''));
 }
 class RXCapture{
  constructor({seconds=16,rate=RATE}={}){
   if(rate!==RATE||!finite(seconds)||seconds<=0||seconds>16)throw RangeError('Capture must use 120000 Hz and at most 16 seconds.');
   this.rate=rate;this.capacity=Math.ceil(seconds*rate);this.packetCapacity=Math.ceil(this.capacity/128)+4;
   this.pcm=new Uint8Array(this.capacity);this.offsets=new Float64Array(this.packetCapacity);
   this.indices=new Uint32Array(this.packetCapacity);this.lengths=new Uint16Array(this.packetCapacity);
   this.recording=true;this.clear();
  }
  clear(){
   this.pcm.fill(128);this.totalSamples=0;this.expectedIndex=null;this.packetHead=0;this.packetCount=0;
   this.recordLossEnd=0;this.totalPackets=0;this.gapSamples=0;this.discontinuities=0;this.droppedPacketRecords=0;
  }
  start(){this.recording=true;}
  stop(){this.recording=false;}
  _gap(count){
   if(count>=this.capacity)this.pcm.fill(128);
   else{const at=this.totalSamples%this.capacity,n=Math.min(count,this.capacity-at);this.pcm.fill(128,at,at+n);if(n<count)this.pcm.fill(128,0,count-n);}
   this.totalSamples+=count;this.gapSamples+=count;
  }
  _write(bytes){
   const skip=Math.max(0,bytes.length-this.capacity),at=(this.totalSamples+skip)%this.capacity,source=bytes.subarray(skip),n=Math.min(source.length,this.capacity-at);
   this.pcm.set(source.subarray(0,n),at);if(n<source.length)this.pcm.set(source.subarray(n),0);
   this.totalSamples+=bytes.length;
  }
  _prune(){
   const begin=Math.max(0,this.totalSamples-this.capacity);
   while(this.packetCount&&this.offsets[this.packetHead]+this.lengths[this.packetHead]<=begin){this.packetHead=(this.packetHead+1)%this.packetCapacity;this.packetCount--;}
  }
  record(index,bytes){
   integer(index,'Invalid serial sample index',0,0xffffffff);
   if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>4096)throw TypeError('A nonempty received PCM packet of at most 4096 bytes is required.');
   if(!this.recording)return false;
   if(this.expectedIndex!==null){const gap=(index-this.expectedIndex)>>>0;if(gap>0&&gap<INDEX_DISCONTINUITY)this._gap(gap);else if(gap>=INDEX_DISCONTINUITY)this.discontinuities++;}
   const packetOffset=this.totalSamples;this._write(bytes);this._prune();
   if(this.packetCount===this.packetCapacity){const head=this.packetHead;this.recordLossEnd=Math.max(this.recordLossEnd,this.offsets[head]+this.lengths[head]);this.packetHead=(head+1)%this.packetCapacity;this.packetCount--;this.droppedPacketRecords++;}
   const at=(this.packetHead+this.packetCount)%this.packetCapacity;this.offsets[at]=packetOffset;this.indices[at]=index;this.lengths[at]=bytes.length;
   this.packetCount++;this.totalPackets++;this.expectedIndex=(index+bytes.length)>>>0;return true;
  }
  stats(){return {recording:this.recording,rate:this.rate,capacitySamples:this.capacity,retainedSamples:Math.min(this.totalSamples,this.capacity),
   packetCapacity:this.packetCapacity,retainedPacketRecords:this.packetCount,totalPackets:this.totalPackets,
   lifetimeSerialGapSamples:this.gapSamples,lifetimeIndexDiscontinuities:this.discontinuities,droppedPacketRecords:this.droppedPacketRecords,
   persistentBytes:this.pcm.byteLength+this.offsets.byteLength+this.indices.byteLength+this.lengths.byteLength};}
  snapshot(input={}){
   const begin=Math.max(0,this.totalSamples-this.capacity),length=this.totalSamples-begin,bytes=new Uint8Array(length),at=begin%this.capacity,n=Math.min(length,this.capacity-at);
   bytes.set(this.pcm.subarray(at,at+n));if(n<length)bytes.set(this.pcm.subarray(0,length-n),n);
   const packets=[],discontinuities=[];let covered=0,previousEndIndex=null;
   for(let k=0;k<this.packetCount;k++){
    const slot=(this.packetHead+k)%this.packetCapacity,start=this.offsets[slot],end=start+this.lengths[slot],lo=Math.max(start,begin),hi=Math.min(end,this.totalSamples);
    if(hi<=lo)continue;const offset=lo-begin,index=(this.indices[slot]+lo-start)>>>0,count=hi-lo;
    packets.push([offset,index,count]);covered+=count;
    if(previousEndIndex!==null&&((index-previousEndIndex)>>>0)>=INDEX_DISCONTINUITY)discontinuities.push({offset,expectedIndex:previousEndIndex,receivedIndex:index});
    previousEndIndex=(index+count)>>>0;
   }
   const recordsComplete=this.recordLossEnd<=begin;
   return {format:'ESP-ANALOGAV-RX-CAPTURE',schema:1,rate:this.rate,retainedSamples:length,durationSeconds:length/this.rate,
    startIndex:packets.length?(packets[0][1]-packets[0][0])>>>0:null,
    pcmEncoding:'PCM8 signed modulo 256; 0x80 unavailable',pcmBase64:base64(bytes),
    packetColumns:['offset','serialIndex','length'],packets,discontinuities,
    serialGapSamples:recordsComplete?length-covered:null,packetRecordsComplete:recordsComplete,
    stats:this.stats(),metadata:metadata(input)};
  }
  exportJSON(input={}){return JSON.stringify(this.snapshot(input));}
 }
 return Object.freeze({RATE,RXCapture,metadata});
});
