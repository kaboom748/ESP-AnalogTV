
/* CRC-control calibration of the nonlinear PWM/IQ header response. The
 * fallback restores audio only. The original correction always has priority.
 * No source audio is used for calibration; no device or browser I/O. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./av-dc-restoration'));
 else root.CBAVControlRestoration=factory(root.CBAVDC);
})(typeof globalThis!=='undefined'?globalThis:this,function(Q){
 'use strict';
 function bounded(value,fallback,min,max){let n;try{n=Number(value);}catch(_){n=fallback;}if(!Number.isFinite(n))n=fallback;return Math.max(min,Math.min(max,Math.round(n)));}
// Experimental control-only calibration. Does not filter the audio payload.
const BETA=Q.BETA,even=[78,-265,640,-1467,5110,5110,-1467,640,-265,78].map(v=>v/16384),levels=[-48,20,88];
function solve(rows,y,from=0,to=rows.length){const count=rows[0].length,m=Array.from({length:count},()=>new Float64Array(count+1));for(let i=from;i<to;i++){const x=rows[i],v=y[i];for(let a=0;a<count;a++){for(let b=0;b<count;b++)m[a][b]+=x[a]*x[b];m[a][count]+=x[a]*v;}}for(let a=0;a<count;a++)m[a][a]+=.0001;for(let a=0;a<count;a++){let best=a;for(let b=a+1;b<count;b++)if(Math.abs(m[b][a])>Math.abs(m[best][a]))best=b;[m[a],m[best]]=[m[best],m[a]];if(Math.abs(m[a][a])<1e-10)return null;const div=m[a][a];for(let b=a;b<=count;b++)m[a][b]/=div;for(let row=0;row<count;row++)if(row!==a){const f=m[row][a];for(let b=a;b<=count;b++)m[row][b]-=f*m[a][b];}}const result=m.map(a=>a[count]);return result.every(Number.isFinite)?result:null;}
function features(x,i,shift,withTime=true){const at=i+shift,E=even.reduce((n,t,k)=>n+t*x[at-k],0),v=[2*E/100];for(const level of levels){const e=even.reduce((n,t,k)=>n+t*(x[at-k]===level?1:0),0);v.push(.5*(x[at-5]===level?1:0)-e,.5*(x[at-4]===level?1:0)-e);}v.push(1);if(withTime)v.push(i/384);return v;}
function error(rows,y,c,from,to){let square=0;for(let i=from;i<to;i++){let v=0;for(let j=0;j<c.length;j++)v+=rows[i][j]*c[j];square+=(v-y[i])**2;}return square/(to-from);}
function fitHeader(x,y,s,beta){let best=null;for(const shift of [4,5]){const rows=[],target=[];for(let i=16;i<368;i++){rows.push(features(x,i,shift));target.push(y[i]+beta*s[i]);}const train=solve(rows,target,0,288);if(!train)continue;const trainMSE=error(rows,target,train,0,288),validationMSE=error(rows,target,train,288,352);if(!best||trainMSE<best.trainMSE){const all=solve(rows,target);best={shift,rows,target,trainMSE,validationMSE,all,gain:all?.[0]/100,offset:all?.[7],timeSlope:all?.[8]/384};}}return best;}
class ControlCorrector extends Q.Corrector{
 constructor(options={}){super(options);this.controlWindow=bounded(options.controlWindow,96,48,96);this.minimumControls=bounded(options.minimumControls,48,48,this.controlWindow);}
 _restore(read,fit,decision){return {...super._restore(read,fit,decision),audioOnly:true,source:'control'};}
 reset(){super.reset();this.evidence=[];this.psf=null;this.last=null;this.confirmations=0;}
 _holdover(read,options){if(!this.active||!this.state||!this.psf)return {active:false,read,calibration:options.calibration,beta:0,reason:'unverified-header'};const p=this.state;const fit={gain:p.gain,timeSlope:p.timeSlope,offset:p.nextOffset,mse:0};this.counters.holdoverBlocks++;this.counters.predictedBlocks++;return this._restore(read,fit,{active:true,beta:BETA,kind:this.psf.shift===4?1:2,reason:'physical-holdover-predicted',holdover:true,predicted:true});}
 process(read,raw,options={}){this.counters.blocks++;const identity={active:false,read,calibration:options.calibration,beta:0,reason:'physical-unverified'};if(!raw||options.crcValid===false)return this._holdover(read,options);const session=raw.sessionId+':'+raw.plan.signature;if(this.session!==session){this.session=session;this.evidence=[];this.active=false;this.state=null;this.psf=null;this.videoOffset=null;this.confirmations=0;this.counters.modelResets++;}
  const y=new Float64Array(384),s=new Float64Array(384);for(let i=0;i<384;i++){y[i]=read(i);if(y[i]===-128||!Number.isFinite(y[i]))return this._holdover(read,options);if(i)s[i]=s[i-1]+y[i-1];}const x=Q.knownHeader(raw),flat=fitHeader(x,y,s,0),hpf=fitHeader(x,y,s,BETA);if(!flat||!hpf||!hpf.all||!(hpf.gain>.1&&hpf.gain<3))return {...identity,reason:'physical-unsafe-fit'};
  this.evidence.push({difference:flat.validationMSE-hpf.validationMSE,flatMSE:flat.validationMSE,hpfMSE:hpf.validationMSE,timeSlope:hpf.timeSlope});if(this.evidence.length>this.controlWindow)this.evidence.shift();const n=this.evidence.length,mean=this.evidence.reduce((v,a)=>v+a.difference,0)/n,variance=this.evidence.reduce((v,a)=>v+(a.difference-mean)**2,0)/Math.max(1,n-1),SE=Math.sqrt(variance/n),wins=this.evidence.filter(a=>a.difference>0).length/n,score=mean/Math.max(SE,1e-12),validation=this.evidence.reduce((v,a)=>v+a.hpfMSE,0)/n,good=n>=this.minimumControls&&mean>.005&&score>3&&wins>=.60&&validation<Math.max(100,(options.calibration?.noise||0)**2*8);this.confirmations=good?this.confirmations+1:Math.max(0,this.confirmations-1);if(this.confirmations>=2)this.active=true;if(this.active&&n>=this.minimumControls&&score<-3){this.active=false;this.confirmations=0;}
  const decision={active:this.active,beta:this.active?BETA:0,reason:this.active?'physical-control-proof':'physical-uncertain',kind:hpf.shift===4?1:2,history:n,meanCVImprovement:mean,CVstandardError:SE,evidenceScore:score,winFraction:wins,validationMSE:validation,currentFlatCV:flat.validationMSE,currentHPFCV:hpf.validationMSE};this.last=decision;if(!this.active){this.counters.flatBlocks++;return {...identity,...decision};}
  const slopeMean=this.evidence.reduce((v,a)=>v+a.timeSlope,0)/n,slopeSE=Math.sqrt(this.evidence.reduce((v,a)=>v+(a.timeSlope-slopeMean)**2,0)/Math.max(1,n-1)/n),slope=Math.abs(slopeMean)>3*slopeSE&&Math.abs(slopeMean)>2*BETA?slopeMean:0,rows=[],target=[];for(let i=16;i<368;i++){rows.push(features(x,i,hpf.shift,false));target.push(y[i]+BETA*s[i]-slope*i);}const c=solve(rows,target),gain=c?.[0]/100,offset=c?.[7];if(!c||!(gain>.1&&gain<3&&Math.abs(offset)<200))return this._holdover(read,options);this.psf={shift:hpf.shift,coefficients:c};return this._restore(read,{gain,offset,timeSlope:slope,mse:hpf.validationMSE},decision);
 }
}

 class Corrector{
  constructor(options={}){this.legacy=new Q.Corrector(options);this.control=new ControlCorrector(options);this.options=this.legacy.options;this.reset();}
  reset(){this.legacy.reset();this.control.reset();this.last=null;this.counters={};this.stats=this.counters;this._totals={blocks:0,activeBlocks:0,flatBlocks:0,legacyActiveBlocks:0,controlActiveBlocks:0,holdoverBlocks:0,pilotReanchors:0,predictedBlocks:0,missingBlocks:0,missingSamples:0};Object.assign(this.counters,this.legacy.counters,this._totals);}
  get history(){return this.legacy.history;}
  get videoOffset(){return this.legacy.videoOffset;}
  get active(){return !!this.last?.active;}
  get state(){return this.last?.source==='control'?this.control.state:this.legacy.state;}
  process(read,raw,options={}){const legacy=this.legacy.process(read,raw,options),control=this.control.process(read,raw,options);let result,source;if(legacy.active){source='legacy';result={...legacy,audioOnly:false,source};}else if(control.active){source='control';result={...control,audioOnly:true,source};}else{source='none';result=legacy;}
   const totals=this._totals;totals.blocks++;if(result.active){totals.activeBlocks++;totals[source==='legacy'?'legacyActiveBlocks':'controlActiveBlocks']++;if(result.holdover)totals.holdoverBlocks++;if(result.predicted)totals.predictedBlocks++;else if(result.holdover)totals.pilotReanchors++;if(result.missingSamples){totals.missingBlocks++;totals.missingSamples+=result.missingSamples;}}else if(options.crcValid)totals.flatBlocks++;
   Object.assign(this.counters,this.legacy.counters,totals,{controlEvidenceHeaders:this.control.evidence.length,controlModelResets:this.control.counters.modelResets});this.last={...result,read:undefined,fit:undefined,source,controlEvidence:this.control.last};return result;
  }
 }
 return Object.freeze({BETA,Corrector,ControlCorrector,knownHeader:Q.knownHeader});
});
