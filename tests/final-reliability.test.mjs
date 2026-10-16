import test from 'node:test';
import assert from 'node:assert/strict';
import {browserPorts,searchUrl} from '../extension/lib/browser.mjs';
import {Runner} from '../extension/lib/runner.mjs';
import {createTask,enqueueKeyword,retryJob,selected,recoverTask,addCandidate} from '../extension/lib/core.mjs';
import {deduplicate,restoreDuplicate,duplicateItems} from '../extension/lib/product-dedup.mjs';

for(const verified of [false,true]) test(`Runner checks held child on matching search and resumes original first: verified=${verified}`,async()=>{
  const prior=globalThis.chrome,task=enqueueKeyword(null,'相机','pdd',{limit:1,imageDedup:false}),job=task.jobs[0];
  Object.assign(task,{tabId:42,status:'blocked',resolveBlockedTabId:9,resolveBlockedCardKey:'original',resolveBlockedKeyword:'相机',resolvePendingCard:{key:'original',title:'相机原商品',priceText:'¥13'}});
  job.status='blocked';let heldReads=0,clicks=0,details=0;
  globalThis.chrome={tabs:{get:async id=>({id,status:'complete',url:id===9?(verified?'https://mobile.pinduoduo.com/goods.html?goods_id=123':'https://mobile.pinduoduo.com/login.html'):searchUrl('相机')}),sendMessage:async(id,msg)=>{
    if(msg.type==='PDD_OPEN_CARD')clicks++;
    if(id===9){heldReads++;return {blocked:!verified,reason:'安全验证'};}
    return {url:searchUrl('相机'),cards:[{key:'other',id:'999',url:'https://mobile.pinduoduo.com/goods.html?goods_id=999',title:'相机其他商品',priceText:'¥99'}],end:true};
  }},scripting:{executeScript:async()=>[]}};
  try{
    const ports=browserPorts({save:async()=>{},update(){}});
    await new Runner(task,{...ports,enrich:async()=>{details++;return {};},close:async()=>{}}).run();
    assert.ok(heldReads>0,'held verification must be inspected before linked cards');
    assert.equal(clicks,0);
    if(!verified){assert.equal(task.status,'blocked');assert.equal(details,0);assert.deepEqual(selected(job),[]);}
    else{assert.equal(task.status,'done');assert.equal(selected(job)[0].id,'123');assert.equal(selected(job)[0].title,'相机原商品');assert.equal(selected(job)[0].cents,1300);}
  }finally{globalThis.chrome=prior;}
});

test('missing-link once-only scope survives continuation but permits another job and explicit retry',async()=>{
  const prior=globalThis.chrome,task=createTask(['相机','相机配件']);task.tabId=42;let url=searchUrl('相机'),clicks=0;
  globalThis.chrome={tabs:{get:async()=>({id:42,status:'complete',url}),update:async(_id,change)=>{url=change.url;},sendMessage:async(_id,msg)=>{
    if(msg.type==='PDD_OPEN_CARD'){clicks++;url='https://mobile.pinduoduo.com/goods.html?goods_id=123';}
    return {url,cards:[{key:'same'}],blocked:false};
  },onCreated:{addListener(){},removeListener(){}},remove:async()=>{}},scripting:{executeScript:async()=>[]}};
  try{
    const ports=browserPorts({save:async()=>{},update(){},cardPollWait:async()=>{}});
    const resolve=async job=>{await ports.open(job,task);return ports.resolve({key:'same'},{position:0},job);};
    await resolve(task.jobs[0]);
    await assert.rejects(()=>resolve(task.jobs[0]),error=>error.blocked);
    const saved=JSON.parse(JSON.stringify(task));
    await ports.open(saved.jobs[0],saved);
    await assert.rejects(()=>ports.resolve({key:'same'},{position:0},saved.jobs[0]),error=>error.blocked);
    await resolve(task.jobs[1]);
    await resolve(retryJob(task,0));
    assert.equal(clicks,3);
  }finally{globalThis.chrome=prior;}
});

test('cancelled regrouping keeps memberships and hash metadata atomic through JSON recovery and restore',async()=>{
  const task=createTask(['相机']),job=task.jobs[0];
  for(const id of ['1','2','3'])addCandidate(job,{id,title:'相机',cents:100,image:`https://img.pddpic.com/${id}.jpg`});
  const before=JSON.stringify(job.groups);let cancel=false;
  await deduplicate(job,async url=>{if(url.endsWith('/3.jpg'))cancel=true;return {sha256:url.endsWith('/3.jpg')?'other':'same'};},()=>cancel);
  assert.equal(JSON.stringify(job.groups),before,'no membership or metadata may leak from a cancelled pass');
  await deduplicate(job,async url=>({sha256:url.endsWith('/3.jpg')?'other':'same'}));
  const recovered=recoverTask(JSON.parse(JSON.stringify(task))).jobs[0];
  assert.equal(restoreDuplicate(recovered,'2'),true);
  assert.equal(restoreDuplicate(recovered,'2'),false);
  assert.deepEqual(selected(recovered).map(x=>x.id),['1','3','2']);
  assert.equal(duplicateItems(recovered).length,0);
});

test('Runner pause twice during hashing then recovery cannot restore the same product twice',async()=>{
  let task=enqueueKeyword(null,'相机','pdd',{limit:3}),pauseAt='2',runner,time=10000;
  const cards=['1','2','3'].map(id=>({key:id,id,url:`https://mobile.pinduoduo.com/goods.html?goods_id=${id}`,title:'相机',priceText:'¥1',image:`https://img.pddpic.com/${id}.jpg`}));
  const makePorts=()=>({open:async()=>{},read:async()=>({cards,end:true}),save:async()=>{},update(){},close:async()=>{},scroll:async()=>{},wait:async ms=>{time+=ms;},now:()=>time,
    enrich:async()=>({}),hash:async url=>{if(url.endsWith(`/${pauseAt}.jpg`))runner.pause();return {sha256:url.endsWith('/3.jpg')?'other':'same'};}});
  runner=new Runner(task,makePorts());await runner.run();
  assert.equal(task.status,'paused');
  assert.deepEqual(task.jobs[0].groups.map(g=>g.members.map(i=>i.id)),[['1'],['2']]);
  task=recoverTask(JSON.parse(JSON.stringify(task)));pauseAt='3';
  runner=new Runner(task,makePorts());await runner.run();
  assert.equal(task.status,'paused');
  assert.deepEqual(task.jobs[0].groups.map(g=>g.members.map(i=>i.id)),[['1'],['2'],['3']]);
  task=recoverTask(JSON.parse(JSON.stringify(task)));pauseAt='none';
  runner=new Runner(task,makePorts());await runner.run();
  const job=recoverTask(JSON.parse(JSON.stringify(task))).jobs[0];
  assert.equal(restoreDuplicate(job,'2'),true);assert.equal(restoreDuplicate(job,'2'),false);
  assert.deepEqual(selected(job).map(i=>i.id),['1','3','2']);
});
