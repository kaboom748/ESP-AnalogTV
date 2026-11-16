
/* Restore the firmware frequencyDc high-pass response after a verified A/V
 * header. Analog payload noise and explicit missing samples remain visible.
 * Automatic detection leaves a flat channel byte-identical. No device I/O. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.CBAVDC=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
// No devices, I/O or global mutable state.
const BLOCK=4800,HEADER=384,PILOT=72,MOD32=4294967296;
const A=1/8192,BETA=(1-(1-A)*(1-A))/((1-A)*(1-A));
const PILOT_LEVELS=[-110,88,-48,88,-110,-48],PAM=[-110,-48,20,88];
const TAPS=[78,-265,640,-1467,5110,13302,-1467,640,-265,78].map(x=>x/16384);
const crcTable=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);crcTable[i]=c>>>0;}
function crc32(bytes,length){let c=0xffffffff;for(let i=0;i<length;i++)c=(c>>>8)^crcTable[(c^bytes[i])&255];return(c^0xffffffff)>>>0;}
function put32(bytes,at,value){for(let i=0;i<4;i++)bytes[at+i]=(value>>>(8*i))&255;}
function knownHeader(raw){const bytes=new Uint8Array(26);bytes[0]=1;bytes[1]=raw.plan.videoIndex;bytes[2]=raw.plan.audioIndex;bytes[3]=!raw.plan.audioOnly&&raw.offset===0?1:0;bytes[4]=raw.sessionId&255;bytes[5]=raw.sessionId>>>8;put32(bytes,6,raw.audioFrame);put32(bytes,10,raw.frameId);put32(bytes,14,raw.offset);put32(bytes,18,raw.videoPTSFrame);put32(bytes,22,crc32(bytes,22));const result=new Float64Array(HEADER);let at=0;for(const level of PILOT_LEVELS){result.fill(level,at,at+12);at+=12;}for(const byte of bytes)for(let shift=6;shift>=0;shift-=2){result.fill(PAM[(byte>>>shift)&3],at,at+3);at+=3;}return result;}
function template(source,kind,phase=kind===1?1:0){if(kind===0)return source;const result=new Float64Array(source.length),shift=kind===1?4:5,taps=[78,-265,640,-1467,5110+8192*phase,5110+8192*(1-phase),-1467,640,-265,78].map(x=>x/16384);for(let i=0;i<result.length;i++)for(let k=0;k<taps.length;k++)result[i]+=taps[k]*(source[Math.max(0,Math.min(source.length-1,i+shift-k))]);return result;}
function phaseTemplate(source,kind,y,s,beta=BETA){const lo=template(source,kind,0),hi=template(source,kind,1),sum=[0,0,0,0],cov=Array.from({length:3},()=>[0,0,0,0]);let n=0;for(let i=16;i<HEADER-16;i++){if(y[i]===-128||Math.abs(y[i])>=125)continue;const q=[lo[i],hi[i]-lo[i],i,y[i]+beta*s[i]];n++;for(let j=0;j<4;j++)sum[j]+=q[j];for(let a=0;a<3;a++)for(let b=0;b<4;b++)cov[a][b]+=q[a]*q[b];}if(n<HEADER/2)return {x:template(source,kind),phase:kind===1?1:0};for(let a=0;a<3;a++)for(let b=0;b<4;b++)cov[a][b]-=sum[a]*sum[b]/n;for(let a=0;a<3;a++){let pivot=a;for(let b=a+1;b<3;b++)if(Math.abs(cov[b][a])>Math.abs(cov[pivot][a]))pivot=b;[cov[a],cov[pivot]]=[cov[pivot],cov[a]];if(Math.abs(cov[a][a])<1e-9)return {x:template(source,kind),phase:kind===1?1:0};const scale=cov[a][a];for(let k=a;k<4;k++)cov[a][k]/=scale;for(let b=0;b<3;b++)if(b!==a){const f=cov[b][a];for(let k=a;k<4;k++)cov[b][k]-=f*cov[a][k];}}const gain=cov[0][3];if(!Number.isFinite(gain)||Math.abs(gain)<1e-9)return {x:template(source,kind),phase:kind===1?1:0};const ratio=cov[1][3]/gain;if(!Number.isFinite(ratio))return {x:template(source,kind),phase:kind===1?1:0};const phase=Math.max(0,Math.min(1,ratio));return {x:template(source,kind,phase),phase};}
function regression(x,y,s){let n=0,sx=0,sy=0,ss=0,st=0,sxx=0,sxy=0,sxs=0,sxt=0,sss=0,ssy=0,sst=0,syy=0,syt=0,stt=0;for(let i=16;i<HEADER-16;i++){if(y[i]===-128)return null;if(Math.abs(y[i])>=125)continue;const a=x[i],b=y[i],c=s[i],t=i;n++;sx+=a;sy+=b;ss+=c;st+=t;sxx+=a*a;sxy+=a*b;sxs+=a*c;sxt+=a*t;sss+=c*c;ssy+=c*b;sst+=c*t;syy+=b*b;syt+=b*t;stt+=t*t;}if(n<HEADER/2)return null;const xx=sxx-sx*sx/n,xy=sxy-sx*sy/n,xs=sxs-sx*ss/n,xt=sxt-sx*st/n,sv=sss-ss*ss/n,ys=ssy-sy*ss/n,ts=sst-st*ss/n,yt=syt-sy*st/n,tt=stt-st*st/n,yy=syy-sy*sy/n,den=xx*tt-xt*xt;if(den<1||sv<1)return null;const gainY=(xy*tt-yt*xt)/den,timeY=(yt*xx-xy*xt)/den,gainS=(xs*tt-ts*xt)/den,timeS=(ts*xx-xs*xt)/den,conditional=sv-gainS*xs-timeS*ts;return {n,sx:sx/n,sy:sy/n,ss:ss/n,st:st/n,xx,xy,xs,xt,gainY,timeY,gainS,timeS,conditional,term:ys-gainY*xs-timeY*ts,zero:yy-gainY*xy-timeY*yt};}
function fitted(stats,beta){const gain=stats.gainY+beta*stats.gainS,timeSlope=stats.timeY+beta*stats.timeS,offset=stats.sy+beta*stats.ss-gain*stats.sx-timeSlope*stats.st,mse=(stats.zero+2*beta*stats.term+beta*beta*stats.conditional)/stats.n;return {gain,offset,timeSlope,mse:Math.max(0,mse)};}
function fittedAtSlope(stats,beta,timeSlope){const fit=fitted(stats,beta),gain=(stats.xy+beta*stats.xs-timeSlope*stats.xt)/stats.xx,offset=stats.sy+beta*stats.ss-gain*stats.sx-timeSlope*stats.st;return {...fit,gain,offset,timeSlope};}
function boundedOption(value,fallback,min,max,integer=true){const number=Number(value);const bounded=Math.max(min,Math.min(max,Number.isFinite(number)?number:fallback));return integer?Math.round(bounded):bounded;}
class Corrector{
 constructor(options={}){this.options={window:boundedOption(options.window,48,6,96),minBlocks:boundedOption(options.minBlocks,6,6,96),minSigma:boundedOption(options.minSigma,5,3,12,false),confirmations:boundedOption(options.confirmations,2,2,8)};this.reset();}
 reset(){this.history=[];this.session=null;this.active=false;this.votes=0;this.last=null;this.state=null;this.videoOffset=null;this.counters={blocks:0,activeBlocks:0,flatBlocks:0,missingBlocks:0,missingSamples:0,holdoverBlocks:0,pilotReanchors:0,predictedBlocks:0,modelResets:0};this.stats=this.counters;}
 _restore(read,fit,decision){const restored=new Float64Array(BLOCK);let integral=0,lastRaw=this.state?.lastRaw??0,missing=0;
  for(let i=0;i<BLOCK;i++){const v=read(i);if(v===-128){restored[i]=-128;integral+=lastRaw;missing++;}else{restored[i]=v+BETA*integral-fit.timeSlope*i-fit.offset;integral+=v;lastRaw=v;}}
  const uncertainty=(decision.predicted?(this.state?.uncertainty||0):0)+missing*BETA*254;this.state={gain:fit.gain,timeSlope:fit.timeSlope,nextOffset:fit.offset+fit.timeSlope*BLOCK-BETA*integral,lastRaw,uncertainty,kind:decision.kind,hqPhase:decision.hqPhase};
  this.counters.activeBlocks++;this.counters.missingSamples+=missing;if(missing)this.counters.missingBlocks++;if(this.videoOffset===null)this.videoOffset=Math.max(-17,Math.min(39,fit.offset));
  return {...decision,videoOffset:this.videoOffset,missingSamples:missing,uncertainty,read:i=>i>=0&&i<BLOCK?restored[i]:-128,calibration:{gain:fit.gain,offset:0,noise:Math.sqrt(fit.mse||0)},fit};
 }
 _holdover(read,options){if(!this.active||!this.state)return {active:false,read,calibration:options.calibration||null,beta:0,reason:'unverified-header'};
  const previous=this.state,source=new Float64Array(HEADER);source.fill(-48);for(let i=0;i<PILOT;i++)source[i]=PILOT_LEVELS[Math.floor(i/12)];const x=template(source,previous.kind,previous.hqPhase);let integral=0,last=previous.lastRaw,n=0,sx=0,sy=0,sxx=0,sxy=0,syy=0;
  for(let i=0;i<72;i++){const raw=read(i);if(raw!==-128){if(i>=16&&i<64&&Math.abs(raw)<125){const a=x[i],b=raw+BETA*integral-previous.timeSlope*i;n++;sx+=a;sy+=b;sxx+=a*a;sxy+=a*b;syy+=b*b;}last=raw;}integral+=last;}
  let fit={gain:previous.gain,timeSlope:previous.timeSlope,offset:previous.nextOffset,mse:0},pilot=false;
  if(n>=24){const den=sxx-sx*sx/n,gain=(sxy-sx*sy/n)/den,offset=(sy-gain*sx)/n,mse=Math.max(0,(syy-sy*sy/n-(sxy-sx*sy/n)**2/den)/n);if(gain>.1&&gain<3&&gain>previous.gain*.65&&gain<previous.gain*1.5&&Math.sqrt(mse)<=Math.max(2,(options.calibration?.noise||0)*1.8)){fit={gain,timeSlope:previous.timeSlope,offset,mse};pilot=true;}}
  this.counters.holdoverBlocks++;if(pilot)this.counters.pilotReanchors++;else this.counters.predictedBlocks++;
  const decision={active:true,beta:BETA,kind:previous.kind,hqPhase:previous.hqPhase,reason:pilot?'restoration-holdover-pilot':'restoration-holdover-predicted',holdover:true,predicted:!pilot,history:this.history.length};this.last=decision;return this._restore(read,fit,decision);
 }
 process(read,raw,options={}){
  this.counters.blocks++;const identity={active:false,read,calibration:options.calibration||null,beta:0,reason:'unverified-header'};
  if(!raw||options.crcValid===false)return this._holdover(read,options);
  const session=raw.sessionId+':'+raw.plan.signature;if(this.session!==session){this.history=[];this.active=false;this.votes=0;this.state=null;this.videoOffset=null;this.session=session;this.counters.modelResets++;}
  const y=new Float64Array(HEADER),s=new Float64Array(HEADER);let integral=0;
  for(let i=0;i<HEADER;i++){const v=read(i);if(v===-128){if(this.active)return this._holdover(read,options);this.counters.missingBlocks++;return {...identity,reason:'missing-header'};}if(!Number.isFinite(v))return {...identity,reason:'invalid-input'};y[i]=v;s[i]=integral;integral+=v;}
  const source=knownHeader(raw),choices=[{x:source,phase:null,kind:0},{...phaseTemplate(source,1,y,s),kind:1},{...phaseTemplate(source,2,y,s),kind:2}],allStats=choices.map(f=>regression(f.x,y,s));if(allStats.some(x=>!x))return this.active?this._holdover(read,options):{...identity,reason:'insufficient-fit'};const selected=fitted(allStats[1],BETA).mse<=fitted(allStats[2],BETA).mse?1:2,phaseFits=[choices[0],choices[selected]],stats=[allStats[0],allStats[selected]],flatFits=[allStats[0],regression(phaseTemplate(source,1,y,s,0).x,y,s),regression(phaseTemplate(source,2,y,s,0).x,y,s)];stats.flatZero=Math.min(...flatFits.filter(Boolean).map(x=>x.zero));
  this.history.push(stats);if(this.history.length>this.options.window)this.history.shift();
  let flat=null,hpf=null;
  for(let kind=0;kind<2;kind++){let n=0,zero=0,term=0,conditional=0;for(const h of this.history){const a=h[kind];n+=a.n;zero+=a.zero;term+=a.term;conditional+=a.conditional;}const estimate=-term/conditional,sseHP=zero+2*BETA*term+BETA*BETA*conditional,mseHP=Math.max(0,sseHP/(n-this.history.length*3-1)),sigma=Math.sqrt(mseHP/conditional),significance=estimate/Math.max(1e-15,sigma);const item={kind,n,betaEstimate:estimate,betaSigma:sigma,significance,mseHP,mseFlat:zero/n,improvement:(zero-sseHP)/n,sseHP,zero};if(!flat||item.zero<flat.zero)flat=item;if(!hpf||item.sseHP<hpf.sseHP)hpf=item;}
  flat={...flat,zero:this.history.reduce((n,h)=>n+h.flatZero,0)};
  const unambiguous=this.history.length>=this.options.minBlocks&&hpf.betaEstimate>BETA*.45&&hpf.betaEstimate<BETA*1.6&&hpf.significance>=this.options.minSigma&&hpf.sseHP<flat.zero&&hpf.improvement>.01;
  this.votes=unambiguous?this.votes+1:Math.max(0,this.votes-1);if(this.votes>=this.options.confirmations)this.active=true;
  if(this.active&&this.history.length>=this.options.minBlocks&&flat.zero<hpf.sseHP*.8){this.active=false;this.votes=0;}
  const decision={history:this.history.length,active:this.active,beta:this.active?BETA:0,kind:phaseFits[hpf.kind].kind,hqPhase:phaseFits[hpf.kind].phase,betaEstimate:hpf.betaEstimate,betaSigma:hpf.betaSigma,significance:hpf.significance,mseFlat:flat.zero/hpf.n,mseHP:hpf.mseHP,reason:this.active?'known-header-hpf-evidence':unambiguous?'confirming-hpf':'flat-or-uncertain'};this.last=decision;
  if(!this.active){this.counters.flatBlocks++;return {...identity,...decision};}
  const slopes=this.history.map(h=>fitted(h[hpf.kind],BETA).timeSlope),slopeMean=slopes.reduce((n,v)=>n+v,0)/slopes.length,slopeSigma=Math.sqrt(slopes.reduce((n,v)=>n+(v-slopeMean)**2,0)/Math.max(1,slopes.length-1)/slopes.length),sharedSlope=Math.abs(slopeMean)>3*slopeSigma&&Math.abs(slopeMean)>2*BETA?slopeMean:0;
  const fit=fittedAtSlope(stats[hpf.kind],BETA,sharedSlope);decision.postDC=sharedSlope/BETA;decision.postDCSigma=slopeSigma/BETA;if(!(fit.gain>.1&&fit.gain<3&&Math.abs(fit.offset)<200))return {...identity,...decision,active:false,reason:'unsafe-calibration'};
  return this._restore(read,fit,decision);
 }
}
return Object.freeze({BETA,Corrector,knownHeader});
});
