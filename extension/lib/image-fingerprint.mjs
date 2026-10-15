import { fingerprint } from './fingerprint.mjs';

const cache = new Map();
let serial = Promise.resolve();
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24 * 1024 * 1024;
async function computePixels(url, controller) {
  let bitmap;
  try {
    if (new URL(url).protocol !== 'https:') throw Error('图片地址不支持');
    const response = await fetch(url,{signal:controller.signal,credentials:'omit'});
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('图片读取失败');
    const reader = response.body.getReader(); const parts=[]; let size=0;
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error('图片过大'); }
      parts.push(value);
    }
    const blob = new Blob(parts,{type:response.headers.get('content-type') || ''});
    if (!['image/png','image/jpeg','image/webp'].includes(blob.type.split(';')[0])) throw Error('图片格式不支持');
    const bytes = await blob.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > MAX_PIXELS) throw Error('图片像素过大');
    const canvas = new OffscreenCanvas(32,32); const context = canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(bitmap,0,0,32,32);
    return {sha256,fingerprint:fingerprint(context.getImageData(0,0,32,32).data)};
  } finally { bitmap?.close(); }
}
async function compute(url) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([computePixels(url,controller),new Promise((resolve,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(Error('图片读取超时'));},8000);
    })]);
  } finally { clearTimeout(timer); }
}
export function hashImage(url) {
  if (!cache.has(url)) {
    const promise = serial.then(() => compute(url));
    serial = promise.catch(() => {}); cache.set(url,promise);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return cache.get(url);
}
