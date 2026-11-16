
(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.ESPVideoTX7=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VERSION=1,MAX_BLOCK=256,HEADER_BYTES=12,CRC_BYTES=4;
 const MAGIC=Object.freeze([0x54,0x58,0x37,0xa7]);
 // Lossless v1 alphabet: expanded pixel range plus the original V2 references.
 // Original [-38..78] PCM remains bit exact. No v8 watermark/pilot is supported.
 const LEVELS=Object.freeze(Array.from({length:125},(_,i)=>(i-42)&255).concat([(-110)&255,(-48)&255,88]));
 const TO_SYMBOL=new Int16Array(256);TO_SYMBOL.fill(-1);
 LEVELS.forEach((value,index)=>{if(TO_SYMBOL[value]!==-1)throw Error('TX7 alphabet duplicate');TO_SYMBOL[value]=index;});
 const CRC_TABLE=new Uint32Array(256);
 for(let i=0;i<256;i++){let v=i;for(let bit=0;bit<8;bit++)v=(v>>>1)^((v&1)?0xedb88320:0);CRC_TABLE[i]=v>>>0;}
 function bytes(value){if(!(value instanceof Uint8Array))throw TypeError('PCM must be Uint8Array');return value;}
 function index32(value){if(!Number.isInteger(value)||value<0||value>0xffffffff)throw RangeError('TX7 sample index');return value;}
 function crc32(data,start=0,length=data.length-start){let value=0xffffffff;for(let i=start;i<start+length;i++)value=(value>>>8)^CRC_TABLE[(value^data[i])&255];return(value^0xffffffff)>>>0;}
 function put32(data,at,value){for(let i=0;i<4;i++)data[at+i]=value>>>(i*8);}
 function get32(data,at){return(data[at]|data[at+1]<<8|data[at+2]<<16|data[at+3]<<24)>>>0;}
 function packedBytes(count){return Math.ceil(count*7/8);}
 function wireBytes(count){return HEADER_BYTES+packedBytes(count)+CRC_BYTES;}
 function validatePcm(pcm){bytes(pcm);for(const value of pcm)if(TO_SYMBOL[value]<0)throw RangeError('PCM level outside the lossless TX7 alphabet');}
 function encodeBlock(pcm,index=0){
  bytes(pcm);index32(index);if(pcm.length<1||pcm.length>MAX_BLOCK)throw RangeError('TX7 block count');validatePcm(pcm);
  const result=new Uint8Array(wireBytes(pcm.length));result.set(MAGIC);result[4]=VERSION;result[5]=0;
  result[6]=pcm.length&255;result[7]=pcm.length>>>8;put32(result,8,index);
  let reservoir=0,bits=0,at=HEADER_BYTES;
  for(const value of pcm){reservoir=(reservoir<<7)|TO_SYMBOL[value];bits+=7;while(bits>=8){bits-=8;result[at++]=(reservoir>>>bits)&255;}}
  if(bits)result[at++]=(reservoir<<(8-bits))&255;
  put32(result,at,crc32(result,0,at));return result;
 }
 function encodeFinish(index=0){const result=new Uint8Array(HEADER_BYTES+CRC_BYTES);result.set(MAGIC);result[4]=VERSION;result[5]=1;put32(result,8,index32(index));put32(result,HEADER_BYTES,crc32(result,0,HEADER_BYTES));return result;}
 function decodeBlock(input,expectedIndex){
  bytes(input);if(input.length<HEADER_BYTES+CRC_BYTES)throw Error('TX7 truncated block');
  for(let i=0;i<4;i++)if(input[i]!==MAGIC[i])throw Error('TX7 magic');
  if(input[4]!==VERSION||input[5]>1)throw Error('TX7 version/flags');
  const finished=input[5]===1,count=input[6]|input[7]<<8;if(finished?count!==0:(count<1||count>MAX_BLOCK))throw Error('TX7 count');
  const size=wireBytes(count);if(input.length!==size)throw Error('TX7 size');
  const crcAt=size-CRC_BYTES;if(get32(input,crcAt)!==crc32(input,0,crcAt))throw Error('TX7 CRC');
  const index=get32(input,8);if(expectedIndex!==undefined&&index!==index32(expectedIndex))throw Error('TX7 sequence');
  const padding=(8-(count*7)%8)%8;if(padding&&(input[crcAt-1]&((1<<padding)-1)))throw Error('TX7 padding');
  const pcm=new Uint8Array(count);let reservoir=0,bits=0,at=HEADER_BYTES;
  for(let i=0;i<count;i++){while(bits<7){reservoir=(reservoir<<8)|input[at++];bits+=8;}bits-=7;const symbol=(reservoir>>>bits)&127;if(symbol>=LEVELS.length)throw Error('TX7 symbol');pcm[i]=LEVELS[symbol];}
  return {index,count,pcm,nextIndex:(index+count)>>>0,finished};
 }
 class Encoder{
  constructor(index=0){this.reset(index);}
  reset(index=0){this.nextIndex=index32(index);this.samples=0;this.blocks=0;this.wireBytes=0;this.closed=false;}
  encode(pcm){
   if(this.closed)throw Error('TX7 encoder already finished');
   validatePcm(pcm);if(!pcm.length)return new Uint8Array(0);
   const count=Math.ceil(pcm.length/MAX_BLOCK),size=count*(HEADER_BYTES+CRC_BYTES)+Math.floor(pcm.length/MAX_BLOCK)*packedBytes(MAX_BLOCK)+(pcm.length%MAX_BLOCK?packedBytes(pcm.length%MAX_BLOCK):0);
   const result=new Uint8Array(size);let at=0,index=this.nextIndex;
   for(let offset=0;offset<pcm.length;offset+=MAX_BLOCK){const block=pcm.subarray(offset,Math.min(pcm.length,offset+MAX_BLOCK)),packet=encodeBlock(block,index);result.set(packet,at);at+=packet.length;index=(index+block.length)>>>0;}
   this.nextIndex=index;this.samples+=pcm.length;this.blocks+=count;this.wireBytes+=result.length;return result;
  }
  finish(){if(this.closed)return new Uint8Array(0);const result=encodeFinish(this.nextIndex);this.closed=true;this.wireBytes+=result.length;return result;}
 }
 function parseCapability(line){return /^OK TX7 1 BLOCK 256$/.test(String(line).trim())?{version:VERSION,maxBlock:MAX_BLOCK}:null;}
 return Object.freeze({VERSION,MAX_BLOCK,HEADER_BYTES,CRC_BYTES,MAGIC,LEVELS,crc32,packedBytes,wireBytes,encodeBlock,encodeFinish,decodeBlock,Encoder,parseCapability});
});
