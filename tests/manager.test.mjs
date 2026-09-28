import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createTask } from '../extension/lib/core.mjs';

const html = await readFile(new URL('../extension/manager.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('adding a name immediately queues collection and opens the collection tab', async () => {
  const { document, window } = parseHTML(html);
  const saved = { keywords: [], task: null };let tabCreates=0;
  globalThis.document=document;globalThis.window=window;
  globalThis.chrome={
    runtime:{id:'test-extension'},
    storage:{local:{async get(){return saved;},async set(values){Object.assign(saved,values);}}},
    tabs:{async create(){tabCreates++;throw new Error('测试中断页面打开');}}
  };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,callback)=>callback({})}}});
  await import(`../extension/manager.mjs?case=${Math.random()}`);await tick();
  document.getElementById('keyword-input').value='苹果手机壳';
  document.getElementById('add-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await tick();await tick();
  assert.deepEqual(saved.keywords,['苹果手机壳']);
  assert.equal(saved.task.jobs[0].keyword,'苹果手机壳');
  assert.equal(tabCreates,1);
});
test('a name added during collection is saved and searched after the current name', async () => {
  const { document, window }=parseHTML(html);
  const saved={keywords:[],task:null};let created=0,rejectFirst;
  const firstTab=new Promise((_resolve,reject)=>{rejectFirst=reject;});
  globalThis.document=document;globalThis.window=window;
  globalThis.chrome={
    runtime:{id:'test-extension'},
    storage:{local:{async get(){return saved;},async set(values){Object.assign(saved,values);}}},
    tabs:{async create(){created++;if(created===1)return firstTab;throw new Error('测试中断页面打开');}}
  };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,callback)=>callback({})}}});
  await import(`../extension/manager.mjs?case=${Math.random()}`);await tick();
  const add=name=>{document.getElementById('keyword-input').value=name;document.getElementById('add-form').dispatchEvent(new window.Event('submit',{cancelable:true}));};
  add('相机');await tick();await tick();assert.equal(created,1);
  add('书包');await tick();await tick();
  assert.deepEqual(saved.task.jobs.map(job=>job.keyword),['相机','书包']);
  rejectFirst(new Error('测试中断页面打开'));
  await tick();await tick();await tick();
  assert.equal(created,2);
});
test('the per-name retry replaces stale results and restarts that name', async () => {
  const {document,window}=parseHTML(html);
  const task=createTask(['相机']);task.status='done';task.jobs[0].status='done';task.jobs[0].phase='done';task.jobs[0].searchStatus='done';task.jobs[0].detailDone=1;task.jobs[0].scanned=12;
  task.jobs[0].groups=[{best:{id:'old',title:'已缴纳保证金',url:'https://mobile.pinduoduo.com/goods.html?goods_id=1',cents:2999,detailStatus:'done'}}];
  const saved={keywords:['相机'],task};let created=0;
  globalThis.document=document;globalThis.window=window;
  globalThis.chrome={runtime:{id:'test-extension'},storage:{local:{async get(){return saved;},async set(values){Object.assign(saved,values);}}},tabs:{async create(){created++;return new Promise(()=>{});}}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,callback)=>callback({})}}});
  await import(`../extension/manager.mjs?case=${Math.random()}`);await tick();
  const retry=document.querySelector('[data-retry-job="0"]');
  assert.ok(retry);retry.dispatchEvent(new window.Event('click'));
  await tick();await tick();
  assert.equal(saved.task.jobs[0].groups.length,0);assert.equal(saved.task.jobs[0].scanned,0);
  assert.equal(created,1);
});
test('clear all removes saved names, results and progress', async () => {
  const fixture=await managerFixture();
  assert.ok(fixture.document.getElementById('clear-all'));
  fixture.click('clear-all');await tick();await tick();
  assert.deepEqual(fixture.saved.keywords,[]);assert.equal(fixture.saved.task,null);
  assert.equal(fixture.document.getElementById('keyword-count').textContent,'0 个');
  assert.equal(fixture.document.getElementById('export').disabled,true);
});
test('clear all stops an active search before old checkpoints can restore data', async () => {
  const {document,window}=parseHTML(html);const saved={keywords:[],task:null};let rejectTab;
  const tabOpening=new Promise((_resolve,reject)=>{rejectTab=reject;});
  globalThis.document=document;globalThis.window=window;
  globalThis.chrome={runtime:{id:'test-extension'},storage:{local:{async get(){return saved;},async set(values){Object.assign(saved,values);}}},tabs:{async create(){return tabOpening;}}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,callback)=>callback({})}}});
  await import(`../extension/manager.mjs?case=${Math.random()}`);await tick();
  document.getElementById('keyword-input').value='相机';
  document.getElementById('add-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await tick();await tick();
  document.getElementById('clear-all').dispatchEvent(new window.Event('click'));
  rejectTab(new Error('页面打开取消'));await tick();await tick();await tick();
  assert.deepEqual(saved.keywords,[]);assert.equal(saved.task,null);
  assert.equal(document.getElementById('export').disabled,true);
});

async function managerFixture(configureTask = () => {}) {
  const { document, window } = parseHTML(html);
  const task = createTask(['相机']);
  task.status = 'paused'; task.jobs[0].status = 'paused'; task.permissionOrigin = 'https://img.pddpic.com/*';
  configureTask(task);
  let decidePermission, tabCreates = 0, permissionRequests = 0;
  const removedTabs = [], activatedTabs = [];
  const permission = new Promise(resolve => { decidePermission = resolve; });
  const saved = { keywords: ['相机'], task };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    storage: { local: { async get() { return saved; }, async set(values) { Object.assign(saved, values); } } },
    permissions: { request: async () => { permissionRequests++; return permission; } },
    tabs: {
      async create() { tabCreates++; throw new Error('unexpected collection'); },
      async remove(id) { removedTabs.push(id); },
      async update(id) { activatedTabs.push(id); return { id, windowId: 5 }; }
    },
    windows: { async update() {} }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, callback) => callback({}) } } });
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  const click = id => document.getElementById(id).dispatchEvent(new window.Event('click'));
  return { document, saved, click, decidePermission, removedTabs, activatedTabs, get tabCreates() { return tabCreates; }, get permissionRequests() { return permissionRequests; } };
}

test('resume locks task immediately and stop cancels a pending permission grant', async () => {
  const fixture = await managerFixture();
  fixture.click('resume');
  fixture.click('resume');
  assert.equal(fixture.permissionRequests, 1);
  assert.equal(fixture.document.getElementById('resume').hidden, true);
  fixture.click('stop');
  fixture.decidePermission(true);
  await tick(); await tick();
  assert.equal(fixture.saved.task.status, 'stopped');
  assert.equal(fixture.saved.task.jobs[0].status, 'stopped');
  assert.equal(fixture.tabCreates, 0);
});

test('rejected permission request releases the guard for another attempt', async () => {
  const fixture = await managerFixture();
  fixture.click('resume');
  fixture.decidePermission(Promise.reject(new Error('权限请求失败')));
  await tick(); await tick();
  assert.equal(fixture.document.getElementById('resume').hidden, false);
  assert.equal(fixture.document.getElementById('add-button').disabled, false);
  assert.match(fixture.document.getElementById('notice').textContent, /权限请求失败/);
  assert.equal(fixture.saved.task.status, 'paused');
});

test('denied permission releases resume guard and keeps saved task resumable', async () => {
  const fixture = await managerFixture();
  fixture.click('resume');
  fixture.decidePermission(false);
  await tick(); await tick();
  assert.equal(fixture.saved.task.status, 'paused');
  assert.equal(fixture.document.getElementById('resume').hidden, false);
  assert.equal(fixture.document.getElementById('add-button').disabled, false);
  assert.equal(fixture.tabCreates, 0);
});
test('detail collection shows its own progress and failures while keeping results exportable', async () => {
  const fixture = await managerFixture();
  const task = fixture.saved.task;
  task.status = 'running';
  const job = task.jobs[0];
  job.status = 'running'; job.phase = 'detail'; job.detailDone = 7; job.scanned = 200;
  job.groups = Array.from({ length: 20 }, (_, index) => ({ best: {
    id: `item-${index}`, title: `相机商品${index}`, url: `https://mobile.pinduoduo.com/goods.html?goods_id=${index}`,
    cents: 2999, detailStatus: index < 5 ? 'done' : index < 7 ? 'partial' : index < 9 ? 'error' : 'pending',
    detailNote: index === 5 ? '仅采集到基础商品信息' : index === 7 ? '详情解析失败' : ''
  } }));
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  assert.equal(fixture.document.getElementById('task-title').textContent, '正在补全详情 · 相机');
  assert.match(fixture.document.getElementById('current-detail').textContent, /正在补全详情 9 \/ 20 · 完整 5 · 部分 2 · 失败 2/);
  assert.equal(fixture.document.getElementById('export').disabled, false);
  assert.equal(fixture.document.getElementById('pause').hidden, true);
  assert.equal(fixture.document.getElementById('resume').hidden, false);
  assert.equal(fixture.document.getElementById('stop').disabled, false);
  const panel = fixture.document.getElementById('links-panel');
  panel.open = true;
  panel.dispatchEvent(new fixture.document.defaultView.Event('toggle'));
  assert.match(panel.textContent, /详情状态/);
  assert.match(fixture.document.getElementById('link-rows').textContent, /部分/);
  assert.match(fixture.document.getElementById('link-rows').textContent, /仅采集到基础商品信息/);
  assert.match(fixture.document.getElementById('link-rows').textContent, /详情解析失败/);
});

test('search progress wording remains unchanged', async () => {
  const fixture = await managerFixture();
  const job = fixture.saved.task.jobs[0];
  job.status = 'running'; job.phase = 'search'; job.scanned = 43;
  job.groups = [{ best: { id: 'one', title: '相机', cents: 100, url: 'https://example.com' } }];
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  assert.equal(fixture.document.getElementById('current-detail').textContent, '已扫描 43 / 200 条 · 1 组主图 · 保留 1 / 20 条');
});
test('finished detail jobs explain completed and failed detail counts unless a job note exists', async () => {
  const fixture = await managerFixture();
  const job = fixture.saved.task.jobs[0];
  fixture.saved.task.status = 'done'; job.status = 'done'; job.phase = 'done'; job.detailDone = 2;
  job.groups = [
    { best: { id: 'done', title: '相机完成', cents: 100, detailStatus: 'done' } },
    { best: { id: 'partial', title: '相机部分', cents: 100, detailStatus: 'partial' } },
    { best: { id: 'error', title: '相机失败', cents: 100, detailStatus: 'error' } }
  ];
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  assert.match(fixture.document.getElementById('result-rows').textContent, /详情完整 1 个 · 部分 1 个 · 失败 1 个/);
  fixture.saved.task.jobs[0].note = '原有说明优先';
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  assert.match(fixture.document.getElementById('result-rows').textContent, /原有说明优先/);
});

test('show collection tab prefers the preserved blocked detail tab', async () => {
  const fixture = await managerFixture(task => { task.tabId = 42; task.detailTabId = 77; });
  fixture.click('show-tab');
  await tick();
  assert.deepEqual(fixture.activatedTabs, [77]);
});

test('stop and clear force-close a preserved detail tab', async () => {
  const stopFixture = await managerFixture(task => {
    task.status = 'blocked'; task.jobs[0].status = 'blocked'; task.detailTabId = 77; task.detailGoodsId = '123';
  });
  stopFixture.click('stop');
  await tick(); await tick();
  assert.deepEqual(stopFixture.removedTabs, [77]);
  assert.equal(stopFixture.saved.task.detailTabId, undefined);

  const clearFixture = await managerFixture(task => { task.detailTabId = 88; task.detailGoodsId = '456'; });
  clearFixture.click('clear-all');
  await tick(); await tick();
  assert.deepEqual(clearFixture.removedTabs, [88]);
  assert.equal(clearFixture.saved.task, null);
});

test('an unsupported collection address does not add a name or open a tab', async () => {
  const { document, window } = parseHTML(html);
  const saved = { keywords: [], task: null };
  let tabCreates = 0;
  globalThis.document = document;
  globalThis.window = window;
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    storage: { local: { async get() { return saved; }, async set(values) { Object.assign(saved, values); } } },
    tabs: { async create() { tabCreates++; throw new Error('不应打开采集页'); } }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, callback) => callback({}) } } });
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  document.getElementById('source-url').value = 'https://example.com/search';
  document.getElementById('keyword-input').value = '相机';
  document.getElementById('add-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.deepEqual(saved.keywords, []);
  assert.equal(saved.task, null);
  assert.equal(tabCreates, 0);
  assert.match(document.getElementById('notice').textContent, /暂不支持|还不能采集/);
});
