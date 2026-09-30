import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, createTask, addCandidate, selected, addKeyword } from '../extension/lib/core.mjs';
import * as core from '../extension/lib/core.mjs';
import { fingerprint, similar } from '../extension/lib/fingerprint.mjs';

const fp = n => ({ bits: n ? 'f'.repeat(16) : '0'.repeat(16), color: [120, 130, 140], spread: 50 });
const item = (id, cents, n=0) => ({ id, cents, title: '相机', url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`, image: `https://img.pddpic.com/${id}.jpg`, fingerprint: fp(n) });
test('price extraction ignores promotions and sales counts', () => {
  assert.equal(parsePrice('立减20元 即将恢复价 券后¥29.88 本店已拼7万'), 2988);
  assert.equal(parsePrice('¥1,299.90'), 129990);
  assert.equal(parsePrice('券后 ￥ 32'), 3200);
  assert.equal(parsePrice('已拼7万'), null);
  assert.equal(parsePrice('¥20-30'), null);
  assert.equal(parsePrice('¥20起'), null);
  assert.equal(parsePrice('¥29.88 ¥32'), null);
  assert.equal(parsePrice('¥0'), null);
  assert.equal(parsePrice('优惠券¥5 售价39元'), null);
  assert.equal(parsePrice('优惠券：¥5 售价39元'), null);
  assert.equal(parsePrice('¥5优惠券 售价39元'), null);
  assert.equal(parsePrice('券后 ¥ 29\n.88'), 2988);
});
test('different IDs remain in discovery order even if their images match and another is cheaper', () => {
  const job=createTask(['相机']).jobs[0];
  addCandidate(job,item('1',3200)); addCandidate(job,item('2',5000,1)); addCandidate(job,item('3',2988));
  assert.deepEqual(selected(job).map(x=>x.id),['1','2','3']);
  assert.equal(selected(job)[2].cents,2988);
});
test('same ID never creates a second group, and serialised checkpoint still deduplicates', () => {
  let job=createTask(['相机']).jobs[0];
  addCandidate(job,item('1',3200));
  job=JSON.parse(JSON.stringify(job));
  addCandidate(job,item('1',3000,1));
  assert.equal(selected(job).length,1);
  assert.equal(selected(job)[0].cents,3000);
});
test('output is capped at 20 and a cheaper different ID does not displace retained IDs', () => {
  const job=createTask(['相机']).jobs[0];
  for(let n=0;n<25;n++) addCandidate(job,{...item(String(n),4000),fingerprint:{bits:'0'.repeat(16),color:[n*100,0,0],spread:50}});
  addCandidate(job,{...item('cheap',1000),fingerprint:{bits:'0'.repeat(16),color:[0,0,0],spread:50}});
  assert.equal(job.groups.length,26); assert.equal(selected(job).length,20); assert.equal(selected(job)[0].id,'0');
});
test('a smaller limit keeps that many, and a price range is inclusive', () => {
  const job=createTask(['相机']).jobs[0];
  job.limit=10;
  for(let n=0;n<12;n++) addCandidate(job,{...item(String(n),4000),fingerprint:{bits:'0'.repeat(16),color:[n*100,0,0],spread:50}});
  assert.equal(selected(job).length,10);
  assert.equal(core.normalizePriceCents(''),null);
  assert.equal(core.normalizePriceCents('10.5'),1050);
  assert.equal(core.normalizePriceCents('0'),null);
  assert.equal(core.priceAllowed(1000,{priceMin:1000,priceMax:4000}),true);
  assert.equal(core.priceAllowed(999,{priceMin:1000,priceMax:4000}),false);
  assert.equal(core.priceAllowed(4001,{priceMin:1000,priceMax:4000}),false);
  assert.equal(core.priceAllowed(50,{}),true);
  const task=core.enqueueKeyword(null,'相机','pdd',{limit:10,priceMin:1000,priceMax:5000});
  assert.equal(task.jobs[0].limit,10);
  assert.equal(task.jobs[0].priceMin,1000);
  task.jobs[0].status='done';
  core.retryJob(task,0);
  assert.equal(task.jobs[0].limit,10);
  assert.equal(task.jobs[0].priceMax,5000);
  assert.equal(task.jobs[0].groups.length,0);
});
test('keywords trim, persist without duplication and reject empty values', () => {
  const list=[]; addKeyword(list,'  相机  '); addKeyword(list,'相机'); addKeyword(list,'');
  assert.deepEqual(list,['相机']);
});
test('name relevance requires a shared letter, not merely a shared sales digit', () => {
  assert.equal(typeof core.titleRelatedToKeyword,'function');
  assert.equal(core.titleRelatedToKeyword('高清数码相机','相机'),true);
  assert.equal(core.titleRelatedToKeyword('未发货秒退','苹果手机壳'),false);
  assert.equal(core.titleRelatedToKeyword('蓝牙音箱','苹果手机壳'),false);
  assert.equal(core.titleRelatedToKeyword('1万+人好评','iPhone 16'),false);
  assert.equal(core.titleRelatedToKeyword('iPhone 手机壳','IPHONE 16'),true);
});
test('a service badge is not a product title even when it shares a search character', () => {
  assert.equal(typeof core.validProductTitle,'function');
  assert.equal(core.validProductTitle('未发货秒退','退款'),false);
  assert.equal(core.validProductTitle('本店已拼500万+','本店商品'),false);
  for (const badge of ['本店已拼17.8万+','本店已拼92.7万+','本店已拼2.8万']) {
    assert.equal(core.validProductTitle(badge,'本店商品'),false);
  }
  assert.equal(core.validProductTitle('退款保障手机壳','手机壳'),true);
});
test('adding a keyword creates or extends one cumulative task without losing results', () => {
  assert.equal(typeof core.enqueueKeyword,'function');
  const task=core.enqueueKeyword(null,'相机');
  task.jobs[0].status='done';addCandidate(task.jobs[0],item('1',2988));task.status='done';
  assert.equal(core.enqueueKeyword(task,'书包'),task);
  assert.deepEqual(task.jobs.map(job=>job.keyword),['相机','书包']);
  assert.equal(selected(task.jobs[0])[0].id,'1');
  assert.equal(task.jobs[1].status,'pending');assert.equal(task.status,'pending');
});
test('retrying one name clears only its old results and keeps other names', () => {
  assert.equal(typeof core.retryJob,'function');
  const task=createTask(['相机','书包']);
  addCandidate(task.jobs[0],item('1',2988));addCandidate(task.jobs[1],item('2',3988));
  task.jobs[0].status='short';task.jobs[1].status='done';task.status='done';
  core.retryJob(task,0);
  assert.equal(task.jobs[0].status,'pending');assert.equal(task.jobs[0].groups.length,0);
  assert.equal(task.jobs[0].scanned,0);assert.equal(task.status,'pending');
  assert.equal(selected(task.jobs[1])[0].id,'2');
});
test('new and retried jobs begin in search with no detail progress', () => {
  const task=createTask(['相机']);
  assert.deepEqual([task.jobs[0].phase,task.jobs[0].detailDone,task.jobs[0].searchStatus],['search',0,'']);
  task.jobs[0].phase='done';task.jobs[0].detailDone=1;
  const retried=core.retryJob(task,0);
  assert.deepEqual([retried.phase,retried.detailDone,retried.searchStatus],['search',0,'']);
});
test('recoverTask preserves search progress and resumes only missing legacy details', () => {
  const task=createTask(['相机']);const job=task.jobs[0];
  addCandidate(job,item('1',2988));addCandidate(job,item('2',3988,1));
  job.groups[0].best.descriptionText='已有详情';job.groups[1].best.detailStatus='error';
  job.seen=['1','2'];job.scanned=2;job.status='short';task.status='done';
  core.recoverTask(task);
  assert.equal(job.groups[0].best.detailStatus,'done');
  assert.equal(job.groups[1].best.detailStatus,'error');
  assert.deepEqual(job.seen,['1','2']);assert.equal(job.scanned,2);
  assert.equal(job.status,'short');assert.equal(task.status,'done');
  delete job.groups[1].best.detailStatus;
  core.recoverTask(task);
  assert.equal(job.groups[1].best.detailStatus,'pending');
  assert.deepEqual([job.phase,job.searchStatus,job.status,task.status],['detail','short','paused','paused']);
  assert.equal(job.detailDone,1);
});
test('legacy product with only a category remains pending for detail recovery', () => {
  const task=createTask(['相机']);const job=task.jobs[0];
  addCandidate(job,{...item('1',2988),category:'数码相机'});
  job.status='short';task.status='done';
  core.recoverTask(task);
  assert.equal(selected(job)[0].detailStatus,'pending');
  assert.deepEqual([job.phase,job.status,task.status],['detail','paused','paused']);
});
test('legacy product with only a distinct gallery image remains pending', () => {
  const task=createTask(['相机']);const job=task.jobs[0];
  addCandidate(job,{...item('1',2988),galleryImages:['https://img.pddpic.com/another.jpg']});
  job.status='short';task.status='done';
  core.recoverTask(task);
  assert.equal(selected(job)[0].detailStatus,'pending');
  assert.deepEqual([job.phase,job.status,task.status],['detail','paused','paused']);
});
test('image fingerprint matches slightly changed pixels but separates different art and colors', () => {
  const pixels=new Uint8ClampedArray(32*32*4);
  for(let y=0;y<32;y++) for(let x=0;x<32;x++){let k=(y*32+x)*4;pixels[k]=x*7;pixels[k+1]=y*7;pixels[k+2]=(x*y)%255;pixels[k+3]=255;}
  const changed=pixels.map((v,i)=>i%4===3?255:Math.min(255,v+2));
  const inverted=pixels.map((v,i)=>i%4===3?255:255-v);
  assert.ok(similar(fingerprint(pixels),fingerprint(changed)));
  assert.ok(!similar(fingerprint(pixels),fingerprint(inverted)));
  assert.ok(!similar({...fp(0),color:[255,0,0]}, {...fp(0),color:[0,0,255]}));
});
