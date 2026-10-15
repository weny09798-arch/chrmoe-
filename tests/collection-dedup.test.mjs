import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../extension/lib/core.mjs';
const dedup = await import('../extension/lib/product-dedup.mjs').catch(() => ({}));
import { removeProduct, prepareRefill } from '../extension/lib/products.mjs';
import { Runner } from '../extension/lib/runner.mjs';
import { taskSheets } from '../extension/lib/xlsx.mjs';
import { buildImageManifest } from '../extension/lib/image-conversion.mjs';
const item = (id, image='https://img.pddpic.com/a.jpg') => ({id,title:'测试商品',cents:100,url:`https://mobile.yangkeduo.com/goods.html?goods_id=${id}`,image});
const card = id => ({...item(id,`https://img.pddpic.com/${id}.jpg`),key:id,priceText:'¥1'});
function ports(pages,more={}) {let index=0,time=1000; return {open:async()=>{},read:async()=>pages[Math.min(index++,pages.length-1)],enrich:async()=>({}),scroll:async()=>{},save:async()=>{},update(){},close:async()=>{},now:()=>time,wait:async ms=>{time+=ms;},hash:async url=>({sha256:url}),...more};}
test('new options default on, current source persists, old recovered jobs stay off', () => {
  const job=core.enqueueKeyword(null,'测试','taobao',{sourceMode:'current',sourceTabId:7,taobaoDetailIntervalMs:1}).jobs[0];
  assert.equal(job.imageDedup,true); assert.equal(job.sourceMode,'current'); assert.equal(job.sourceTabId,7); assert.equal(job.taobaoDetailIntervalMs,10000);
  const old={version:1,status:'done',jobs:[{keyword:'测试',status:'done',groups:[]}]};
  assert.equal(core.recoverTask(old).jobs[0].imageDedup,false);
});
test('same image retains first and independent members; restoration survives rehash and limit',async()=>{
  const job=core.enqueueKeyword(null,'测试','pdd',{limit:1}).jobs[0];
  core.addCandidate(job,item('1')); core.addCandidate(job,item('2'));
  const hash=async()=>({sha256:'same'});
  await dedup.deduplicate(job,hash);
  assert.deepEqual(core.selected(job).map(x=>x.id),['1']);
  assert.equal(dedup.duplicateItems(job)[0].item.id,'2');
  assert.equal(dedup.restoreDuplicate(job,'2'),true);
  await dedup.deduplicate(job,hash);
  assert.deepEqual(core.selected(job).map(x=>x.id),['1','2']);
  assert.equal(removeProduct(job,'1'),true); assert.equal(core.selected(job)[0].id,'2');
});
test('deleting representative promotes only its own duplicate with its SKU identity',async()=>{
  const job=core.enqueueKeyword(null,'测试').jobs[0];
  core.addCandidate(job,{...item('1'),skus:[{id:'sku1'}]}); core.addCandidate(job,{...item('2'),skus:[{id:'sku2'}]});
  await dedup.deduplicate(job,async()=>({sha256:'same'}));
  removeProduct(job,'1'); assert.equal(job.groups[0].best.id,'2'); assert.equal(job.groups[0].best.skus[0].id,'sku2');
});
test('hash failure keeps items and original list image cannot be replaced by detail',async()=>{
  const job=core.enqueueKeyword(null,'测试').jobs[0]; core.addCandidate(job,item('1')); core.addCandidate(job,item('2'));
  await dedup.deduplicate(job,async()=>{throw Error('timeout');});
  assert.equal(job.groups.length,2); assert.match(job.groups[0].best.imageDedupNote,/保留/);
  job.groups[0].best.image='https://oss.example/replaced.png';
  assert.equal(job.groups[0].best.originalListImage,'https://img.pddpic.com/a.jpg');
});
test('current capture only runs requested job, accepts no price, exports and converts unrelated title',async()=>{
  const task=core.enqueueKeyword(null,'等待'); task.jobs[0].status='paused';
  core.enqueueKeyword(task,'当前商品 · 标签','taobao',{sourceMode:'current',sourceTabId:7}); const job=task.jobs[1];
  const runner=new Runner(task,{save:async()=>{},update(){},close:async()=>{},current:async()=>({...item('7'),title:'完全独立名称',cents:null,site:'taobao',detailStatus:'partial'}),open(){throw Error('opened search');}});
  await runner.run(job);
  assert.equal(task.jobs[0].status,'paused'); assert.equal(core.selected(job)[0].cents,null);
  assert.equal(taskSheets(task)[0].rows[9][17],''); assert.equal(buildImageManifest(task)[0].product_id,'7');
});
test('image dedup replenishes and late missing-image detail merge continues with seen preserved',async()=>{
  const task=core.enqueueKeyword(null,'测试','pdd',{limit:2}); const job=task.jobs[0];
  const a={...card('1'),image:''},b={...card('2'),image:''};
  await new Runner(task,ports([{cards:[a,b],end:false},{cards:[a,b,card('3')],end:true}],{
    enrich:async current=>({galleryImages:[`https://img.pddpic.com/${current.id==='3'?'other':'same'}.jpg`]}),
    hash:async url=>({sha256:url.includes('other') || url.includes('/3.')?'other':'same'})
  })).run();
  assert.deepEqual(core.selected(job).map(x=>x.id),['1','3']); assert.deepEqual(job.seen,['1','2','3']); assert.equal(job.scanned,3); assert.equal(dedup.duplicateItems(job)[0].item.id,'2');
});
test('five consecutive failed names or links block; price filtering does not count',async()=>{
  const task=core.enqueueKeyword(null,'测试');
  await new Runner(task,ports([{cards:Array.from({length:6},(_,n)=>({...card(String(n)),title:''})),end:true}])).run();
  assert.equal(task.status,'blocked'); assert.equal(task.jobs[0].scanned,5);
  const filtered=core.enqueueKeyword(null,'测试','pdd',{priceMin:200});
  await new Runner(filtered,ports([{cards:Array.from({length:6},(_,n)=>card(String(n))),end:true}])).run();
  assert.equal(filtered.jobs[0].status,'short'); assert.equal(filtered.jobs[0].scanned,6);
});
test('Taobao minimum detail interval survives recovery and current cancellation writes no result',async()=>{
  const task=core.enqueueKeyword(null,'测试','taobao',{limit:2}); let time=1000; const times=[]; let runner;
  runner=new Runner(task,ports([{cards:[card('1'),card('2')],end:true}],{now:()=>time,wait:async ms=>{time+=ms;runner.pause();},enrich:async()=>{times.push(time);return {};}}));
  await runner.run(); assert.deepEqual(times,[1000]);
  const restored=core.recoverTask(JSON.parse(JSON.stringify(task)));
  await new Runner(restored,ports([],{now:()=>time,wait:async ms=>{time+=ms;},enrich:async()=>{times.push(time);return {};}})).run();
  assert.deepEqual(times,[1000,11000]);
  const manual=core.enqueueKeyword(null,'当前','taobao',{sourceMode:'current',sourceTabId:7}); let capture;
  capture=new Runner(manual,ports([],{current:async()=>{capture.pause();return item('1');}}));
  await capture.run(manual.jobs[0]); assert.equal(manual.jobs[0].groups.length,0);
});
test('comparison is representative only and restored duplicate is exempt after JSON recovery',async()=>{
  const job=core.enqueueKeyword(null,'测试').jobs[0];
  for (const id of ['1','2','3']) core.addCandidate(job,item(id,`https://img.pddpic.com/${id}.jpg`));
  const values={'1':'0000000000000000','2':'000000000000003f','3':'0000000000000fff'};
  await dedup.deduplicate(job,async url=>({fingerprint:{bits:values[url.match(/\/(\d)\.jpg/)[1]],color:[100,100,100],spread:50}}));
  assert.deepEqual(job.groups.map(g=>g.best.id),['1','3']); dedup.restoreDuplicate(job,'2');
  const restored=JSON.parse(JSON.stringify(job)); await dedup.deduplicate(restored,async()=>{throw Error('cached expected');});
  assert.deepEqual(core.selected(restored).map(x=>x.id),['1','3','2']);
});
test('recovery excludes only real deleted ID and keeps other image group members',async()=>{
  const task=core.enqueueKeyword(null,'测试'); const job=task.jobs[0];
  core.addCandidate(job,item('1'));core.addCandidate(job,item('2'));await dedup.deduplicate(job,async()=>({sha256:'same'}));
  task.exclusions=[{site:'pdd',ids:['1']}];
  const recovered=core.recoverTask(JSON.parse(JSON.stringify(task)));
  assert.equal(core.selected(recovered.jobs[0])[0].id,'2');
});
test('manual retry preserves current identity and dedup settings and avoids restarting search',()=>{
  const task=core.enqueueKeyword(null,'当前','taobao',{sourceMode:'current',sourceTabId:7,sourceProductId:'99',imageDedup:false});
  const retried=core.retryJob(task,0); assert.equal(retried.sourceProductId,'99');assert.equal(retried.sourceMode,'current');assert.equal(retried.imageDedup,false);assert.equal(retried.restartSearch,false);
});
test('recovery retains blocked preflight context before status becomes paused',()=>{
  const task=core.enqueueKeyword(null,'测试');task.status='blocked';task.jobs[0].status='blocked';
  const recovered=core.recoverTask(JSON.parse(JSON.stringify(task)));
  assert.equal(recovered.wasBlocked,true);assert.equal(recovered.jobs[0].wasBlocked,true);
});
test('missing images keep independent result with visible pending dedup note until details supply image',async()=>{
  const job=core.enqueueKeyword(null,'测试').jobs[0];core.addCandidate(job,item('1',''));
  await dedup.deduplicate(job,async()=>{throw Error('should not fetch');});
  assert.match(job.groups[0].best.imageDedupNote,/未读到主图/);assert.equal(job.imageDedupFailures,1);
  job.groups[0].best.galleryImages=['https://img.pddpic.com/detail.jpg'];
  await dedup.deduplicate(job,async()=>({sha256:'detail'}));assert.equal(job.groups[0].best.imageDedupNote,'');assert.equal(job.imageDedupFailures,0);
});
test('stopping only current capture preserves unrelated paused search and task resumability',async()=>{
  const task=core.enqueueKeyword(null,'测试');task.jobs[0].status='paused';
  core.enqueueKeyword(task,'当前','taobao',{sourceMode:'current',sourceTabId:7});const current=task.jobs[1];let runner;
  runner=new Runner(task,ports([],{current:async()=>{runner.stop();return item('7');}}));
  await runner.run(current);
  assert.equal(task.jobs[0].status,'paused');assert.equal(current.status,'stopped');assert.equal(task.status,'paused');assert.equal(current.groups.length,0);
});
test('deleted current product never schedules refill and excluded capture cannot restore it',async()=>{
  const task=core.enqueueKeyword(null,'当前','taobao',{sourceMode:'current',sourceTabId:7});const job=task.jobs[0];
  const io=ports([],{current:async()=>({...item('7'),site:'taobao'})});
  await new Runner(task,io).run(job);removeProduct(job,'7',task);
  assert.equal(job.refillRequested,false);assert.equal(prepareRefill(job),false);assert.equal(job.status,'done');
  job.refillRequested=true;assert.equal(prepareRefill(job),false);assert.equal(job.refillRequested,false);
  job.status='pending';await new Runner(task,io).run(job);
  assert.equal(job.groups.length,0);assert.equal(job.status,'done');assert.match(job.note,/排除|删除/);
});

