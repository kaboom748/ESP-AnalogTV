// Offline RF/video test tools only. No production noise, hardware or driver access.
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const work=__dirname,argv=process.argv.slice(2);
const option=(flag,fallback)=>{const n=argv.indexOf(flag);return n<0?fallback:argv[n+1];};
const tag=option('--tag','baseline'),htmlPath=path.resolve(option('--html',path.join(work,'../HTML/CB_VIDEO_HTMLv4_STANDALONE.html')));
const html=fs.readFileSync(htmlPath,'utf8'),core=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).find(s=>s.includes('root.CBAnalogV8='));
const ctx={};vm.createContext(ctx);vm.runInContext(core,ctx);const C=ctx.CBAnalogV8;
const signed=b=>b===128?-128:(b<<24)>>24,enc=v=>(Math.max(-127,Math.min(127,Math.round(v)))+256)&255;
const modes=option('--modes','all')==='all'?C.formats:C.formats.filter(m=>option('--modes','').split(',').includes(m.id));
const allCases=option('--cases','ideal,gain_dc,ppm500,ppm-500,ppm1000,hburst,hburst_ppm500,v_lost,midfield').split(',');
const frameCount=Number(option('--frames','5'));
function image(mode,frame=0){
 const a=new Uint8ClampedArray(mode.w*mode.h*4),cell=Math.max(3,Math.floor(mode.w/13)),bar=Math.max(2,Math.floor(mode.w/16));
 for(let y=0;y<mode.h;y++)for(let x=0;x<mode.w;x++){
  let v=((Math.floor((x+y*.37)/cell)+Math.floor(y/5))&1)?195:43;
  const center=(Math.floor(mode.w*.23)+Math.floor(y/7)*3+frame*3)%mode.w;
  if((x-center+mode.w)%mode.w<bar)v=235;
  if(x<Math.max(2,Math.floor(mode.w/32)))v=(y*37+frame*19)%220+15;
  const k=4*(y*mode.w+x);a[k]=v;a[k+1]=mode.kind==='color'?Math.max(0,Math.min(255,v+y/mode.h*60-30)):v;
  a[k+2]=mode.kind==='color'?Math.max(0,Math.min(255,v+x/mode.w*80-40)):v;a[k+3]=255;
 }return a;
}
function concatenate(arrays){const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let at=0;for(const a of arrays){out.set(a,at);at+=a.length;}return out;}
function expectedImage(source,m){
 const clamp=v=>Math.max(0,Math.min(255,Math.round(v))),quantize=v=>clamp(255*Math.round(116*v/255)/116),out=new Uint8ClampedArray(m.w*m.h*4);
 for(let y=0;y<m.h;y++)for(let x=0;x<m.w;x++){
  const i=y*m.w+x,k=i*4,yy=quantize(source.y[i]);let r=yy,g=yy,b=yy;
  if(m.kind==='color'){const uv=Math.floor(y/2)*(m.w/2)+Math.floor(x/2),du=quantize(source.u[uv])-128,dv=quantize(source.v[uv])-128;r=clamp(yy+1.402*dv);g=clamp(yy-.344136*du-.714136*dv);b=clamp(yy+1.772*du);}
  out[k]=r;out[k+1]=g;out[k+2]=b;out[k+3]=255;
 }return out;
}
function rowShifts(actual,expected,m){
 if(Buffer.from(actual).equals(Buffer.from(expected)))return{rgbRmse:0,topMeanShift:0,bottomMeanShift:0,maxAbsShift:0,lowCorrelationRows:0,rows:Array.from({length:m.h},()=>({shift:0,corr:1}))};
 const result=[];let mse=0,count=0;
 for(let y=0;y<m.h;y++){
  let best={shift:0,corr:-2};
  for(let shift=-12;shift<=12;shift++){
   let a=0,b=0,aa=0,bb=0,ab=0,n=0;
   for(let x=0;x<m.w;x+=Math.max(1,Math.floor(m.w/160))){
    const i=4*(y*m.w+x),j=4*(y*m.w+(x+shift+m.w)%m.w);
    if(actual[i]===255&&actual[i+1]===0&&actual[i+2]===0)continue;
    const v=.299*actual[i]+.587*actual[i+1]+.114*actual[i+2],r=.299*expected[j]+.587*expected[j+1]+.114*expected[j+2];
    a+=v;b+=r;aa+=v*v;bb+=r*r;ab+=v*r;n++;
   }
   const denom=Math.sqrt(Math.max(0,(n*aa-a*a)*(n*bb-b*b))),corr=denom?(n*ab-a*b)/denom:-1;
   if(corr>best.corr+1e-10||Math.abs(corr-best.corr)<1e-10&&Math.abs(shift)<Math.abs(best.shift))best={shift,corr};
  }
  result.push(best);
  for(let x=0;x<m.w;x++){const i=4*(y*m.w+x);if(actual[i]===255&&actual[i+1]===0&&actual[i+2]===0)continue;for(let k=0;k<3;k++){mse+=(actual[i+k]-expected[i+k])**2;count++;}}
 }
 const quarter=Math.max(1,Math.floor(m.h/4)),avg=a=>a.reduce((s,v)=>s+v.shift,0)/a.length;
 return {rgbRmse:Math.sqrt(mse/Math.max(1,count)),topMeanShift:avg(result.slice(0,quarter)),bottomMeanShift:avg(result.slice(-quarter)),maxAbsShift:Math.max(...result.map(r=>Math.abs(r.shift))),lowCorrelationRows:result.filter(r=>r.corr<.85).length,rows:result};
}
function mutate(source,p,kind){
 let a=source.slice(),ratio=1,offset=0;
 if(kind.includes('hburst')){
  for(let f=0;f<frameCount;f++){
   let at=f*p.fieldSamples+C.VBLANK;
   for(let row=0;row<p.rows.length;row++){if(row>=Math.min(20,Math.floor(p.rows.length*.25))&&row<Math.min(40,Math.floor(p.rows.length*.25)+20))a.fill(208,at,at+48);at+=p.rows[row].len;}
  }
 }
 if(kind.includes('v_lost'))for(let f=1;f<frameCount;f+=2)a.fill(208,f*p.fieldSamples,f*p.fieldSamples+C.VBLANK);
 if(kind==='h_weak')for(let f=0;f<frameCount;f++){let at=f*p.fieldSamples+C.VBLANK;for(const row of p.rows){a.fill(176,at,at+24);at+=row.len;}}
 if(kind==='h_jitter')for(let f=0;f<frameCount;f++){let at=f*p.fieldSamples+C.VBLANK;for(let row=0;row<p.rows.length;row++){const shift=(row%7)-3,original=a.slice(at,at+48);a.fill(208,Math.max(0,at-3),at+51);a.set(original,at+shift);at+=p.rows[row].len;}}
 if(kind==='gain_dc')for(let n=0;n<a.length;n++){const v=signed(a[n]);a[n]=v===-128?128:enc(v*.6+20);}
 if(kind==='fade06'||kind==='fade03'||kind==='fade02'||kind==='fade015'||kind==='dc_jump')for(let n=0;n<a.length;n++){
  const late=(n%p.fieldSamples)>=Math.floor(p.fieldSamples*.35),v=signed(a[n]);
  if(late&&v!==-128)a[n]=kind==='dc_jump'?enc(v+25):enc(v*(kind==='fade06'?.6:kind==='fade03'?.3:kind==='fade02'?.2:.15));
 }
 const match=kind.match(/ppm(-?\d+)/);if(match)ratio=1+Number(match[1])*1e-6;
 if(ratio!==1){const r=new Uint8Array(Math.floor(a.length*ratio));for(let n=0;n<r.length;n++)r[n]=a[Math.min(a.length-1,Math.floor(n/ratio))];a=r;}
 if(kind==='midfield')offset=Math.floor(p.fieldSamples*.43);
 return a.subarray(offset);
}
function decode(mode,data){
 const frames=[],hEvents=[];const d=new C.Decoder({mode:mode.id,onFrame:(pix,info)=>frames.push({pixels:new Uint8ClampedArray(pix),info:{...info}})});
 d.onHSignal=start=>hEvents.push(start);d.feedBytes(data);
 return {d,frames,hEvents};
}
const report={html:htmlPath,sha256:crypto.createHash('sha256').update(html).digest('hex'),testToolOnly:true,cases:[]};
for(const m of modes){
 const p=C.plan(m.id),source=C.sourceFromRGBA(m.id,image(m)),wave=C.makeWave(source,m.id),stream=concatenate(Array.from({length:frameCount},()=>wave));
 const reference=decode(m,stream);if(!reference.frames.length)throw Error('No reference frame '+m.id);
 const ref=expectedImage(source,m);
 for(const kind of allCases){
  let input=stream,expectedMotion=null;
  if(kind.startsWith('motion')){
   const sources=Array.from({length:frameCount},(_,frame)=>C.sourceFromRGBA(m.id,image(m,frame)));
   input=concatenate(sources.map(source=>C.makeWave(source,m.id)));expectedMotion=sources.map(source=>expectedImage(source,m));
  }
  const run=kind==='ideal'?reference:decode(m,mutate(input,p,kind));
  const frames=run.frames.slice(-2).map(f=>({info:f.info,...rowShifts(f.pixels,expectedMotion?expectedMotion[Math.min(f.info.frames-1,expectedMotion.length-1)]:ref,m)}));
  const item={mode:m.id,kind,spp:m.spp,width:m.w,height:m.h,fieldSamples:p.fieldSamples,receivedSamples:run.d.totalSamples,H:run.d.horizontalSyncs,V:run.d.verticalSyncs,Hlost:run.d.hLost,falseH:run.d.falseH,Hreacquired:run.d.hReacquired,autoPeriod:run.d.autoPeriod,frameCount:run.frames.length,frames};report.cases.push(item);
 }
 fs.writeFileSync(path.join(work,'analog-tests-'+tag+'.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({mode:m.id,cases:report.cases.filter(c=>c.mode===m.id).map(c=>({kind:c.kind,H:c.H,V:c.V,frameCount:c.frameCount,bottom:c.frames.at(-1)?.bottomMeanShift,maxShift:c.frames.at(-1)?.maxAbsShift,rmse:c.frames.at(-1)?.rgbRmse,red:c.frames.at(-1)?.info.redPixels}))}));
}
