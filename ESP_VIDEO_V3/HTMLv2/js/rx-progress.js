/* Read-only acquisition telemetry. No timers, drawing, audio or radio I/O.
 * Positions follow actual received PCM, never interpolated missing samples.
 * A row position describes the incoming raster, not image integrity or display.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CBRXProgress=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  function lastReceivedIndex(bytes){
    for(let i=(bytes?.length||0)-1;i>=0;i--)if(bytes[i]!==128)return i;
    return -1;
  }
  function create({C,now=()=>performance.now(),pauseAfterMs=1600}={}){
    if(!C?.plan)throw TypeError('A video codec facade is required.');
    const geometry=new Map();
    let mode=null,position=null,receivedAt=null,revision=0,avEpoch=null,waitForVerticalSync=null;
    function shape(id){
      if(!geometry.has(id)){
        const p=C.plan(id),starts=[];
        let at=C.VBLANK;
        for(const row of p.rows){starts.push(at);at+=row.len;}
        geometry.set(id,{p,starts});
      }
      return geometry.get(id);
    }
    function base(id){
      const {p}=shape(id),color=p.mode.kind==='color';
      return {row:0,totalRows:p.mode.h,plane:color?'Y':'BW',frameId:null,progress:0};
    }
    function rowPosition(id,index,frameId,progress,complete=false){
      const {p}=shape(id),at=clamp(index,0,p.rows.length-1),desc=p.rows[at];
      return {row:desc.y+1,totalRows:desc.plane==='y'?p.mode.h:p.mode.h/2,
        plane:p.mode.kind==='mono'?'BW':desc.plane.toUpperCase(),frameId,
        progress:clamp(progress,0,1),complete};
    }
    function reset(id=mode){
      mode=id;position=null;receivedAt=null;avEpoch=null;waitForVerticalSync=null;revision++;
      if(id)shape(id);
    }
    function discontinuity(decoder){
      reset(decoder?.m?.id||mode);
      waitForVerticalSync=Number(decoder?.verticalSyncs)||0;
    }
    function commit(next){position=next;receivedAt=now();revision++;}
    function observeLegacy(decoder,bytes){
      if(lastReceivedIndex(bytes)<0)return;
      const id=decoder?.m?.id;
      if(!id)return;
      if(mode!==id||avEpoch!==null)reset(id);
      // The application invokes this at the last real byte in the chunk.
      // Decoder gaps and any trailing 0x80 bytes are fed after this observation.
      if(!decoder.anchored||waitForVerticalSync!==null&&decoder.verticalSyncs<=waitForVerticalSync){position=null;receivedAt=now();revision++;return;}
      waitForVerticalSync=null;
      const {p,starts}=shape(id),index=clamp(decoder.row,0,p.rows.length-1);
      const relative=decoder.totalSamples-1-decoder.lineStart;
      if(relative<0){
        // A new porch does not prove that the previous raster's final rows
        // arrived. Retain an actually observed completion, otherwise show
        // row zero of the newly acquired raster instead of inventing 100%.
        if(position?.complete&&position.frameId===decoder.frames-1)return;
        commit({...base(id),frameId:decoder.frames,progress:0,complete:false});
        return;
      }
      const offset=starts[index]+clamp(relative+1,0,p.rows[index].len);
      commit(rowPosition(id,index,decoder.frames,offset/p.fieldSamples,offset>=p.fieldSamples));
    }
    function observeAV(bytes,meta){
      const last=lastReceivedIndex(bytes);
      if(last<0||!meta?.plan?.videoMode)return;
      const id=meta.plan.videoMode,epoch=String(meta.sessionId??'')+':'+id;
      if(mode!==id||avEpoch!==epoch){reset(id);avEpoch=epoch;}
      const {p,starts}=shape(id),cursor=clamp(Number(meta.offset||0)+last,0,p.fieldSamples-1);
      const frameId=meta.frameId??meta.frameSequence??null;
      if(cursor<C.VBLANK){commit({...base(id),frameId,progress:(cursor+1)/p.fieldSamples,complete:false});return;}
      let low=0,high=starts.length-1;
      while(low<high){const middle=Math.ceil((low+high)/2);if(starts[middle]<=cursor)low=middle;else high=middle-1;}
      commit(rowPosition(id,low,frameId,(cursor+1)/p.fieldSamples,cursor+1>=p.fieldSamples));
    }
    function snapshot({role='rx',connected=false,usage='video'}={}){
      const empty=mode?base(mode):{row:0,totalRows:0,plane:null,frameId:null,progress:0};
      const dormant=role==='tx'?'tx':usage==='audio'?'audio-only':!connected?'idle':null;
      const state=dormant||(!position?'searching':receivedAt!==null&&now()-receivedAt>pauseAfterMs?'paused':position.complete?'complete':'receiving');
      const values=dormant?empty:position||empty;
      return Object.freeze({state,row:values.row,totalRows:values.totalRows,plane:values.plane,
        frameId:values.frameId,receivedAt:dormant?null:receivedAt,revision,progress:values.progress});
    }
    return Object.freeze({reset,discontinuity,observeLegacy,observeAV,snapshot});
  }
  return Object.freeze({create,lastReceivedIndex});
});
