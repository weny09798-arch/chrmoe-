import test from 'node:test';
import assert from 'node:assert/strict';
import { hashImage } from '../extension/lib/image-fingerprint.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
test('hashing caches full URL, serializes downloads and hashes local pixels',async t=>{
  const previous={fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap,OffscreenCanvas:globalThis.OffscreenCanvas};
  t.after(()=>Object.assign(globalThis,previous));
  const urls=[]; let active=0,max=0;
  globalThis.fetch=async url=>{urls.push(url);active++;max=Math.max(max,active);await turn();active--;return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});};
  globalThis.createImageBitmap=async()=>({width:20,height:20,close(){}});
  globalThis.OffscreenCanvas=class {getContext(){return {drawImage(){},getImageData(){return {data:new Uint8ClampedArray(32*32*4).fill(100)};}};}};
  const a=hashImage('https://img.pddpic.com/cache.png?v=1'),b=hashImage('https://img.pddpic.com/cache.png?v=1'),c=hashImage('https://img.pddpic.com/cache.png?v=2');
  const values=await Promise.all([a,b,c]);
  assert.equal(max,1);assert.equal(urls.length,2);assert.equal(a,b);assert.match(values[0].sha256,/^[a-f0-9]{64}$/);assert.equal(values[0].fingerprint.bits.length,16);
});
test('decode stalls time out and release the serial hashing queue',async t=>{
  const previous={fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};t.after(()=>Object.assign(globalThis,previous));
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.fetch=async()=>new Response(new Uint8Array([1]),{headers:{'content-type':'image/webp'}});
  globalThis.createImageBitmap=()=>new Promise(()=>{});
  let rejected=false;hashImage('https://img.pddpic.com/stall.webp').catch(()=>{rejected=true;});
  await turn();t.mock.timers.tick(8001);await turn();assert.equal(rejected,true);
});
test('oversized downloads fail before decoding',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response('',{headers:{'content-length':String(13*1024*1024),'content-type':'image/jpeg'}});
  await assert.rejects(hashImage('https://img.pddpic.com/huge.jpg'),/失败|过大/);
});
