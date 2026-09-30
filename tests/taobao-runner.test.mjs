import test from 'node:test';
import assert from 'node:assert/strict';
import {Runner} from '../extension/lib/runner.mjs';
import {enqueueKeyword,selected} from '../extension/lib/core.mjs';
import {removeProduct,prepareRefill} from '../extension/lib/products.mjs';
import {taskSheets} from '../extension/lib/xlsx.mjs';
import {taobaoPage,taobaoCard} from './helpers/taobao-page.mjs';
import {fingerprint} from '../extension/lib/fingerprint.mjs';

const sampleHash=id=>{
  const pixels=new Uint8ClampedArray(32*32*4);let seed=Number(id)+1;
  for(let i=0;i<pixels.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[i]=seed&255;pixels[i+1]=(seed>>>8)&255;pixels[i+2]=(seed>>>16)&255;pixels[i+3]=255;}
  return fingerprint(pixels);
};
const pagePorts=f=>({save:async()=>{},update(){},open:async()=>{},close:async()=>{},
  scroll:async()=>f.send({type:'PDD_SCROLL'}),read:async()=>f.send({type:'PDD_SNAPSHOT'}),
  wait:async ms=>f.advance(ms),hash:async url=>sampleHash(url.match(/item-(\d+)/)[1]),
  enrich:async()=>({descriptionText:'商品详情',detailStatus:'done'})});

test('incomplete Taobao cards are prepared before validation and never permanently rejected while loading',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:1});let preparations=0;
  const raw={id:'1',key:'1',title:'相机',image:'',priceText:'',url:'https://item.taobao.com/item.htm?id=1'};
  await new Runner(task,{...pagePorts({}),read:async()=>({cards:[raw],end:true}),prepareCard:async c=>{
    preparations++;return {...c,image:'https://img.alicdn.com/item-1.jpg',priceText:'¥13'};
  }}).run();
  assert.equal(preparations,1);assert.equal(task.jobs[0].skipped,0);assert.equal(selected(task.jobs[0]).length,1);
});

test('pause during Taobao card preparation does not consume a card or scan budget',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:1});let runner;
  const raw={id:'1',key:'1',title:'相机',image:'',priceText:'¥13',url:'https://item.taobao.com/item.htm?id=1'};
  runner=new Runner(task,{...pagePorts({}),read:async()=>({cards:[raw],end:true}),prepareCard:async c=>{runner.pause();return c;}});
  await runner.run();assert.equal(task.status,'paused');assert.equal(task.jobs[0].scanned,0);assert.deepEqual(task.jobs[0].seen,[]);
});

test('systematic extraction failure stops after five post-retry failures rather than skipping one hundred goods',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:13});let attempts=0;
  const raw=id=>({id,key:id,title:'相机',image:'',priceText:'¥13',url:`https://item.taobao.com/item.htm?id=${id}`});
  const good={...raw('1'),image:'https://img.alicdn.com/item-1.jpg'};
  await new Runner(task,{...pagePorts({}),read:async()=>({cards:[good,...Array.from({length:103},(_,i)=>({...raw(String(i+2)),priceText:''}))],end:false}),prepareCard:async c=>{if(!c.priceText)attempts++;return c;}}).run();
  assert.equal(task.jobs[0].status,'error');assert.equal(attempts,5);assert.equal(task.jobs[0].scanned,6);
  assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1']);
  assert.match(task.jobs[0].note,/连续.*5.*识别/);
});

test('Taobao collection retains Tmall source and shares the limit, exclusions and template export',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:2,priceMin:500,priceMax:1500});const job=task.jobs[0];let reads=0;
  const card=(id,host='item.taobao.com')=>({id,key:id,title:'相机包',priceText:'¥8.50',image:`https://img.alicdn.com/${id}.jpg`,url:`https://${host}/item.htm?id=${id}`});
  const ports={save:async()=>{},update(){},open:async()=>{},close:async()=>{},scroll:async()=>{},wait:async()=>{},
    read:async()=>{reads++;return{cards:[card('1'),card('2','detail.tmall.com'),card('3')],end:true};},
    hash:async url=>({bits:'0000000000000000',color:[Number(url.match(/(\d+)\.jpg/)[1])*100,100,100],spread:50}),
    enrich:async item=>({descriptionText:'详情',detailStatus:'done',skus:[{id:'sku'+item.id,specs:['红'],cents:850,image:item.image,stock:'2'}]})};
  await new Runner(task,ports).run();assert.equal(reads,1);
  assert.deepEqual(selected(job).map(x=>x.platform),['淘宝','天猫']);
  assert.deepEqual(taskSheets(task)[0].rows.slice(9).map(r=>r[0]),['TB1','TM2']);
  removeProduct(job,'1');prepareRefill(job);await new Runner(task,ports).run();
  assert.deepEqual(selected(job).map(x=>x.id),['2','3']);
  assert.equal(selected(job)[0].descriptionText,'详情');
});

test('fifty listings with repeated artwork stop at forty-five distinct product IDs',async()=>{
  let html='';
  for(let id=1;id<=50;id++){
    const picture=id<=42?id:id-42;
    html+=taobaoCard(String(id)).replace(`item-${id}.jpg`,`item-${picture}.jpg`)
      .replace('<img src=','<img class="campaignTag" src="//img.alicdn.com/shared-campaign.jpg"><img class="mainProductPic" src=')
      .replace('<span>12</span><span>.80</span>','<span class="Price--priceInt">13</span><span>优惠后</span>');
  }
  const f=await taobaoPage(html+'<div class="Pagination"><button disabled>下一页</button></div>');
  for(const img of f.document.querySelectorAll('img'))img.getBoundingClientRect=()=>img.className==='campaignTag'?{width:96,height:18}:{width:280,height:280};
  const task=enqueueKeyword(null,'相机','taobao',{limit:45});
  await new Runner(task,pagePorts(f)).run();
  assert.equal(task.jobs[0].scanned,45);assert.equal(task.jobs[0].skipped,0);
  assert.equal(selected(task.jobs[0]).length,45);assert.equal(task.jobs[0].merged,0);
  assert.equal(task.jobs[0].status,'done');
  assert.ok(selected(task.jobs[0]).every(x=>!x.image.includes('shared-campaign')));
});

test('real reader and Runner cross a slow next page and stop immediately at the requested count',async()=>{
  const f=await taobaoPage(taobaoCard('1')+taobaoCard('2')+'<div class="Pagination"><div class="Pagination--prevNext"><span>下一页</span></div></div>');
  let clicks=0,waits=0;
  f.document.querySelector('.Pagination--prevNext').click=()=>{clicks++;f.location.search='?q=相机&page=2';};
  const ports=pagePorts(f);
  ports.wait=async ms=>{f.advance(ms);if(clicks&&++waits===11){for(const a of f.document.querySelectorAll('a'))a.remove();f.document.body.insertAdjacentHTML('afterbegin',taobaoCard('3')+taobaoCard('4'));}};
  const task=enqueueKeyword(null,'相机','taobao',{limit:3});
  await new Runner(task,ports).run();
  assert.equal(task.jobs[0].status,'done');assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1','2','3']);
  assert.equal(clicks,1);assert.equal(task.jobs[0].scanned,3);
});

test('Runner never processes pending old-page cards and bounds a stuck transition',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});let reads=0,hashes=0;
  const raw={id:'1',key:'1',title:'相机',priceText:'¥13',image:'https://img.alicdn.com/item-1.jpg',url:'https://item.taobao.com/item.htm?id=1'};
  const ports={...pagePorts({}),read:async()=>{reads++;return{cards:[raw],paginationPending:true,paginationToken:'page1',end:false};},
    hash:async()=>{hashes++;return sampleHash(1);},scroll:async()=>{},wait:async()=>{}};
  await new Runner(task,ports).run();
  assert.equal(hashes,0);assert.equal(task.jobs[0].scanned,0);assert.equal(task.jobs[0].status,'error');
  assert.match(task.jobs[0].note,/翻页/);assert.ok(reads<=21);
});

test('rejected title and price are counted separately from same-image merges',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:5});
  const f=await taobaoPage(taobaoCard('1')+taobaoCard('2','保证金')+taobaoCard('3').replace('<span>12</span><span>.80</span>','<span>不明</span>')+'<div class="Pagination"><button disabled>下一页</button></div>');
  await new Runner(task,pagePorts(f)).run();
  assert.equal(task.jobs[0].skipped,2);assert.equal(task.jobs[0].skipReasons['名称未识别'],1);
  assert.equal(task.jobs[0].skipReasons['价格未识别'],1);assert.equal(task.jobs[0].merged||0,0);
});

test('a document reload cannot click page two again while its goods are still loading',async()=>{
  let f=await taobaoPage(taobaoCard('1')+'<div class="Pagination"><button>下一页</button></div>');
  let clicks=0,loadedPageTwo=false,waits=0;
  const attach=()=>{f.document.querySelector('button').click=()=>{clicks++;loadedPageTwo=true;};};attach();
  const ports={...pagePorts(f),read:async()=>f.send({type:'PDD_SNAPSHOT'}),scroll:async()=>{
    const result=await f.send({type:'PDD_SCROLL'});
    if(loadedPageTwo&&clicks===1){f=await taobaoPage('<div class="Pagination"><button>下一页</button></div>','https://s.taobao.com/search?q=相机&page=2');attach();}
    return result;
  },wait:async ms=>{
    f.advance(ms);if(loadedPageTwo&&++waits===11)f.document.body.insertAdjacentHTML('afterbegin',taobaoCard('2'));
  }};
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});
  await new Runner(task,ports).run();
  assert.equal(task.jobs[0].status,'done');assert.equal(clicks,1);
  assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1','2']);
});

test('goods with only a tiny badge retain their link without image hashing',async()=>{
  const f=await taobaoPage(taobaoCard('1').replace('<img src=','<img width="20" height="20" src=')+'<div class="Pagination"><button disabled>下一页</button></div>');
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});let hashes=0;
  await new Runner(task,{...pagePorts(f),hash:async()=>{hashes++;return sampleHash(1);}}).run();
  assert.equal(task.jobs[0].scanned,1);assert.equal(task.jobs[0].skipped,0);
  assert.equal(selected(task.jobs[0]).length,1);assert.equal(hashes,0);
  assert.equal(selected(task.jobs[0])[0].detailStatus,'partial');
});

test('pausing during pagination persists the source keys and resumes after a fresh page document',async()=>{
  const first=await taobaoPage(taobaoCard('1')+'<div class="Pagination"><button>下一页</button></div>');
  first.document.querySelector('button').click=()=>{};
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});let runner;
  runner=new Runner(task,{...pagePorts(first),wait:async()=>runner.pause()});
  await runner.run();assert.equal(task.status,'paused');
  const restored=JSON.parse(JSON.stringify(task));
  const next=await taobaoPage('<div class="Pagination"><button>下一页</button></div>','https://s.taobao.com/search?q=相机&page=2');
  let clicks=0,waits=0;next.document.querySelector('button').click=()=>{clicks++;};
  await new Runner(restored,{...pagePorts(next),wait:async ms=>{next.advance(ms);if(++waits===10)next.document.body.insertAdjacentHTML('afterbegin',taobaoCard('2'));}}).run();
  assert.equal(restored.jobs[0].status,'done');assert.equal(clicks,0);
  assert.deepEqual(selected(restored.jobs[0]).map(x=>x.id),['1','2']);
});

test('disabled next on a freshly navigated last page still waits for that page goods',async()=>{
  let f=await taobaoPage(taobaoCard('1')+'<div class="Pagination"><button>下一页</button></div>');
  let clicked=false,waits=0;f.document.querySelector('button').click=()=>{clicked=true;};
  const task=enqueueKeyword(null,'相机','taobao',{limit:3});
  const ports={...pagePorts(f),read:async()=>f.send({type:'PDD_SNAPSHOT'}),scroll:async()=>{
    const result=await f.send({type:'PDD_SCROLL'});
    if(clicked)f=await taobaoPage('<div class="Pagination"><button disabled>下一页</button></div>','https://s.taobao.com/search?q=相机&page=2');
    return result;
  },wait:async ms=>{f.advance(ms);if(clicked&&++waits===3)f.document.body.insertAdjacentHTML('afterbegin',taobaoCard('2'));}};
  await new Runner(task,ports).run();
  assert.equal(task.jobs[0].status,'short');assert.equal(task.jobs[0].scanned,2);
  assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1','2']);
});

test('explicit no-results after next page completes short instead of waiting forever',async()=>{
  let f=await taobaoPage(taobaoCard('1')+'<div class="Pagination"><button>下一页</button></div>');
  let clicked=false;f.document.querySelector('button').click=()=>{clicked=true;};
  const task=enqueueKeyword(null,'相机','taobao',{limit:2});
  await new Runner(task,{...pagePorts(f),read:async()=>f.send({type:'PDD_SNAPSHOT'}),scroll:async()=>{
    const result=await f.send({type:'PDD_SCROLL'});
    if(clicked)f=await taobaoPage('<div>没有找到相关宝贝</div>','https://s.taobao.com/search?q=相机&page=2');return result;
  }}).run();
  assert.equal(task.jobs[0].status,'short');assert.equal(selected(task.jobs[0]).length,1);
});
