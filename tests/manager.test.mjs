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

async function managerFixture() {
  const { document, window } = parseHTML(html);
  const task = createTask(['相机']);
  task.status = 'paused'; task.jobs[0].status = 'paused'; task.permissionOrigin = 'https://img.pddpic.com/*';
  let decidePermission, tabCreates = 0, permissionRequests = 0;
  const permission = new Promise(resolve => { decidePermission = resolve; });
  const saved = { keywords: ['相机'], task };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    storage: { local: { async get() { return saved; }, async set(values) { Object.assign(saved, values); } } },
    permissions: { request: async () => { permissionRequests++; return permission; } },
    tabs: { async create() { tabCreates++; throw new Error('unexpected collection'); } }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, callback) => callback({}) } } });
  await import(`../extension/manager.mjs?case=${Math.random()}`);
  await tick();
  const click = id => document.getElementById(id).dispatchEvent(new window.Event('click'));
  return { document, saved, click, decidePermission, get tabCreates() { return tabCreates; }, get permissionRequests() { return permissionRequests; } };
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
