import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPorts, descriptionDocumentUrl, imageUrlsInDescription, productId, searchUrl } from '../extension/lib/browser.mjs';
import { createTask } from '../extension/lib/core.mjs';

test('an explicit manual restart reloads the same search page', async () => {
  const previous = globalThis.chrome; const task = createTask(['相机']); const job = task.jobs[0];
  task.tabId = 42; job.restartSearch = true; const navigations = [];
  globalThis.chrome = { tabs: {
    get: async id => ({ id, status: 'complete', url: searchUrl('相机') }),
    update: async (id, options) => { navigations.push([id, options.url]); return { id }; }
  } };
  try {
    await browserPorts({ save: async () => {}, update() {} }).open(job, task);
    assert.deepEqual(navigations, [[42, 'https://mobile.pinduoduo.com/search_result.html?search_key=%E7%9B%B8%E6%9C%BA']]);
    assert.equal(job.restartSearch, false);
  } finally { globalThis.chrome = previous; }
});

test('a 1688 description document yields the long detail images', () => {
  const html = String.raw`var desc='<img src="https:\/\/cbu01.alicdn.com\/img\/ibank\/detail-long.jpg"><img src="https://cbu01.alicdn.com/tps/icon.png">';`;
  assert.deepEqual(imageUrlsInDescription(html), ['https://cbu01.alicdn.com/img/ibank/detail-long.jpg']);
  assert.equal(descriptionDocumentUrl('https://itemcdn.tmall.com/desc/icoss123'), 'https://itemcdn.tmall.com/desc/icoss123');
  assert.equal(descriptionDocumentUrl('https://detail.1688.com/offer/888.html'), '');
});

test('description extraction excludes the confirmed cow, review uploads, telemetry and script resources',()=>{
  const body='<img src="https://cbu01.alicdn.com/img/ibank/2020/428/378/22185873824_536529798.jpg"><img src="https://cbu01.alicdn.com/i2/O1CN01a-0-rate.jpg">'+
    '<img data-src="//cbu01.alicdn.com/img/ibank/real-long.jpg"><img src="https://arms-retcode.aliyuncs.com/r.png?">'+
    '<script>const asset="https://img.alicdn.com/unrelated-app.png";</script><img src="//img.alicdn.com/store-banner.png">';
  assert.deepEqual(imageUrlsInDescription(body),['https://cbu01.alicdn.com/img/ibank/real-long.jpg','https://img.alicdn.com/store-banner.png']);
});
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
test('PDD missing-link resolution cannot click, navigate, refresh or change search position',async()=>{
  const prior=globalThis.chrome; const task=createTask(['苹果手机壳']);task.tabId=42;
  let pageUrl=searchUrl('苹果手机壳'), updates=0, clicks=0, scrolls=0;
  globalThis.chrome={
    tabs:{
      get:async()=>({id:42,status:'complete',url:pageUrl}),
      update:async(_id,change)=>{updates++;pageUrl=change.url;return {id:42,url:pageUrl};},
      goBack:async()=>{pageUrl='https://mobile.pinduoduo.com/index.html';},
      sendMessage:async(_id,message)=>{
        if(message.type==='PDD_OPEN_CARD'){clicks++;pageUrl='https://mobile.pinduoduo.com/goods.html?goods_id=123&page_from=23&_oak_list_price_sign=price-proof&uin=private-user';return {ok:true};}
        if(message.type==='PDD_SCROLL'){scrolls++;return {ok:true};}
        return {url:pageUrl,cards:[{key:'card-1'}],blocked:false,position:0};
      },
      onCreated:{addListener(){},removeListener(){}},remove:async()=>{}
    },
    scripting:{executeScript:async()=>{}}
  };
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});await ports.open(task.jobs[0],task);
    const result=await ports.resolve({key:'card-1'}, {position:0}, task.jobs[0]);
    assert.equal(result.id,'');assert.equal(result.navigated,false);
    assert.equal(pageUrl,searchUrl('苹果手机壳'));assert.equal(updates,0);assert.equal(clicks,0);assert.equal(scrolls,0);
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
        return { url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123', goodsId: '123', blocked: false, reason: '', ready: true, detail: { title: '商品详情', galleryImages: ['https://img.pddpic.com/1.jpg'], attributes: [{ name: '材质', value: '塑料' }], skus: [] } };
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
    assert.deepEqual(calls.map(call => call[0]), ['create', 'get', 'script', 'script', 'message', 'remove']);
    assert.deepEqual(calls[0][1], { url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123', active: false });
    assert.deepEqual(calls[2][1], { target: { tabId: 99 }, files: ['detail-pdd-ui.js','detail-content.js'] });
    assert.equal(calls[3][1].world, 'MAIN');
    assert.equal(calls[3][1].target.tabId, 99);
    assert.equal(typeof calls[3][1].func, 'function');
    assert.deepEqual(calls[4], ['message', 99, { type: 'PDD_DETAIL_SNAPSHOT' }]);
    assert.deepEqual(calls[5], ['remove', 99]);
  } finally { globalThis.chrome = prior; }
});

test('1688 search stays in a background tab and does not open or focus a window', async () => {
  const prior = globalThis.chrome;
  const task = createTask(['手电']);
  task.jobs[0].site = '1688';
  const created = [];
  globalThis.chrome = {
    tabs: {
      get: async id => ({ id, status: 'complete', url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=1' }),
      create: async options => { created.push(options); return { id: 7 }; },
      update: async () => { throw new Error('must not activate a tab'); }
    },
    windows: {
      create: async () => { throw new Error('must not open a window'); },
      update: async () => { throw new Error('must not change window focus'); },
      get: async () => { throw new Error('must not inspect windows'); }
    }
  };
  try {
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    await ports.open(task.jobs[0], task);
    assert.equal(created.length, 1);
    assert.equal(created[0].active, false);
    assert.match(created[0].url, /^https:\/\/s\.1688\.com\/selloffer\/offer_search\.htm\?keywords=/);
    assert.equal(task.tabId, 7);
  } finally { globalThis.chrome = prior; }
});

test('1688 detail stays in a background tab and does not focus a window', async () => {
  const prior = globalThis.chrome;
  const task = createTask(['手电']);
  task.tabId = 42;
  const created = [];
  globalThis.chrome = {
    tabs: {
      get: async id => ({ id, status: 'complete', url: 'https://detail.1688.com/offer/123.html' }),
      create: async options => { created.push(options); return { id: 99 }; },
      update: async () => { throw new Error('must not activate a tab'); },
      remove: async () => {},
      sendMessage: async () => ({
        url: 'https://detail.1688.com/offer/123.html', goodsId: '123', blocked: false, ready: true,
        detailPending: false, skuPending: false, descriptionUrls: [],
        detail: { title: '三光源照玉石专用手电筒', galleryImages: ['https://cbu01.alicdn.com/a.jpg'], detailImages: ['https://cbu01.alicdn.com/d.jpg'], skus: [] }
      })
    },
    windows: {
      create: async () => { throw new Error('must not open a window'); },
      update: async () => { throw new Error('must not change window focus'); }
    },
    scripting: { executeScript: async () => [{ result: null }] }
  };
  try {
    await browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123', site: '1688', title: '三光源照玉石专用手电筒', cents: 2550 }, task);
    assert.deepEqual(created, [{ url: 'https://detail.1688.com/offer/123.html', active: false }]);
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
    { goodsId: '123', blocked: false, ready: true, detail: { title: '', galleryImages: ['https://img.pddpic.com/2.jpg'], attributes: [{ name: '材质', value: '塑料' }] } }
  ]);
  globalThis.chrome = chrome;
  try {
    const detail = await browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' });
    assert.deepEqual(detail.galleryImages, ['https://img.pddpic.com/2.jpg']);
    assert.equal(calls.messages.length, 2);
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('cancels detail waiting promptly and closes the tab without another SKU snapshot',async()=>{
  const prior=globalThis.chrome;let cancelled=false;const waits=[];
  const {chrome,calls}=detailChrome([{goodsId:'123',ready:false,skuPending:true,detailPending:false,detail:{title:'商品',skus:[]}}]);globalThis.chrome=chrome;
  try{
    const ports=browserPorts({save:async()=>{},update(){},detailPollWait:async ms=>{waits.push(ms);cancelled=true;}});
    await assert.rejects(()=>ports.enrich({id:'123',site:'pdd'},{},()=>cancelled),e=>e.cancelled===true);
    assert.equal(calls.messages.length,0);assert.deepEqual(calls.removed,[99]);
    assert.ok(waits.every(ms=>ms<=100));
  }finally{globalThis.chrome=prior;}
});

test('deletion during a MAIN read prevents sending a SKU selection snapshot',async()=>{
  const prior=globalThis.chrome;let cancelled=false;
  const {chrome,calls}=detailChrome([{goodsId:'123',ready:true,detail:{title:'商品'}}]);
  const execute=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async options=>{const result=await execute(options);if(options.world==='MAIN')cancelled=true;return result;};
  globalThis.chrome=chrome;
  try{
    await assert.rejects(()=>browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd'},{},()=>cancelled),e=>e.cancelled===true);
    assert.equal(calls.messages.length,0);assert.deepEqual(calls.removed,[99]);
  }finally{globalThis.chrome=prior;}
});

test('deletion after a SKU snapshot interrupts the polling delay before the next selection',async()=>{
  const prior=globalThis.chrome;let cancelled=false;const waits=[];
  const {chrome,calls}=detailChrome([{goodsId:'123',skuPending:true,detailPending:false,detail:{title:'商品',skus:[]}}]);globalThis.chrome=chrome;
  try{
    const ports=browserPorts({save:async()=>{},update(){},detailPollWait:async ms=>{if(calls.messages.length){waits.push(ms);cancelled=true;}}});
    await assert.rejects(()=>ports.enrich({id:'123',site:'pdd'},{},()=>cancelled),e=>e.cancelled===true);
    assert.equal(calls.messages.length,1);assert.deepEqual(waits,[100]);assert.deepEqual(calls.removed,[99]);
  }finally{globalThis.chrome=prior;}
});

test('deletion during tab creation closes the created tab before injecting or reading',async()=>{
  const prior=globalThis.chrome;let cancelled=false;
  const {chrome,calls}=detailChrome([]);const create=chrome.tabs.create;
  chrome.tabs.create=async options=>{const result=await create(options);cancelled=true;return result;};globalThis.chrome=chrome;
  try{
    await assert.rejects(()=>browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd'},{},()=>cancelled),e=>e.cancelled===true);
    assert.equal(calls.messages.length,0);assert.equal(calls.scripts.length,0);assert.deepEqual(calls.removed,[99]);
  }finally{globalThis.chrome=prior;}
});

test('a verification response racing with deletion still blocks and preserves its page',async()=>{
  const prior=globalThis.chrome;let cancelled=false;
  const {chrome,calls}=detailChrome([]);
  chrome.tabs.sendMessage=async()=>{cancelled=true;return {goodsId:'',blocked:true,reason:'访问过于频繁',detail:null};};globalThis.chrome=chrome;
  try{
    const task={};await assert.rejects(()=>browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd'},task,()=>cancelled),e=>e.blocked===true);
    assert.equal(task.detailTabId,99);assert.deepEqual(calls.removed,[]);
  }finally{globalThis.chrome=prior;}
});

test('PDD waits for pending SKU and images even when attributes have stopped changing',async()=>{
  const prior=globalThis.chrome;
  const base={title:'托盘',attributes:[{name:'品牌',value:'添彩'}],skus:[],detailStatus:'partial'};
  const responses=Array.from({length:10},()=>({goodsId:'123',ready:false,skuPending:true,detailPending:true,detail:base}));
  responses.push({goodsId:'123',ready:true,skuPending:false,detailPending:false,detail:{...base,detailImages:['https://img.pddpic.com/detail.jpg'],skus:[{specs:['白色','160'],price:'0.99'}]}});
  const {chrome,calls}=detailChrome(responses);globalThis.chrome=chrome;
  const waits=[];
  try {
    const detail=await browserPorts({save:async()=>{},update:()=>{},detailPollLimit:15,detailPollWait:async ms=>waits.push(ms)}).enrich({id:'123',site:'pdd'});
    assert.equal(detail.skus[0].cents,99);assert.equal(calls.messages.length,11);
    assert.ok(waits.every(ms=>ms>=1000));
    assert.deepEqual(calls.scripts[0].files,['detail-pdd-ui.js','detail-content.js']);
  }finally{globalThis.chrome=prior;}
});

test('PDD allocates extra reading time for many popup combinations without stopping at 160 snapshots',async()=>{
  const prior=globalThis.chrome;
  const responses=Array.from({length:175},()=>({goodsId:'123',ready:false,skuPending:true,skuTotal:33,detailPending:false,detail:{title:'托盘',detailImages:['https://img.pddpic.com/d.jpg'],skus:[]}}));
  responses.push({goodsId:'123',ready:true,skuPending:false,detailPending:false,detail:{title:'托盘',detailImages:['https://img.pddpic.com/d.jpg'],skus:[{specs:['白色','160'],price:'0.99'}]}});
  const {chrome,calls}=detailChrome(responses);globalThis.chrome=chrome;
  try{
    const detail=await browserPorts({save:async()=>{},update:()=>{},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd'});
    assert.equal(calls.messages.length,176);assert.equal(detail.skus[0].cents,99);
  }finally{globalThis.chrome=prior;}
});

test('detail navigation uses search context while exported product URL stays clean',async()=>{
  const prior=globalThis.chrome;
  const {chrome,calls}=detailChrome([{goodsId:'123',ready:true,detail:{title:'托盘',skus:[{specs:['白色'],price:'1'}]}}]);globalThis.chrome=chrome;
  try{
    await browserPorts({save:async()=>{},update:()=>{},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd',url:'https://mobile.yangkeduo.com/goods.html?goods_id=123',detailSourceUrl:'https://mobile.yangkeduo.com/goods.html?goods_id=123&page_from=23&_oak_list_price_sign=price-proof&uin=private-user'});
    assert.equal(calls.created[0].url,'https://mobile.yangkeduo.com/goods.html?goods_id=123&page_from=23&_oak_list_price_sign=price-proof');
  }finally{globalThis.chrome=prior;}
});

test('PDD wait budget covers more than two dimensions while selections are still settling',async()=>{
  const prior=globalThis.chrome;
  const responses=Array.from({length:320},()=>({goodsId:'123',ready:false,skuPending:true,skuTotal:5,skuDimensions:3,detailPending:false,detail:{title:'洗面奶',detailImages:['https://img.pddpic.com/d.jpg'],skus:[]}}));
  responses.push({goodsId:'123',ready:true,skuPending:false,detailPending:false,detail:{title:'洗面奶',detailImages:['https://img.pddpic.com/d.jpg'],specNames:['净含量','包装规格','款式'],skus:[{specs:['120g','1瓶','单支'],price:'17.78'}]}});
  const {chrome,calls}=detailChrome(responses);globalThis.chrome=chrome;
  try{
    const detail=await browserPorts({save:async()=>{},update:()=>{},detailPollWait:async()=>{}}).enrich({id:'123',site:'pdd'});
    assert.equal(calls.messages.length,321);assert.equal(detail.skus[0].cents,1778);
  }finally{globalThis.chrome=prior;}
});

test('detail verification is handled before goods ID validation and preserves its tab', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '', blocked: true, reason: '请完成安全验证', detail: null }]);
  globalThis.chrome = chrome;
  try {
    const task = { status: 'running' };
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    await assert.rejects(() => ports.enrich({ id: '123' }, task), error => error.blocked === true && error.message === '请完成安全验证');
    assert.equal(task.detailTabId, 99);
    assert.equal(task.detailGoodsId, '123');
    assert.deepEqual(calls.removed, []);
    task.status = 'blocked';
    await ports.close({ preserveBlocked: true });
    assert.deepEqual(calls.removed, []);
    await ports.close();
    assert.deepEqual(calls.removed, [99]);
    assert.equal(task.detailTabId, undefined);
    assert.deepEqual(calls.updates, []);
  } finally { globalThis.chrome = prior; }
});

test('resume reuses a preserved verification tab and closes it after the current product succeeds', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([
    { goodsId: '', blocked: true, reason: '请完成安全验证', detail: null },
    { goodsId: '123', blocked: false, ready: true, detail: { title: '已验证商品', skus: [{ id: 'sku', price: '20.00' }] } }
  ]);
  globalThis.chrome = chrome;
  try {
    const task = { status: 'running' };
    const ports = browserPorts({ save: async () => {}, update: () => {} });
    await assert.rejects(() => ports.enrich({ id: '123' }, task), error => error.blocked);
    task.status = 'running';
    const detail = await ports.enrich({ id: '123', cents: 1000 }, task);
    assert.equal(detail.skus[0].cents, 2000);
    assert.equal(calls.created.length, 1);
    assert.deepEqual(calls.removed, [99]);
    assert.equal(task.detailTabId, undefined);
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

test('ordinary detail errors clear the persisted detail tab state', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '456', blocked: false, detail: { title: '另一个商品' } }]);
  globalThis.chrome = chrome;
  try {
    const task = { status: 'running' };
    await assert.rejects(() => browserPorts({ save: async () => {}, update: () => {} }).enrich({ id: '123' }, task), /ID 不匹配/);
    assert.deepEqual(calls.removed, [99]);
    assert.equal(task.detailTabId, undefined);
    assert.equal(task.detailGoodsId, undefined);
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

test('detail timeout closes its tab after the configured empty-snapshot limit', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([{ goodsId: '123', blocked: false, detail: { title: '', galleryImages: [], attributes: [], skus: [] } }]);
  globalThis.chrome = chrome;
  try {
    await assert.rejects(() => browserPorts({ save: async () => {}, update: () => {}, detailPollLimit: 3, detailPollWait: async () => {} }).enrich({ id: '123' }), /商品详情加载超时/);
    assert.equal(calls.messages.length, 3);
    assert.deepEqual(calls.removed, [99]);
  } finally { globalThis.chrome = prior; }
});

test('detail enrichment waits past a title-only frame for later SKU data', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([
    { goodsId: '123', blocked: false, ready: false, detail: { title: '先出现标题', galleryImages: [], skus: [] } },
    { goodsId: '123', blocked: false, ready: true, detail: { title: '完整商品', skus: [{ id: 'sku-1', specs: ['黑色'], price: '20.00' }] } }
  ]);
  globalThis.chrome = chrome;
  try {
    const detail = await browserPorts({ save: async () => {}, update: () => {}, detailPollWait: async () => {} }).enrich({ id: '123', cents: 1000 });
    assert.equal(detail.skus[0].id, 'sku-1');
    assert.equal(detail.skus[0].cents, 2000);
    assert.equal(calls.messages.length, 2);
  } finally { globalThis.chrome = prior; }
});

test('a JSON root with only a title is not sufficient readiness for later SKU data', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([
    { goodsId: '123', blocked: false, ready: true, source: 'json', detail: { title: 'JSON 先出现标题', galleryImages: [], skus: [] } },
    { goodsId: '123', blocked: false, ready: true, source: 'json', detail: { title: '完整商品', specNames: ['颜色'], skus: [{ id: 'sku-json', specs: ['黑色'], price: '20.00' }] } }
  ]);
  globalThis.chrome = chrome;
  try {
    const detail = await browserPorts({ save: async () => {}, update: () => {}, detailPollWait: async () => {} }).enrich({ id: '123', cents: 1000 });
    assert.equal(detail.skus[0].id, 'sku-json');
    assert.equal(calls.messages.length, 2);
  } finally { globalThis.chrome = prior; }
});

test('detail polling returns the best partial snapshot when the poll limit expires', async () => {
  const prior = globalThis.chrome;
  const { chrome, calls } = detailChrome([
    { goodsId: '123', blocked: false, ready: false, detail: { title: '基础标题', galleryImages: [], skus: [], detailStatus: 'partial' } },
    { goodsId: '123', blocked: false, ready: false, detail: { title: '基础标题', galleryImages: ['https://img.pddpic.com/base.jpg'], skus: [], detailStatus: 'partial' } }
  ]);
  globalThis.chrome = chrome;
  try {
    const detail = await browserPorts({ save: async () => {}, update: () => {}, detailPollLimit: 2, detailPollWait: async () => {} }).enrich({ id: '123', cents: 1000 });
    assert.equal(detail.title, '基础标题');
    assert.deepEqual(detail.galleryImages, ['https://img.pddpic.com/base.jpg']);
    assert.equal(detail.detailStatus, 'partial');
    assert.equal(calls.messages.length, 2);
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
