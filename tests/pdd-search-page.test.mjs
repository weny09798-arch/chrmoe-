import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

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
