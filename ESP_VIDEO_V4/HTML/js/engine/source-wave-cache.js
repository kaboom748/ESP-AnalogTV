
/* Explicit two-frame source/PCM ownership for the TX application.
 * No timers, workers, webcam, DOM, serial or radio access. Preparing ahead is
 * an explicit caller choice: acquiredAt records the source's local age.
 */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.CBSourceWaveCache=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const now=()=>typeof performance!=='undefined'?performance.now():Date.now();
 class FrameCache{
  constructor({C,mode='bw640',slots=2,clock=now}={}){
   if(!C?.prepareSourceInto||!C?.makeWaveInto)throw TypeError('Fast analog core required');
   if(!Number.isInteger(slots)||slots<1||slots>2)throw RangeError('One or two frame slots are supported');
   if(typeof clock!=='function')throw TypeError('Local acquisition clock required');
   this.C=C;this.mode=mode;this.clock=clock;this.queue=[];this.serial=0;this.slots=[];
   this.stats={prepared:0,acquired:0,released:0,queueCancelled:0,sourceCaptures:0,slotAllocations:0,explicitPoolBytes:0};
   this._allocate(slots);
  }
  _allocate(count){
   const m=this.C.getFormat(this.mode),p=this.C.plan(this.mode),n=m.w*m.h;
   if(!m||!p)throw Error('Unknown cache video mode');
   this.slots=Array.from({length:count},(_,index)=>{
    const source={id:m.id,y:new Uint8Array(n),u:m.kind==='color'?new Uint8Array(n/4):null,v:m.kind==='color'?new Uint8Array(n/4):null};
    return {index,state:'free',token:null,scratch:{pixels:new Uint8ClampedArray(n*4),source},pcm:new Uint8Array(p.fieldSamples)};
   });
   this.stats.slotAllocations+=count;
   this.stats.explicitPoolBytes=this.slots.reduce((sum,slot)=>sum+slot.pcm.byteLength+slot.scratch.pixels.byteLength+
    slot.scratch.source.y.byteLength+(slot.scratch.source.u?.byteLength||0)+(slot.scratch.source.v?.byteLength||0),0);
  }
  _free(){const slot=this.slots.find(value=>value.state==='free');if(!slot)throw Error('No free source/PCM frame slot');return slot;}
  _prepare(slot,rgba,controls,metadata){
   const acquiredAt=metadata.acquiredAt===undefined?this.clock():metadata.acquiredAt;
   if(!Number.isFinite(acquiredAt))throw TypeError('Finite local acquisition timestamp required');
   const source=this.C.prepareSourceInto(this.mode,rgba,controls,slot.scratch).source;
   this.C.makeWaveInto(source,this.mode,slot.pcm);
   const frame=Object.freeze({token:++this.serial,slot:slot.index,mode:this.mode,acquiredAt,
    acquisitionSequence:metadata.acquisitionSequence===undefined?this.stats.sourceCaptures:metadata.acquisitionSequence,
    source,pixels:slot.scratch.pixels,pcm:slot.pcm});
   slot.state='prepared';slot.token=frame.token;slot.frame=frame;this.queue.push(slot);
   this.stats.prepared++;this.stats.sourceCaptures++;return frame;
  }
  prepare(rgba,controls={},metadata={}){return this._prepare(this._free(),rgba,controls,metadata);}
  prepareFrom(provider,controls={},metadata={}){
   if(typeof provider!=='function')throw TypeError('Source provider required');
   const slot=this._free(),m=this.C.getFormat(this.mode),acquiredAt=metadata.acquiredAt===undefined?this.clock():metadata.acquiredAt;
   const result=provider(m.w,m.h);
   return this._prepare(slot,result?.rgba||result,controls,{...metadata,acquiredAt:result?.acquiredAt??acquiredAt});
  }
  next(){
   const slot=this.queue.shift();if(!slot)return null;
   slot.state='in-flight';this.stats.acquired++;return slot.frame;
  }
  release(frame){
   const slot=this.slots[frame?.slot];
   if(!slot||slot.state!=='in-flight'||slot.token!==frame.token||slot.frame!==frame)throw Error('Frame lease is not current or not in flight');
   slot.state='free';slot.frame=null;slot.token=null;this.stats.released++;
  }
  cancelQueued(){
   const count=this.queue.length;
   for(const slot of this.queue){slot.state='free';slot.frame=null;slot.token=null;}
   this.queue=[];this.stats.queueCancelled+=count;return count;
  }
  setMode(mode){
   if(this.slots.some(slot=>slot.state!=='free'))throw Error('Release in-flight frames and cancel queued frames before changing mode');
   const count=this.slots.length;this.mode=mode;this._allocate(count);
  }
  getState(){return {mode:this.mode,queued:this.queue.length,inFlight:this.slots.filter(slot=>slot.state==='in-flight').length,
   free:this.slots.filter(slot=>slot.state==='free').length,stats:{...this.stats},
   slots:this.slots.map(slot=>({index:slot.index,state:slot.state,token:slot.token}))};}
 }
 return Object.freeze({FrameCache,create:options=>new FrameCache(options)});
});
