import test from 'node:test';
import assert from 'node:assert/strict';
import {createTask,selected} from '../extension/lib/core.mjs';
import {Runner} from '../extension/lib/runner.mjs';

const card=(id,price)=>({id,title:'相机',url:`https://mobile.pinduoduo.com/goods.html?goods_id=${id}`,image:`https://img.pddpic.com/${id}.jpg`,priceText:`¥${price}`,key:id});
function ports(pages, overrides={}) {let i=0;return {open:async()=>{},read:async()=>pages[Math.min(i++,pages.length-1)],scroll:async()=>{},hash:async()=>({bits:'0000000000000000',color:[100,100,100],spread:50}),resolve:async c=>c,enrich:async()=>({}),save:async()=>{},update:()=>{},wait:async()=>{},...overrides};}
test('later cheaper listing wins and no-result completion is reported as short',async()=>{
  const task=createTask(['相机']); const r=new Runner(task,ports([{cards:[card('1',32)],end:false},{cards:[card('2',29.88)],end:true}]));
  await r.run();assert.equal(task.status,'done');assert.equal(task.jobs[0].status,'short');assert.equal(selected(task.jobs[0])[0].id,'2');
});
test('skips cards without a recognizable merchandise name before saving results',async()=>{
  const task=createTask(['相机']);const nameless={...card('1',29.88),title:''};
  await new Runner(task,ports([{cards:[nameless],end:true}])).run();
  assert.equal(task.jobs[0].skipped,1);assert.equal(task.jobs[0].groups.length,0);
  assert.match(task.jobs[0].lastSkip,/商品名称/);
});
test('skips a misleading title unrelated to the searched name before downloading its image',async()=>{
  const task=createTask(['苹果手机壳']);let hashes=0;
  const bad={...card('1',29.88),title:'未发货秒退'};
  await new Runner(task,ports([{cards:[bad],end:true}],{hash:async()=>{hashes++;return {bits:'0'.repeat(16),color:[100,100,100],spread:50};}})).run();
  assert.equal(task.jobs[0].groups.length,0);assert.equal(task.jobs[0].skipped,1);
  assert.equal(hashes,0);assert.match(task.jobs[0].lastSkip,/商品名称/);
});
test('verification pauses task and does not discard the existing results',async()=>{
  const task=createTask(['相机','书包']);const r=new Runner(task,ports([{cards:[card('1',32)]},{blocked:true,reason:'验证码',cards:[]}]));
  await r.run();assert.equal(task.status,'blocked');assert.equal(task.jobs[0].groups.length,1);assert.equal(task.jobs[1].status,'pending');
});
test('stalled loading is an error rather than claimed end of results',async()=>{
  const task=createTask(['相机']);await new Runner(task,ports([{cards:[],end:false}])).run();
  assert.equal(task.jobs[0].status,'error');assert.match(task.jobs[0].note,/加载|识别/);
});
test('resume passes previously scanned cards while the list advances',async()=>{
  const task=createTask(['相机']); const job=task.jobs[0];
  job.seen=Array.from({length:100},(_,i)=>String(i+1));job.scanned=100;task.status='paused';job.status='paused';
  const pages=Array.from({length:30},(_,i)=>({cards:[card(String(i+1),32)],position:i*400,end:false}));
  pages.push({cards:[card('101',29.88)],position:12000,end:true});
  await new Runner(task,ports(pages)).run();
  assert.equal(job.status,'short');assert.equal(job.scanned,101);assert.equal(selected(job)[0].id,'101');
});
test('resume replays one hundred distinct saved IDs before collecting a new card',async()=>{
  const task=createTask(['相机']);const job=task.jobs[0];
  job.seen=Array.from({length:100},(_,i)=>String(i+1));job.scanned=100;job.scrolls=25;task.status='paused';job.status='paused';
  const pages=job.seen.map((id,i)=>({cards:[card(id,32)],position:i*400,end:false}));
  pages.push({cards:[card('101',29.88)],position:40000,end:true});
  await new Runner(task,ports(pages)).run();
  assert.equal(job.status,'short');assert.equal(job.scanned,101);assert.equal(selected(job)[0].id,'101');
});
test('revisiting cards processed in the current run does not falsely stall a restored search',async()=>{
  const task=createTask(['相机']);
  const pages=[{cards:Array.from({length:10},(_,i)=>card(String(i+1),32)),position:0,end:false}];
  for(let i=1;i<=9;i++) pages.push({cards:[card(String(i),32)],position:i*400,end:false});
  pages.push({cards:[card('11',29.88)],position:4000,end:true});
  await new Runner(task,ports(pages)).run();
  assert.equal(task.jobs[0].status,'short');assert.equal(task.jobs[0].scanned,11);
});
test('advancing empty snapshots eventually stop without unbounded scrolling',async()=>{
  const task=createTask(['相机']);let reads=0;
  await new Runner(task,ports([],{read:async()=>({cards:[],position:reads++*400,end:false})})).run();
  assert.equal(task.jobs[0].status,'error');assert.ok(reads<100);
});
test('moving viewport over unchanged saved cards eventually stops',async()=>{
  const task=createTask(['相机']);const job=task.jobs[0];
  job.seen=Array.from({length:100},(_,i)=>String(i+1));job.scanned=100;job.scrolls=25;
  let reads=0;
  await new Runner(task,ports([],{read:async()=>({cards:job.seen.map(id=>card(id,32)),position:reads++*400,end:false})})).run();
  assert.equal(job.status,'error');assert.ok(reads<=35);
});
test('pause during image fetch does not mark candidate processed and resume loses no data',async()=>{
  const task=createTask(['相机']);let runner;
  runner=new Runner(task,ports([{cards:[card('1',32)],end:true}],{hash:async()=>{runner.pause();return {bits:'0'.repeat(16),color:[100,100,100],spread:50};}}));
  await runner.run();assert.equal(task.status,'paused');assert.equal(task.jobs[0].seen.length,0);
  await new Runner(JSON.parse(JSON.stringify(task)),ports([{cards:[card('1',32)],end:true}])).run();
});
test('scan cap is enforced before processing next card',async()=>{
  const task=createTask(['相机']);const cards=Array.from({length:230},(_,i)=>card(String(i+1),i+1));
  await new Runner(task,ports([{cards,end:true}])).run();assert.equal(task.jobs[0].scanned,200);
});
test('twenty distinct links immediately advance to the next product name',async()=>{
  const task=createTask(['相机','书包']);let reads=0;
  const first=Array.from({length:21},(_,i)=>card(String(i+1),29+i));
  const pages=[{cards:first,end:false},{cards:[{...card('100',50),title:'书包'}],end:true}];
  const custom=ports(pages,{
    read:async()=>pages[Math.min(reads++,pages.length-1)],
    hash:async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*40,0,0],spread:50})
  });
  await new Runner(task,custom).run();
  assert.equal(task.jobs[0].scanned,20);assert.equal(selected(task.jobs[0]).length,20);
  assert.match(task.jobs[0].note,/20条/);
  assert.equal(task.jobs[1].scanned,1);assert.equal(reads,2);
});
test('stopping leaves current and remaining jobs explicitly stopped',async()=>{
  const task=createTask(['相机','帽子']);let runner;
  runner=new Runner(task,ports([{cards:[card('1',32)]}],{hash:async()=>{runner.stop();return {};}}));
  await runner.run();assert.equal(task.status,'stopped');assert.deepEqual(task.jobs.map(x=>x.status),['stopped','stopped']);
});
test('twenty groups stop reads immediately and enrich in selected order',async()=>{
  const task=createTask(['相机']);const cards=Array.from({length:21},(_,i)=>card(String(i+1),i+1));
  let reads=0;const enriched=[];const events=[];
  const custom=ports([],{read:async()=>{reads++;events.push('read');return {cards,end:false};},
    hash:async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*40,0,0],spread:50}),
    enrich:async item=>{enriched.push(item.id);events.push(`enrich:${item.id}`);return {descriptionText:`详情${item.id}`};}});
  await new Runner(task,custom).run();
  assert.equal(reads,1);assert.deepEqual(enriched,Array.from({length:20},(_,i)=>String(i+1)));
  assert.equal(events.indexOf('enrich:1'),1);
  assert.equal(task.jobs[0].scanned,20);assert.equal(task.jobs[0].detailDone,20);
  assert.equal(task.jobs[0].phase,'done');assert.equal(task.jobs[0].status,'done');
  assert.ok(selected(task.jobs[0]).every(x=>x.detailStatus==='done'));
});
test('short search enriches basic-only results as partial',async()=>{
  const task=createTask(['相机']);let calls=0;
  await new Runner(task,ports([{cards:[card('1',32)],end:true}],{enrich:async()=>{calls++;return {title:'详情标题',galleryImages:['https://img.pddpic.com/1.jpg'],skus:[{id:'',specs:[],cents:3200,image:'https://img.pddpic.com/1.jpg',stock:''}]};}})).run();
  assert.equal(calls,1);assert.equal(task.jobs[0].status,'short');
  assert.equal(selected(task.jobs[0])[0].detailStatus,'partial');
  assert.match(selected(task.jobs[0])[0].detailNote,/基础商品信息/);
  assert.equal(task.jobs[0].detailDone,1);
});
test('ordinary detail error records item and proceeds to the next',async()=>{
  const task=createTask(['相机']);const ids=[];
  await new Runner(task,ports([{cards:[card('1',32),card('2',33)],end:true}],{
    hash:async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*100,0,0],spread:50}),
    enrich:async item=>{ids.push(item.id);if(item.id==='1')throw new Error('解析失败'.repeat(200));return {skus:[{id:'sku-2',specs:['蓝色'],cents:3300}]};}
  })).run();
  assert.deepEqual(ids,['1','2']);assert.deepEqual(selected(task.jobs[0]).map(x=>x.detailStatus),['error','done']);
  assert.equal(selected(task.jobs[0])[0].detailNote.length,500);assert.equal(task.jobs[0].detailDone,2);
  assert.match(task.jobs[0].note,/失败 1/);
});
test('blocked detail stays pending and resume skips completed items without reopening search',async()=>{
  const task=createTask(['相机']);let first;const closeCalls=[];
  const hashes=async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*100,0,0],spread:50});
  first=new Runner(task,ports([{cards:[card('1',32),card('2',33)],end:true}],{hash:hashes,
    enrich:async (item,currentTask)=>{assert.equal(currentTask,task);if(item.id==='2')throw Object.assign(new Error('验证码'),{blocked:true,permissionOrigin:'https://mobile.pinduoduo.com'});return {descriptionText:'已完成'};},
    close:async options=>closeCalls.push(options)
  }));
  await first.run();
  assert.equal(task.status,'blocked');assert.equal(task.jobs[0].phase,'detail');
  assert.deepEqual(selected(task.jobs[0]).map(x=>x.detailStatus),['done','pending']);
  assert.equal(task.jobs[0].detailDone,1);
  assert.deepEqual(closeCalls,[{preserveBlocked:true}]);
  const enriched=[];let opened=0,reads=0;
  await new Runner(task,ports([],{open:async()=>opened++,read:async()=>{reads++;throw new Error('unexpected read');},
    enrich:async item=>{enriched.push(item.id);return {attributes:[{name:'颜色',value:'蓝'}]};}})).run();
  assert.deepEqual(enriched,['2']);assert.equal(opened,0);assert.equal(reads,0);
  assert.equal(task.jobs[0].detailDone,2);assert.equal(task.jobs[0].status,'short');
});
test('pausing or stopping during detail always closes the detail tab',async()=>{
  for(const action of ['pause','stop']){
    const task=createTask(['相机']);let runner,closes=0;
    let closeOptions;
    runner=new Runner(task,ports([{cards:[card('1',32)],end:true}],{enrich:async()=>{runner[action]();return {descriptionText:'详情'};},close:async options=>{closes++;closeOptions=options;}}));
    await runner.run();assert.equal(task.status,action==='pause'?'paused':'stopped');assert.equal(closes,1);
    assert.deepEqual(closeOptions,{preserveBlocked:false});
  }
});
test('stop or pause wins when a detail verification response arrives at the same time',async()=>{
  for(const action of ['pause','stop']){
    const task=createTask(['相机']);let runner,release,started;
    const snapshotStarted=new Promise(resolve=>{started=resolve;});
    const closeOptions=[];
    runner=new Runner(task,ports([{cards:[card('1',32)],end:true}],{
      enrich:async()=>new Promise((resolve,reject)=>{release=()=>reject(Object.assign(new Error('请完成验证'),{blocked:true}));started();}),
      close:async options=>closeOptions.push(options)
    }));
    const running=runner.run();
    await snapshotStarted;
    runner[action]();
    release();
    await running;
    assert.equal(task.status,action==='pause'?'paused':'stopped');
    assert.equal(selected(task.jobs[0])[0].detailStatus,'pending');
    assert.deepEqual(closeOptions,[{preserveBlocked:false}]);
  }
});
test('a collection count of two stops at two distinct listings',async()=>{
  const task=createTask(['相机','书包']);
  task.jobs[0].limit=2;
  const first=Array.from({length:4},(_,i)=>card(String(i+1),29+i));
  const pages=[{cards:first,end:false},{cards:[{...card('100',50),title:'书包'}],end:true}];
  let reads=0;
  await new Runner(task,ports(pages,{
    read:async()=>pages[Math.min(reads++,pages.length-1)],
    hash:async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*40,0,0],spread:50})
  })).run();
  assert.equal(task.jobs[0].scanned,2);
  assert.equal(selected(task.jobs[0]).length,2);
  assert.match(task.jobs[0].note,/2条/);
  assert.equal(task.jobs[1].scanned,1);
});
test('a price range keeps only listings inside it and still keeps the cheaper match',async()=>{
  const task=createTask(['相机']);
  task.jobs[0].priceMin=2000;
  task.jobs[0].priceMax=4000;
  const cards=[card('1',10),card('2',40),card('3',19.99),card('4',25),card('5',40.01)];
  await new Runner(task,ports([{cards,end:true}],{
    hash:async image=>({bits:'0'.repeat(16),color:[Number(image.match(/\/(\d+)\.jpg/)[1])*40,0,0],spread:50})
  })).run();
  assert.deepEqual(selected(task.jobs[0]).map(item=>item.id),['2','4']);
  assert.equal(task.jobs[0].skipped,3);
  assert.match(task.jobs[0].lastSkip,/区间/);
});
test('an empty price range still keeps the cheaper listing',async()=>{
  const task=createTask(['相机']);
  task.jobs[0].priceMin=null;
  task.jobs[0].priceMax=null;
  await new Runner(task,ports([{cards:[card('1',80),card('2',12)],end:true}])).run();
  assert.equal(selected(task.jobs[0])[0].id,'2');
  assert.equal(task.jobs[0].skipped,0);
});
