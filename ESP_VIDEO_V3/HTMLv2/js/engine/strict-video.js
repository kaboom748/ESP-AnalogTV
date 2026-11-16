
/* Strict-quality facade: original V2 RF samples and timing, native color extras.
 * No transform, decimation, regrouped guards, amplitude extension or RX filter.
 */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.CBStrictVideo=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const preset=Object.freeze({id:'classic',label:'Complete ESP_VIDEO_V2 signal',group:1,pixelBlack:-38,pixelWhite:78});
 function createFacade(raw){
  const list=raw.formats.slice();
  for(const [w,h]of [[320,240],[640,480]])list.push(raw.registerFormat({id:'col'+w,
   label:w+' × '+h+' · YUV 4:2:0 color',kind:'color',w,h,spp:1}));
  const formats=Object.freeze(list),cache=new Map();
  function descriptor(id){
   if(!formats.some(format=>format.id===id))throw Error('Unknown video mode');
   if(!cache.has(id)){
    const target=raw.getFormat(id),plan=raw.plan(id);
    cache.set(id,Object.freeze({target,wire:target,wireId:id,group:1,preset,plan,original:plan,
     sourcePixels:target.w*target.h,videoSamples:plan.fieldSamples-raw.VBLANK-plan.rows.length*68,
     originalFrameSamples:plan.fieldSamples,frameSamples:plan.fieldSamples,
     fps:raw.FS/plan.fieldSamples,fpsRatio:1,radioGrayLevels:117}));
   }
   return cache.get(id);
  }
  return Object.freeze({...raw,formats,profiles:Object.freeze([preset]),descriptor,
   getProfile:()=>preset.id,setProfile(id){if(id!==preset.id)throw Error('A quality-reducing or unvalidated profile is excluded');}});
 }
 return Object.freeze({createFacade});
});
