import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readLiveTaobao} from '../extension/lib/taobao-page.mjs';
import {browserPorts,descriptionDocumentUrl} from '../extension/lib/browser.mjs';
import {enqueueKeyword} from '../extension/lib/core.mjs';

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
