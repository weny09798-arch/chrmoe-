import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPorts, productId, searchUrl } from '../extension/lib/browser.mjs';
import { createTask } from '../extension/lib/core.mjs';

test('search URL encodes a keyword as one query value',()=>{
  const value=searchUrl('相机 & 充电器?#');
  const url=new URL(value);
  assert.equal(url.origin,'https://mobile.pinduoduo.com');assert.equal(url.searchParams.get('search_key'),'相机 & 充电器?#');assert.equal([...url.searchParams].length,1);
});
test('product ID extraction rejects foreign sites and malformed IDs',()=>{
  assert.equal(productId('https://mobile.pinduoduo.com/goods.html?goods_id=1234'),'1234');
  assert.equal(productId('https://mobile.pinduoduo.com.attacker.example/goods.html?goods_id=1234'),'');
  assert.equal(productId('javascript:alert(1)'),'');
  assert.equal(productId('https://mobile.pinduoduo.com/goods.html?goods_id=NaN'),'');
});
test('image access requests only the observed source and never fetches before permission',async()=>{
  const prior=globalThis.chrome, priorFetch=globalThis.fetch; let requested, fetched=false;
  globalThis.chrome={permissions:{contains:async value=>{requested=value;return false;}}};
  globalThis.fetch=async()=>{fetched=true;throw new Error('must not reach network');};
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});
    await assert.rejects(()=>ports.hash('https://img.pddpic.com/goods/a.jpg'),error=>error.blocked&&error.permissionOrigin==='https://img.pddpic.com/*');
    assert.deepEqual(requested,{origins:['https://img.pddpic.com/*']});assert.equal(fetched,false);
    await assert.rejects(()=>ports.hash('https://img.pddpic.com.attacker.example/a.jpg'),/暂不支持/);
  } finally {globalThis.chrome=prior;globalThis.fetch=priorFetch;}
});
test('manual navigation to a different search pauses rather than saving unrelated goods',async()=>{
  const prior=globalThis.chrome; const task=createTask(['相机']); task.tabId=42;
  let pageUrl=searchUrl('相机');
  globalThis.chrome={
    tabs:{get:async()=>({id:42,status:'complete',url:pageUrl}),sendMessage:async()=>({url:pageUrl,cards:[],blocked:false})},
    scripting:{executeScript:async()=>{}}
  };
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});await ports.open(task.jobs[0],task);
    pageUrl=searchUrl('书包');
    await assert.rejects(()=>ports.read(task.jobs[0]),error=>error.blocked&&/离开/.test(error.message));
  } finally {globalThis.chrome=prior;}
});
test('returning from a same-tab product detail restores the requested search explicitly',async()=>{
  const prior=globalThis.chrome; const task=createTask(['苹果手机壳']);task.tabId=42;
  let pageUrl=searchUrl('苹果手机壳'), updates=0;
  globalThis.chrome={
    tabs:{
      get:async()=>({id:42,status:'complete',url:pageUrl}),
      update:async(_id,change)=>{updates++;pageUrl=change.url;return {id:42,url:pageUrl};},
      goBack:async()=>{pageUrl='https://mobile.pinduoduo.com/index.html';},
      sendMessage:async(_id,message)=>{
        if(message.type==='PDD_OPEN_CARD'){pageUrl='https://mobile.pinduoduo.com/goods.html?goods_id=123';return {ok:true};}
        if(message.type==='PDD_SCROLL') return {ok:true};
        return {url:pageUrl,cards:[{key:'card-1'}],blocked:false,position:0};
      },
      onCreated:{addListener(){},removeListener(){}},remove:async()=>{}
    },
    scripting:{executeScript:async()=>{}}
  };
  try {
    const ports=browserPorts({save:async()=>{},update:()=>{}});await ports.open(task.jobs[0],task);
    const result=await ports.resolve({key:'card-1'}, {position:0}, task.jobs[0]);
    assert.equal(result.id,'123');assert.equal(result.navigated,true);
    assert.equal(pageUrl,searchUrl('苹果手机壳'));assert.equal(updates,1);
  } finally {globalThis.chrome=prior;}
});
