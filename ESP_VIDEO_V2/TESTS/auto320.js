const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'../HTML/CB_VIDEO_HTMLv4_STANDALONE.html'),'utf8');
const core=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).find(s=>s.includes('root.CBAnalogV8='));
const context={};vm.createContext(context);vm.runInContext(core,context);
vm.runInContext('const RATE=120000;'+html.slice(html.indexOf('class Auto320LineProbe{'),html.indexOf('function autoDetect320('))+';globalThis.Probe=Auto320LineProbe;',context);
const C=context.CBAnalogV8,results=[];
for(const [tx,rx] of [['bw320','bw320stable'],['bw320stable','bw320']]){
 const detected=[],probe=new context.Probe(which=>detected.push(which));
 const decoder=new C.Decoder({mode:rx});decoder.onHSignal=start=>probe.acceptH(start);
 const wave=C.makeWave(C.sourceFromRGBA(tx,C.patternRGBA(tx)),tx);
 for(let f=0;f<4;f++)decoder.feedBytes(wave);
 assert(detected.includes(tx),tx+' not detected from initial '+rx);
 assert(detected.every(x=>x===tx),'spurious auto320 switch');
 results.push({tx,initialRx:rx,detected,pass:true});
}
fs.writeFileSync(path.join(__dirname,'analog-auto320-result.json'),JSON.stringify({passed:results.length,results},null,2));console.log(JSON.stringify(results));
