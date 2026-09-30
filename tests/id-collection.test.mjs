import test from 'node:test';
import assert from 'node:assert/strict';
import {enqueueKeyword,addCandidate,selected,recoverTask} from '../extension/lib/core.mjs';
import {removeProduct,prepareRefill} from '../extension/lib/products.mjs';
import {normalizeDetail} from '../extension/lib/detail.mjs';
import {Runner} from '../extension/lib/runner.mjs';
import {taskSheets} from '../extension/lib/xlsx.mjs';
import {searchPage} from './helpers/search-page.mjs';

const fp={bits:'0000000000000000',color:[100,100,100],spread:50};
const candidate=id=>({id,title:'相机',cents:1300,image:'https://img.alicdn.com/same.jpg',fingerprint:fp,url:`https://item.taobao.com/item.htm?id=${id}`});
const sourceUrl=(site,id)=>site==='pdd'?`https://mobile.pinduoduo.com/goods.html?goods_id=${id}`:site==='1688'?`https://detail.1688.com/offer/${id}.html`:`https://item.taobao.com/item.htm?id=${id}`;
const ports={open:async()=>{},close:async()=>{},save:async()=>{},update(){},wait:async()=>{},scroll:async()=>{},
  hash:async()=>{throw new Error('Image hashing must not gate collection');}};

test('distinct product IDs remain separate even with identical artwork or no image fingerprint',()=>{
  const job=enqueueKeyword(null,'相机','taobao').jobs[0];
  addCandidate(job,candidate('1'));addCandidate(job,candidate('2'));
  assert.equal(addCandidate(job,{...candidate('3'),image:'',fingerprint:undefined}),true);
  addCandidate(job,{...candidate('1'),cents:1200});
  assert.deepEqual(selected(job).map(x=>x.id),['1','2','3']);
  assert.equal(selected(job)[0].cents,1200);
});

test('legacy image groups and exclusions do not merge or reject another ID of the same art',()=>{
  const task=enqueueKeyword(null,'相机','taobao');const job=task.jobs[0];
  job.groups=[{ids:['1','2'],image:candidate('1').image,fingerprint:fp,best:candidate('1')}];
  job.exclusions=[{ids:['9'],images:[candidate('1').image],fingerprints:[fp]}];
  recoverTask(task);
  assert.equal(addCandidate(job,candidate('2')),true);
  assert.deepEqual(selected(job).map(x=>x.id),['1','2']);
  removeProduct(job,'1');
  assert.equal(addCandidate(job,candidate('1')),false);
  assert.equal(addCandidate(job,candidate('3')),true);
  assert.equal(addCandidate(job,candidate('9')),false);
  assert.deepEqual(selected(job).map(x=>x.id),['2','3']);
});

test('a persisted winner without legacy group IDs can still deduplicate its product ID',()=>{
  const job=enqueueKeyword(null,'相机','taobao').jobs[0];
  job.groups=[{best:candidate('1')}];
  assert.equal(addCandidate(job,{...candidate('1'),cents:1200}),true);
  assert.equal(selected(job).length,1);assert.equal(selected(job)[0].cents,1200);
});

test('all sources reach count without search images and automatically export first detail gallery image',async()=>{
  for(const site of ['pdd','1688','taobao']) {
    const task=enqueueKeyword(null,'相机',site,{limit:2});const job=task.jobs[0];let detailIds=[];
    await new Runner(task,{...ports,
      read:async()=>({cards:['1','2','3'].map(id=>({...candidate(id),url:sourceUrl(site,id),key:id,image:'',priceText:'¥13'})),end:false}),
      enrich:async item=>{detailIds.push(item.id);return normalizeDetail({descriptionText:'真实描述',galleryImages:[`https://img.alicdn.com/detail-${item.id}.jpg`,'https://img.alicdn.com/second.jpg']},item);}
    }).run();
    assert.equal(job.status,'done');assert.equal(job.scanned,2);assert.equal(job.skipped,0);
    assert.deepEqual(detailIds,['1','2']);assert.equal(selected(job)[0].image,'https://img.alicdn.com/detail-1.jpg');
    const rows=taskSheets(task)[0].rows.slice(9);
    assert.equal(rows.length,2);assert.equal(rows[0][3],'https://img.alicdn.com/detail-1.jpg，https://img.alicdn.com/second.jpg');
    assert.equal(rows[0][18],'https://img.alicdn.com/detail-1.jpg');
  }
});

test('real search adapters deliver thirteen image-free links to the Runner for every source',async()=>{
  for(const site of ['pdd','1688','taobao']) {
    let html='';
    for(let i=1001;i<=1014;i++)html+=`<a href="${sourceUrl(site,String(i))}"><h3>数码相机${i}</h3><div class="Price">¥13.00</div></a>`;
    const page=await searchPage(site,html),task=enqueueKeyword(null,'相机',site,{limit:13});
    await new Runner(task,{...ports,read:page.read,enrich:async item=>normalizeDetail({descriptionText:'详情',galleryImages:[`https://img.alicdn.com/detail-${item.id}.jpg`]},item)}).run();
    assert.equal(task.jobs[0].status,'done');assert.equal(task.jobs[0].scanned,13);
    assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1001','1002','1003','1004','1005','1006','1007','1008','1009','1010','1011','1012','1013']);
    assert.equal(task.jobs[0].skipped,0);assert.equal(taskSheets(task)[0].rows.slice(9).length,13);
  }
});

test('image-free PDD and 1688 lists keep scrolling their actual inner results container',async()=>{
  for(const site of ['pdd','1688']) {
    const page=await searchPage(site,`<div id="results"><a href="${sourceUrl(site,'1001')}"><h3>数码相机</h3><div>¥13</div></a></div>`);
    const list=page.document.getElementById('results');
    Object.defineProperties(list,{scrollHeight:{value:2000},clientHeight:{value:600}});list.scrollTop=0;
    page.document.documentElement.scrollTop=0;
    await page.send({type:'PDD_SCROLL'});
    assert.equal(list.scrollTop,480);assert.equal(page.document.documentElement.scrollTop,0);
    assert.equal((await page.read()).position,480);
  }
});

test('ordinary detail failure and a missing detail picture preserve both collected links',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});
  await new Runner(task,{...ports,read:async()=>({cards:['1','2'].map(id=>({...candidate(id),image:'',key:id,priceText:'¥13'})),end:true}),
    enrich:async item=>{if(item.id==='1')throw new Error('详情未响应');return normalizeDetail({descriptionText:'已有描述'},item);}
  }).run();
  const items=selected(task.jobs[0]);assert.deepEqual(items.map(x=>x.id),['1','2']);
  assert.equal(items[0].detailStatus,'error');assert.match(items[0].detailNote,/详情未响应/);
  assert.equal(items[1].detailStatus,'partial');assert.match(items[1].detailNote,/图片/);
  assert.equal(taskSheets(task)[0].rows.slice(9).length,2);
});

test('recovery discards obsolete image permission gating while preserving a resumable job',()=>{
  const task=enqueueKeyword(null,'相机','taobao');task.status='blocked';task.jobs[0].status='blocked';
  task.permissionOrigin='https://img.alicdn.com/*';
  const result=recoverTask(task);
  assert.equal(result.status,'paused');assert.equal(result.jobs[0].status,'paused');assert.equal(result.permissionOrigin,'');
});

test('deletion refills with a different ID showing identical art, preserving retained details',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});const job=task.jobs[0];
  addCandidate(job,{...candidate('1'),detailStatus:'done',descriptionText:'旧详情'});
  addCandidate(job,{...candidate('2'),detailStatus:'done',descriptionText:'保留详情'});
  job.seen=['1','2'];removeProduct(job,'1');prepareRefill(job);
  await new Runner(task,{...ports,read:async()=>({cards:['1','2','3','4'].map(id=>({...candidate(id),key:id,priceText:'¥13'})),end:false}),
    enrich:async item=>normalizeDetail({descriptionText:'新详情',galleryImages:['https://img.alicdn.com/same.jpg']},item)
  }).run();
  assert.equal(job.status,'done');assert.deepEqual(selected(job).map(x=>x.id),['2','3']);
  assert.equal(selected(job)[0].descriptionText,'保留详情');assert.equal(job.scanned,1);
});
