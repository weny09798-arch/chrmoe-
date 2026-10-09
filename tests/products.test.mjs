import test from 'node:test';
import assert from 'node:assert/strict';
import * as products from '../extension/lib/products.mjs';
import { createTask, enqueueKeyword, addCandidate, retryJob, selected, recoverTask } from '../extension/lib/core.mjs';
import { taskSheets } from '../extension/lib/xlsx.mjs';
import { Runner } from '../extension/lib/runner.mjs';

const fp = color => ({ bits: '0000000000000000', color: [color, 100, 100], spread: 50 });
const item = (id, color = 100) => ({ id, title: '相机商品', cents: 1000,
  image: `https://img.pddpic.com/${id}.jpg`, url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`, fingerprint: fp(color) });
function fixture() {
  const task = createTask(['相机']); const job = task.jobs[0]; job.limit = 2;
  addCandidate(job, { ...item('2'), cents: 900 });
  addCandidate(job, { ...item('3', 250), descriptionText: '保留详情', detailStatus: 'done' });
  job.seen = ['1', '2', '3']; job.scanned = 200; job.phase = 'done'; job.status = 'done'; task.status = 'done';
  return { task, job };
}
test('preview selects the first safe gallery image and falls back to the search image', () => {
  assert.equal(products.productImage({ galleryImages: ['javascript:alert(1)', 'https://img.pddpic.com/main.jpg', 'https://img.pddpic.com/second.jpg'], image: 'https://img.pddpic.com/search.jpg' }), 'https://img.pddpic.com/main.jpg');
  assert.equal(products.productImage({ image: 'https://img.pddpic.com/search.jpg' }), 'https://img.pddpic.com/search.jpg');
  assert.equal(products.productImage({ image: 'http://unsafe.example/a.jpg' }), '');
});
test('deleting a product excludes its ID but permits different IDs with similar art', () => {
  const { task, job } = fixture();
  assert.equal(products.removeProduct(job, '2'), true);
  assert.deepEqual(selected(job).map(x => x.id), ['3']);
  assert.equal(job.groups[0].best.descriptionText, '保留详情');
  assert.equal(products.removeProduct(job, '2'), false);
  const persisted = JSON.parse(JSON.stringify(task)); const restored = persisted.jobs[0];
  assert.equal(addCandidate(restored, { ...item('2', 350), cents: 100 }), false);
  assert.equal(addCandidate(restored, { ...item('8'), cents: 100 }), true);
  assert.equal(addCandidate(restored, { ...item('9', 350), image: 'https://img.pddpic.com/2.jpg' }), true);
  assert.deepEqual(taskSheets(persisted)[0].rows.slice(9).map(row => row[6]), ['3','8']);
  assert.equal(restored.refillRequested, true);
});
test('refill preserves history, details, filters and target while renewing the scan budget', () => {
  const { job } = fixture(); job.priceMin = 500; job.priceMax = 5000;
  job.site='taobao';
  job.merged=8;job.excluded=2;job.skipReasons={'价格未识别':3};
  products.removeProduct(job, '2'); products.prepareRefill(job);
  assert.equal(job.scanned, 0); assert.deepEqual(job.seen, ['1', '2', '3']);
  assert.equal(job.merged,0);assert.equal(job.excluded,0);assert.deepEqual(job.skipReasons,{});
  assert.equal(job.limit, 2); assert.equal(job.priceMin, 500); assert.equal(job.priceMax, 5000);
  assert.equal(job.phase, 'search'); assert.equal(job.status, 'pending'); assert.equal(job.refillRequested, false);
  assert.equal(job.groups[0].best.detailStatus, 'done');
  addCandidate(job, { ...item('10', 250), cents: 100 });
  assert.equal(job.groups[0].best.id, '3');
  assert.equal(job.groups[0].best.descriptionText, '保留详情');
});

test('PDD refill preserves its scan budget and requests no search reload, while manual retry can reload',()=>{
  const {task,job}=fixture();job.scrolls=12;
  products.removeProduct(job,'2',task);products.prepareRefill(job);
  assert.equal(job.scanned,200);assert.equal(job.scrolls,12);assert.deepEqual(job.seen,['1','2','3']);assert.equal(job.restartSearch,false);
  retryJob(task,0);assert.equal(task.jobs[0].restartSearch,true);assert.equal(task.jobs[0].scanned,0);
});

test('a deleted ID remains excluded when numeric data is rediscovered as a string',()=>{
  const task=createTask(['相机']);const job=task.jobs[0];
  addCandidate(job,item(123));products.removeProduct(job,123,task);
  const restored=recoverTask(JSON.parse(JSON.stringify(task)));
  assert.equal(addCandidate(restored.jobs[0],item('123'),restored),false);
});

test('deleting a product excludes it across names and later jobs, without confusing source platforms',async()=>{
  const task=createTask(['相机','相机配件']);
  for(const job of task.jobs){addCandidate(job,item('123'));addCandidate(job,item('456'));}
  products.removeProduct(task.jobs[0],'123',task);
  assert.deepEqual(selected(task.jobs[1]).map(x=>x.id),['456']);
  const restored=recoverTask(JSON.parse(JSON.stringify(task)));
  enqueueKeyword(restored,'新相机','pdd',{limit:1});const other=restored.jobs[2];
  for(const job of restored.jobs.slice(0,2))job.status='done';
  await new Runner(restored,{authorize:async()=>({allowed:true}),save:async()=>{},update(){},open:async()=>{},close:async()=>{},
    read:async()=>({cards:['123','789'].map(id=>({...item(id),key:id,priceText:'¥10'})),end:true}),
    enrich:async()=>({detailStatus:'done',attributes:[{name:'材质',value:'塑料'}]})}).run();
  assert.deepEqual(selected(other).map(x=>x.id),['789']);
  enqueueKeyword(restored,'相机','taobao');
  assert.equal(addCandidate(restored.jobs[3], {...item('123'),site:'taobao'},restored),true);
});

test('automatic refill pause preserves a verification response and manual stop stays stopped', async () => {
  for (const intent of ['automatic', 'stop']) {
    const { task, job } = fixture(); job.status = 'pending'; job.phase = 'search'; job.scanned = 0; job.limit = 3;
    let collector;
    collector = new Runner(task, {
    authorize:async()=>({allowed:true}),
      open: async () => {}, close: async () => {}, save: async () => {}, update() {},
      read: async () => {
        if (intent === 'stop') collector.stop();
        collector.pauseForRefill();
        return { blocked: true, reason: '请完成验证码', cards: [] };
      }
    });
    await collector.run();
    assert.equal(task.status, intent === 'automatic' ? 'blocked' : 'stopped');
    assert.equal(job.status, task.status);
  }
});

test('deleting the running detail cancels further reads and discards its late result',async()=>{
  const {task,job}=fixture();job.phase='detail';job.status='pending';
  const deleted=selected(job)[0];let cancelledAfterDelete=false,runner;
  runner=new Runner(task,{authorize:async()=>({allowed:true}),save:async()=>{},update(){},close:async()=>{},
    enrich:async(value,currentTask,cancelled)=>{
      products.removeProduct(job,value.id,currentTask);runner.pauseForRefill();
      cancelledAfterDelete=cancelled?.()===true;
      return {descriptionText:'deleted late result'};
    }});
  await runner.run();
  assert.equal(cancelledAfterDelete,true);
  assert.notEqual(deleted.descriptionText,'deleted late result');
  assert.deepEqual(selected(job).map(i=>i.id),['3']);
  assert.equal(task.status,'paused');assert.equal(job.refillRequested,true);
});

test('a removed queued detail is skipped even when selected before the removal',async()=>{
  const {task,job}=fixture();job.phase='detail';job.status='pending';
  selected(job)[1].detailStatus='pending';const ids=[];let now=10000;
  await new Runner(task,{authorize:async()=>({allowed:true}),save:async()=>{},update(){},close:async()=>{},wait:async ms=>{now+=ms;},now:()=>now,
    enrich:async(value)=>{ids.push(value.id);products.removeProduct(job,'3',task);return {attributes:[{name:'材质',value:'棉'}]};}
  }).enrich(job);
  assert.deepEqual(ids,['2']);
});

test('deleting another item for refill does not discard the still-wanted detail in progress',async()=>{
  const {task,job}=fixture();job.phase='detail';job.status='pending';let runner,wasCancelled;
  runner=new Runner(task,{authorize:async()=>({allowed:true}),save:async()=>{},update(){},close:async()=>{},
    enrich:async(value,currentTask,cancelled)=>{products.removeProduct(job,'3',currentTask);runner.pauseForRefill();wasCancelled=cancelled();return {attributes:[{name:'材质',value:'棉'}]};}
  });
  await runner.run();assert.equal(wasCancelled,false);assert.equal(selected(job)[0].detailStatus,'done');
});
test('manual retry and recovery retain exclusions and a persisted refill request', () => {
  const { task, job } = fixture(); products.removeProduct(job, '2');
  const recovered = recoverTask(JSON.parse(JSON.stringify(task)));
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.jobs[0].phase, 'search');
  assert.equal(recovered.jobs[0].scanned, 200);
  retryJob(recovered, 0);
  assert.equal(addCandidate(recovered.jobs[0], item('2')), false);
  assert.equal(addCandidate(recovered.jobs[0], item('4')), true);
});

test('legacy per-keyword deletions are also excluded in a newly added keyword after recovery',()=>{
  const task=createTask(['相机']);task.jobs[0].exclusions=[{ids:[123]}];
  const restored=recoverTask(JSON.parse(JSON.stringify(task)));
  enqueueKeyword(restored,'相机配件','pdd');
  assert.equal(addCandidate(restored.jobs[1],item('123'),restored),false);
});
test('refill reaches the saved target with retained details and permits cheap different IDs', async () => {
  const { task, job } = fixture(); job.scanned=3; products.removeProduct(job, '2'); products.prepareRefill(job);
  let reads = 0; const details = [];
  await new Runner(task, {
    authorize:async()=>({allowed:true}),
    open: async () => {}, close: async () => {}, save: async () => {}, update() {}, scroll: async () => {}, wait: async () => {},
    read: async () => { reads++; return { cards: ['1','2','3','4','5','6'].map(id => ({ ...item(id), key: id, priceText: '¥8.00' })), end: false }; },
    hash: async url => fp(url.endsWith('5.jpg') || url.endsWith('6.jpg') ? 400 : 100),
    enrich: async value => { details.push(value.id); return { descriptionText: '新详情' }; }
  }).run();
  assert.deepEqual(selected(job).map(x => x.id), ['3', '4']);
  assert.equal(reads, 1); assert.equal(job.scanned, 4); assert.equal(job.status, 'done');
  assert.deepEqual(details, ['4']); assert.equal(job.groups[0].best.descriptionText, '保留详情');
});

test('a PDD refill at the scan cap reports a shortage without rereading or refreshing',async()=>{
  const {task,job}=fixture();products.removeProduct(job,'2');products.prepareRefill(job);let reads=0,details=0;
  await new Runner(task,{authorize:async()=>({allowed:true}),save:async()=>{},update(){},open:async()=>{},close:async()=>{},read:async()=>{reads++;throw new Error('must not read');},enrich:async()=>details++}).run();
  assert.equal(reads,0);assert.equal(details,0);assert.equal(job.status,'short');assert.deepEqual(selected(job).map(x=>x.id),['3']);
  assert.match(job.note,/200条上限/);
});
