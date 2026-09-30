import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {readLiveTaobao} from '../extension/lib/taobao-page.mjs';
import {browserPorts,descriptionDocumentUrl} from '../extension/lib/browser.mjs';
import {enqueueKeyword} from '../extension/lib/core.mjs';

test('missing search image does not cause preparation to request the page or wait',async()=>{
  const previous=globalThis.chrome;globalThis.chrome={tabs:{get:async()=>{throw new Error('Must not reread a complete title and price');}}};
  try {
    const task=enqueueKeyword(null,'相机','taobao');
    const raw={id:'123',key:'123',title:'相机',image:'',priceText:'¥13',url:'https://item.taobao.com/item.htm?id=123'};
    const result=await browserPorts({save:async()=>{},update(){},cardPollWait:async()=>{throw new Error('Must not wait for search images');}}).prepareCard(raw,task.jobs[0]);
    assert.equal(result.id,'123');assert.equal(result.priceText,'¥13');assert.equal(result.image,'');
  }finally{globalThis.chrome=previous;}
});

test('card preparation scrolls once and rereads delayed image and price with a bounded retry',async()=>{
  const previous=globalThis.chrome;let polls=0,scrolls=0,waits=0;
  const raw={id:'123',key:'123',title:'相机',image:'',priceText:'',url:'https://item.taobao.com/item.htm?id=123'};
  const task=enqueueKeyword(null,'相机','taobao');task.tabId=7;
  globalThis.chrome={tabs:{get:async()=>({id:7,status:'complete',url:'https://s.taobao.com/search?q=相机'}),sendMessage:async(_id,message)=>{
    if(message.type==='PDD_PREPARE_CARD'){scrolls++;return{ok:true};}
    polls++;return{url:'https://s.taobao.com/search?q=相机',cards:[polls<4?raw:{...raw,image:'https://img.alicdn.com/a.jpg',priceText:'¥13'}]};
  }},scripting:{executeScript:async()=>[]}};
  try{
    const ports=browserPorts({save:async()=>{},update(){},cardPollWait:async()=>{waits++;}});
    await ports.open(task.jobs[0],task);
    const result=await ports.prepareCard(raw,task.jobs[0]);
    assert.equal(result.image,'https://img.alicdn.com/a.jpg');assert.equal(result.priceText,'¥13');
    assert.equal(scrolls,1);assert.equal(polls,4);assert.equal(waits,2);
    const complete=await ports.prepareCard(result,task.jobs[0]);assert.equal(complete.id,'123');assert.equal(scrolls,1);
  }finally{globalThis.chrome=previous;}
});

test('card preparation stops on verification, cancellation, or a changed product ID',async()=>{
  const previous=globalThis.chrome;
  for(const mode of ['blocked','cancelled','foreign']) {
    const raw={id:'123',key:'123',title:'相机',image:'',priceText:'',url:'https://item.taobao.com/item.htm?id=123'};
    const task=enqueueKeyword(null,'相机','taobao');task.tabId=7;let reads=0,cancelled=false;
    globalThis.chrome={tabs:{get:async()=>({id:7,status:'complete',url:'https://s.taobao.com/search?q=相机'}),sendMessage:async(_id,message)=>{
      if(message.type==='PDD_PREPARE_CARD')return{ok:true};
      reads++;return mode==='blocked'?{blocked:true,reason:'请完成验证码',cards:[]}:{url:'https://s.taobao.com/search?q=相机',cards:[mode==='foreign'?{...raw,id:'999',image:'https://img.alicdn.com/other.jpg',priceText:'¥1'}:raw]};
    }},scripting:{executeScript:async()=>[]}};
    try {
      const ports=browserPorts({save:async()=>{},update(){},cardPollWait:async()=>{cancelled=true;}});
      await ports.open(task.jobs[0],task);
      if(mode==='blocked')await assert.rejects(ports.prepareCard(raw,task.jobs[0]),error=>error.blocked&&/验证码/.test(error.message));
      else if(mode==='foreign') {await assert.rejects(ports.prepareCard(raw,task.jobs[0]),/离开列表/);assert.ok(reads<=13);}
      else {const result=await ports.prepareCard(raw,task.jobs[0],()=>cancelled);assert.equal(result.image,'');assert.ok(reads<=2);}
    }finally{globalThis.chrome=previous;}
  }
});

test('page world snapshot includes current product data and excludes unrelated account roots',()=>{
  const context=vm.createContext({location:{href:'https://item.taobao.com/item.htm?id=123'},URL,
    __ICE_APP_CONTEXT__:{appData:{loaderData:{home:{data:{item:{itemId:'123',title:'相机包',images:['//img.alicdn.com/a.jpg'],sellerSecret:'private'},skuBase:{props:[],skus:[]},skuCore:{sku2info:{'0':{price:{priceText:'8.5'},quantity:3,accountSecret:'private'}}},user:{name:'private'}}}}}},
    __INIT_DATA__:{item:{itemId:'999',title:'推荐商品'}}});
  const result=vm.runInContext(`(${readLiveTaobao.toString()})()`,context);
  assert.equal(result.roots.length,1); assert.equal(result.roots[0].item.itemId,'123');
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('Taobao browser uses its own background search and detail reader, preserving Tmall links',async()=>{
  const prior=globalThis.chrome;const calls={created:[],scripts:[]};const task=enqueueKeyword(null,'相机','taobao');
  globalThis.chrome={tabs:{create:async options=>{calls.created.push(options);return{id:7};},
    get:async()=>({id:7,status:'complete',url:'https://s.taobao.com/search?q=相机'}),remove:async()=>{},
    sendMessage:async()=>({goodsId:'123',ready:true,skuPending:false,detailPending:false,descriptionUrls:[],detail:{title:'相机包',galleryImages:['https://img.alicdn.com/a.jpg'],skus:[{id:'s1',specs:['红'],price:'8.50',stock:'3'}]}})},
    scripting:{executeScript:async options=>{calls.scripts.push(options);return[{result:null}];}}};
  try{
    const ports=browserPorts({save:async()=>{},update(){}});await ports.open(task.jobs[0],task);
    const data=await ports.enrich({id:'123',site:'taobao',url:'https://detail.tmall.com/item.htm?id=123&spm=x',title:'相机',cents:850},task);
    assert.equal(new URL(calls.created[0].url).hostname,'s.taobao.com');
    assert.deepEqual(calls.created[1],{url:'https://detail.tmall.com/item.htm?id=123',active:false});
    assert.deepEqual(calls.scripts[0].files,['detail-taobao.js']);
    assert.equal(calls.scripts[1].world,'MAIN'); assert.equal(data.skus[0].cents,850);
  }finally{globalThis.chrome=prior;}
});

test('Taobao waits for real SKU fields after a gallery-only response and retrieves declared description',async()=>{
  const prior=globalThis.chrome,priorFetch=globalThis.fetch;let count=0,fetches=0;
  globalThis.chrome={tabs:{create:async()=>({id:7}),get:async()=>({id:7,status:'complete'}),remove:async()=>{},
    sendMessage:async()=>{count++;return{goodsId:'123',ready:true,skuPending:count===1,detailPending:true,descriptionUrls:['https://desc.alicdn.com/123.html'],detail:{title:'相机包',galleryImages:['https://img.alicdn.com/main.jpg'],detailStatus:'partial',skus:count===1?[]:[{id:'s1',specs:['红'],price:'8.50'}]}};}},
    scripting:{executeScript:async()=>[{result:null}]}};
  globalThis.fetch=async()=>{fetches++;return{ok:true,text:async()=>'<img src="https://img.alicdn.com/long.jpg">'};};
  try{
    const data=await browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'taobao',cents:850});
    assert.equal(count,2); assert.equal(fetches,1); assert.equal(data.skus[0].id,'s1');
    assert.deepEqual(data.detailImages,['https://img.alicdn.com/long.jpg']); assert.equal(data.detailStatus,'done');
    assert.equal(descriptionDocumentUrl('https://desc.taobao.com/123.html'),'https://desc.taobao.com/123.html');
    assert.equal(descriptionDocumentUrl('https://item.taobao.com/item.htm?id=123'),'');
  }finally{globalThis.chrome=prior;globalThis.fetch=priorFetch;}
});

test('pending description continues loading after the first image without losing completed SKU data',async()=>{
  const prior=globalThis.chrome;let count=0;
  globalThis.chrome={tabs:{create:async()=>({id:7}),get:async()=>({id:7,status:'complete'}),remove:async()=>{},
    sendMessage:async()=>{count++;return{goodsId:'123',ready:true,skuPending:false,detailPending:count<3,descriptionUrls:[],detail:{title:'相机包',galleryImages:['https://img.alicdn.com/main.jpg'],detailImages:count<3?['https://img.alicdn.com/a.jpg']:['https://img.alicdn.com/a.jpg','https://img.alicdn.com/b.jpg'],skus:[{id:'s1',specs:['红'],price:'8.50'}]}};}},
    scripting:{executeScript:async()=>[{result:null}]}};
  try{
    const data=await browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'taobao',cents:850});
    assert.deepEqual(data.detailImages,['https://img.alicdn.com/a.jpg','https://img.alicdn.com/b.jpg']);assert.equal(data.skus[0].id,'s1');assert.equal(count,3);
  }finally{globalThis.chrome=prior;}
});

test('long description scrolling is not cut off by stable upper images before later pictures appear',async()=>{
  const prior=globalThis.chrome;let count=0;
  globalThis.chrome={tabs:{create:async()=>({id:7}),get:async()=>({id:7,status:'complete'}),remove:async()=>{},sendMessage:async()=>{
    count++;return{goodsId:'123',ready:true,skuPending:false,detailPending:count<19,detailLoading:count<19,descriptionUrls:[],detail:{title:'玻璃水杯',galleryImages:['https://img.alicdn.com/main.jpg'],detailImages:count<19?['https://img.alicdn.com/top.jpg']:['https://img.alicdn.com/top.jpg','https://img.alicdn.com/bottom.jpg'],skus:[{id:'s1',specs:['大号'],price:'2.90'}]}};
  }},scripting:{executeScript:async()=>[{result:null}]}};
  try{const result=await browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'taobao',cents:290});
    assert.deepEqual(result.detailImages,['https://img.alicdn.com/top.jpg','https://img.alicdn.com/bottom.jpg']);assert.equal(count,19);
  }finally{globalThis.chrome=prior;}
});

test('the real reader and polling retain later pictures in a heading-only description layout',async()=>{
  const {window,document}=parseHTML('<html><body><h1>水杯</h1><section id="text-images"><div class="DescriptionHeader"><h2>图文详情</h2><img src="//img.alicdn.com/top.jpg"></div></section></body></html>');
  window.scrollY=0;window.innerHeight=700;
  window.Element.prototype.getBoundingClientRect=()=>({width:300,height:300,top:1000-window.scrollY});
  document.querySelector('h2').getBoundingClientRect=()=>({width:300,height:50,top:1000-window.scrollY});
  // Linkedom reverses nested heading/later sibling order; model the browser's FOLLOWING bit.
  document.querySelector('h2').compareDocumentPosition=function(node){const order=[...document.querySelectorAll('*')];return node===this?0:order.indexOf(node)>order.indexOf(this)?4:2;};
  document.querySelector('#text-images').getBoundingClientRect=()=>({width:800,height:12000,top:1000-window.scrollY});
  window.scrollTo=(_x,y)=>{window.scrollY=y;if(y>=9000&&!document.querySelector('#bottom'))document.querySelector('#text-images').insertAdjacentHTML('beforeend','<img id="bottom" data-src="//img.alicdn.com/bottom.jpg">');};
  let handler,polls=0;
  const context=vm.createContext({window,document,location:new URL('https://item.taobao.com/item.htm?id=123'),URL,
    getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'}),chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}}}});
  vm.runInContext(await readFile(new URL('../extension/detail-taobao.js',import.meta.url),'utf8'),context);
  const root={item:{itemId:'123',title:'水杯',images:['//img.alicdn.com/main.jpg']},skuBase:{props:[],skus:[]},skuCore:{sku2info:{'0':{price:{priceText:'8.50'},quantity:8}}}};
  const prior=globalThis.chrome;
  globalThis.chrome={tabs:{create:async()=>({id:7}),get:async()=>({id:7,status:'complete'}),remove:async()=>{},sendMessage:async(_id,message)=>{
    polls++;return new Promise(resolve=>handler({...message,pageGoods:{roots:[root]}},{},resolve));
  }},scripting:{executeScript:async()=>[{result:null}]}};
  try{const result=await browserPorts({save:async()=>{},update(){},detailPollWait:async()=>{}}).enrich({id:'123',site:'taobao',cents:850});
    assert.deepEqual(Array.from(result.detailImages),['https://img.alicdn.com/top.jpg','https://img.alicdn.com/bottom.jpg']);
    assert.equal(result.detailStatus,'done');assert.ok(polls>=15&&polls<=40);assert.equal(result.descriptionText,'');
  }finally{globalThis.chrome=prior;}
});
