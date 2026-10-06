import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

async function reader() {
  const module = await import('../extension/lib/pdd-search-page.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.readLivePddSearch, 'function', 'loaded PDD search reader must exist');
  return module.readLivePddSearch;
}

test('search reader returns only whitelisted product identity fields from loaded data without requesting anything',async()=>{
  const read=await reader();
  const rawData={store:{initDataObj:{list:[{goodsID:123,goodsName:'数码相机',thumbUrl:'https://img.pddpic.com/a.jpg',uin:'private',accessToken:'secret',price:99}]}}};
  rawData.loop=rawData;
  const context=vm.createContext({URL,location:{href:'https://mobile.yangkeduo.com/search_result.html?search_key=相机'},rawData,
    fetch:()=>{throw new Error('must not fetch');},XMLHttpRequest:()=>{throw new Error('must not request');}});
  const result=vm.runInContext(`(${read.toString()})()`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{url:'https://mobile.yangkeduo.com/search_result.html?search_key=%E7%9B%B8%E6%9C%BA',goods:[{id:'123',title:'数码相机',images:['https://img.pddpic.com/a.jpg']}]});
});

test('search reader rejects unsafe numeric IDs, recommendations, foreign pages and detail pages',async()=>{
  const read=await reader();
  const rawData={list:[{goodsId:9007199254740992,goodsName:'相机',thumbUrl:'https://img.pddpic.com/a.jpg'},{goodsId:'12345678901234567890',goodsName:'相机',thumbUrl:'https://img.pddpic.com/b.jpg'}],recommendations:[{goodsId:'999',goodsName:'相机',thumbUrl:'https://img.pddpic.com/c.jpg'}]};
  const run=url=>vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:url},rawData});
  assert.deepEqual(Array.from(run('https://mobile.pinduoduo.com/search_result.html?search_key=相机').goods,g=>g.id),['12345678901234567890']);
  assert.equal(run('https://example.com/search_result.html?search_key=相机'),null);
  assert.equal(run('https://mobile.pinduoduo.com/goods.html?goods_id=123'),null);
});

test('reads committed product props associated with visible card DOM after client loading, without a rawData root',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="72"><img src="https://img.pddpic.com/a.jpg"></div></body></html>');
  const card=document.querySelector('[data-uniqid]'),img=card.querySelector('img');
  const goods={goodsID:'123',goodsName:'牙刷软毛',thumbUrl:'https://img.pddpic.com/a.jpg',uin:'private',token:'secret'};
  card.__reactProps$fixture={children:{props:{data:goods}},onClick:()=>{throw new Error('must not click');}};
  img.__reactFiber$fixture={memoizedProps:{src:img.src},return:{memoizedProps:{data:goods,store:{token:'secret'}},return:null},alternate:{memoizedProps:{data:{...goods,goodsID:'999'}}}};
  const run=()=>vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'}),fetch:()=>{throw new Error('must not fetch');}});
  const result=run();assert.deepEqual(Array.from(result.goods,g=>g.id),['123']);assert.doesNotMatch(JSON.stringify(result),/private|secret|999/);
  goods.goodsID='456';assert.deepEqual(Array.from(run().goods,g=>g.id),['456']);
  card.hidden=true;assert.equal(run().goods.length,0);
});

test('uses the committed alternate branch when the DOM fiber points at the previous render and ignores uncommitted props',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="1"><img></div></body></html>');
  const currentRoot={tag:3,stateNode:null,return:null},oldRoot={tag:3,stateNode:null,return:null};
  currentRoot.stateNode=oldRoot.stateNode={current:currentRoot};
  const goods=id=>({goods_id:id,goods_name:'牙刷',thumb_url:'https://img.pddpic.com/a.jpg'});
  const current={memoizedProps:{data:goods('123')},pendingProps:{data:goods('999')},return:currentRoot};
  const old={memoizedProps:{data:goods('456')},return:oldRoot,alternate:current};
  currentRoot.child=current;oldRoot.child=old;
  current.alternate=old;document.querySelector('img').__reactFiber$fixture=old;
  const result=vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  assert.deepEqual(Array.from(result.goods,g=>g.id),['123']);
});

test('resolves committed child membership when alternate fibers share the current return parent',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="1"><img></div></body></html>');
  const root={tag:3,return:null};root.stateNode={current:root};
  const parent={return:root};root.child=parent;
  const goods=id=>({goods_id:id,goods_name:'牙刷',thumb_url:'https://img.pddpic.com/a.jpg'});
  const current={memoizedProps:{data:goods('123')},return:parent};
  const old={memoizedProps:{data:goods('456')},return:parent,alternate:current};
  current.alternate=old;parent.child=current;
  document.querySelector('img').__reactFiber$fixture=old;
  const result=vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  assert.deepEqual(Array.from(result.goods,g=>g.id),['123']);
});

test('reads current ancestor props when a reused child still returns to the previous parent',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="1"><img></div></body></html>');
  const root={tag:3,return:null};root.stateNode={current:root};
  const goods=id=>({goods_id:id,goods_name:'牙刷',thumb_url:'https://img.pddpic.com/a.jpg'});
  const current={memoizedProps:{data:goods('123')},return:root};
  const old={memoizedProps:{data:goods('456')},return:root,alternate:current};
  current.alternate=old;root.child=current;
  const shared={memoizedProps:{src:'https://img.pddpic.com/a.jpg'},return:old};
  old.child=current.child=shared;
  document.querySelector('img').__reactFiber$fixture=shared;
  const result=vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  assert.deepEqual(Array.from(result.goods,g=>g.id),['123']);
});

test('does not infer goods IDs from list positions, event functions or private stores',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="123"><img></div></body></html>');
  document.querySelector('img').__reactProps$fixture={store:{data:{goodsID:'999',goodsName:'牙刷',thumbUrl:'https://img.pddpic.com/a.jpg'}},onClick:()=>{throw new Error('must not invoke event');}};
  const result=vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  assert.equal(result.goods.length,0);
});

test('reads observed goodsData records with imgUrl instead of thumbUrl',async()=>{
  const read=await reader(),{document}=parseHTML('<html><body><div data-uniqid="72"><img></div></body></html>');
  document.querySelector('img').__reactProps$fixture={goodsData:{goodsID:910957227286,goodsName:'【倍加洁】黑白软毛牙刷学生情侣护龈深层清洁成人家庭装高档宿舍家用',imgUrl:'https://img.pddpic.com/mms-material-img/2024-05-11/a7bae866-f4f1-4bb1-a101-5634fd19d73d.jpeg',logData:{token:'secret'},goodsIndex:72}};
  const result=vm.runInNewContext(`(${read.toString()})()`,{URL,location:{href:'https://mobile.pinduoduo.com/search_result.html?search_key=牙刷'},document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  assert.deepEqual(JSON.parse(JSON.stringify(result.goods)),[{id:'910957227286',title:'【倍加洁】黑白软毛牙刷学生情侣护龈深层清洁成人家庭装高档宿舍家用',images:['https://img.pddpic.com/mms-material-img/2024-05-11/a7bae866-f4f1-4bb1-a101-5634fd19d73d.jpeg']}]);
});
