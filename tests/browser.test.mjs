import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPorts, productId, searchUrl } from '../extension/lib/browser.mjs';
import { createTask } from '../extension/lib/core.mjs';

test('search URL encodes a keyword as one query value',()=>{
  const value=searchUrl('相机 & 充电器?#');
  const url=new URL(value);
  assert.equal(url.origin,'https://mobile.pinduoduo.com');assert.equal(url.searchParams.get('search_key'),'相机 & 充电器?#');assert.equal([...url.searchParams].length,1);
});
test('product ID extraction rejects foreign sites and malformed IDs',()=>{
  assert.equal(productId('https://mobile.pinduoduo.com/goods.html?goods_id=1234'),'1234');
  assert.equal(productId('https://mobile.pinduoduo.com.attacker.example/goods.html?goods_id=1234'),'');
  assert.equal(productId('javascript:alert(1)'),'');
  assert.equal(productId('https://mobile.pinduoduo.com/goods.html?goods_id=NaN'),'');
});
test('image access requests only the observed source and never fetches before permission',async()=>{
  const prior=globalThis.chrome, priorFetch=globalThis.fetch; let requested, fetched=false;
  globalThis.chrome={permissions:{contains:async value=>{requested=value;return false;}}};
  globalThis.fetch=async()=>{fetched=true;throw new Error('must not reach network');};
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});
    await assert.rejects(()=>ports.hash('https://img.pddpic.com/goods/a.jpg'),error=>error.blocked&&error.permissionOrigin==='https://img.pddpic.com/*');
    assert.deepEqual(requested,{origins:['https://img.pddpic.com/*']});assert.equal(fetched,false);
    await assert.rejects(()=>ports.hash('https://img.pddpic.com.attacker.example/a.jpg'),/暂不支持/);
  } finally {globalThis.chrome=prior;globalThis.fetch=priorFetch;}
});
test('manual navigation to a different search pauses rather than saving unrelated goods',async()=>{
  const prior=globalThis.chrome; const task=createTask(['相机']); task.tabId=42;
  let pageUrl=searchUrl('相机');
  globalThis.chrome={
    tabs:{get:async()=>({id:42,status:'complete',url:pageUrl}),sendMessage:async()=>({url:pageUrl,cards:[],blocked:false})},
    scripting:{executeScript:async()=>{}}
  };
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});await ports.open(task.jobs[0],task);
    pageUrl=searchUrl('书包');
    await assert.rejects(()=>ports.read(task.jobs[0]),error=>error.blocked&&/离开/.test(error.message));
  } finally {globalThis.chrome=prior;}
});
test('returning from a same-tab product detail restores the requested search explicitly',async()=>{
  const prior=globalThis.chrome; const task=createTask(['苹果手机壳']);task.tabId=42;
  let pageUrl=searchUrl('苹果手机壳'), updates=0;
  globalThis.chrome={
    tabs:{
      get:async()=>({id:42,status:'complete',url:pageUrl}),
      update:async(_id,change)=>{updates++;pageUrl=change.url;return {id:42,url:pageUrl};},
      goBack:async()=>{pageUrl='https://mobile.pinduoduo.com/index.html';},
      sendMessage:async(_id,message)=>{
        if(message.type==='PDD_OPEN_CARD'){pageUrl='https://mobile.pinduoduo.com/goods.html?goods_id=123';return {ok:true};}
        if(message.type==='PDD_SCROLL') return {ok:true};
        return {url:pageUrl,cards:[{key:'card-1'}],blocked:false,position:0};
      },
      onCreated:{addListener(){},removeListener(){}},remove:async()=>{}
    },
    scripting:{executeScript:async()=>{}}
  };
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});await ports.open(task.jobs[0],task);
    const result=await ports.resolve({key:'card-1'}, {position:0}, task.jobs[0]);
    assert.equal(result.id,'123');assert.equal(result.navigated,true);
    assert.equal(pageUrl,searchUrl('苹果手机壳'));assert.equal(updates,1);
  } finally {globalThis.chrome=prior;}
});

test('detail enrichment opens a background tab, reads its snapshot, and preserves search tab', async () => {
  const prior = globalThis.chrome;
  const calls = [];
  const searchUrlValue = searchUrl('相机');
  globalThis.chrome = {
    tabs: {
      create: async options => { calls.push(['create', options]); return { id: 99 }; },
      get: async id => { calls.push(['get', id]); return { id, status: 'complete', url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123' }; },
      sendMessage: async (id, message) => {
        calls.push(['message', id, message]);
        return { url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123', goodsId: '123', blocked: false, reason: '', detail: { title: '商品详情', galleryImages: ['https://img.pddpic.com/1.jpg'], skus: [] } };
      },
      update: async () => { throw new Error('search tab must not be updated'); },
      remove: async id => { calls.push(['remove', id]); }
    },
    scripting: { executeScript: async options => { calls.push(['script', options]); } }
  };
  try {
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    const detail = await ports.enrich({ id: '123', url: searchUrlValue, title: '卡片名', cents: 1999 });
    assert.equal(detail.title, '商品详情');
    assert.equal(detail.skus[0].cents, 1999);
    assert.deepEqual(calls, [
      ['create', { url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123', active: false }],
      ['get', 99],
      ['script', { target: { tabId: 99 }, files: ['detail-content.js'] }],
      ['message', 99, { type: 'PDD_DETAIL_SNAPSHOT' }],
      ['remove', 99]
    ]);
  } finally { globalThis.chrome = prior; }
});

function detailChrome(responses) {
  const calls = { created: [], scripts: [], messages: [], removed: [], updates: [] };
  let index = 0;
  return {
    calls,
    chrome: {
      tabs: {
        create: async options => { calls.created.push(options); return { id: 99 }; },
        get: async id => ({ id, status: 'complete', url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123' }),
        sendMessage: async (id, message) => {
          calls.messages.push([id, message]);
          const response = responses[Math.min(index++, responses.length - 1)];
          if (response instanceof Error) throw response;
          return response;
        },
        update: async (...args) => { calls.updates.push(args); },
        remove: async id => { calls.removed.push(id); }
      },
      scripting: { executeScript: async options => { calls.scripts.push(options); } }
    }
  };
}

test('detail enrichment retries an empty snapshot until content appears', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([
    { goodsId: '123', blocked: false, detail: { title: '', galleryImages: [], attributes: [], skus: [] } },
    { goodsId: '123', blocked: false, detail: { title: '', galleryImages: ['https://img.pddpic.com/2.jpg'] } }
  ]);
  globalThis.chrome = chrome;
  try {
    const detail = await browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' });
    assert.deepEqual(detail.galleryImages, ['https://img.pddpic.com/2.jpg']);
    assert.equal(calls.messages.length, 2);
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('detail verification page raises a blocked error and closes only the detail tab', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '123', blocked: true, reason: '请完成安全验证', detail: null }]);
  globalThis.chrome = chrome;
  try {
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    await assert.rejects(() => ports.enrich({ id: '123' }), error => error.blocked === true && error.message === '请完成安全验证');
    assert.deepEqual(calls.removed, [99]);
    assert.deepEqual(calls.updates, []);
  } finally { globalThis.chrome = prior; }
});

test('detail snapshot for another product is rejected and the detail tab is closed', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '456', blocked: false, detail: { title: '另一个商品' } }]);
  globalThis.chrome = chrome;
  try {
    await assert.rejects(() => browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' }), error => !error.blocked && /ID 不匹配/.test(error.message));
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('detail read failure still closes the detail tab', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([new Error('详情解析失败')]);
  globalThis.chrome = chrome;
  try {
    await assert.rejects(() => browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' }), /详情解析失败/);
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('detail timeout closes its tab after forty empty snapshots', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '123', blocked: false, detail: { title: '', galleryImages: [], attributes: [], skus: [] } }]);
  globalThis.chrome = chrome;
  try {
    await assert.rejects(() => browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' }), /商品详情加载超时/);
    assert.equal(calls.messages.length, 40);
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('invalid product ID fails before creating a tab', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([]);
  globalThis.chrome = chrome;
  try {
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    await assert.rejects(() => ports.enrich({ id: '123&foo=456' }), error => !error.blocked && /无效商品 ID/.test(error.message));
    assert.deepEqual(calls.created, []);
  } finally { globalThis.chrome = prior; }
});

test('close removes a live detail tab once and remains idempotent', async () => {
  const prior = globalThis.chrome;
  let releaseSnapshot, snapshotRequested;
  const waiting = new Promise(resolve => { snapshotRequested = resolve; });
  const snapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  const { chrome, calls } = detailChrome([]);
  chrome.tabs.sendMessage = async () => { snapshotRequested(); return snapshot; };
  globalThis.chrome = chrome;
  try {
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    const enriching = ports.enrich({ id: '123' });
    await waiting;
    await ports.close();
    await ports.close();
    releaseSnapshot({ goodsId: '123', blocked: false, detail: { title: '商品详情' } });
    await enriching;
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});
