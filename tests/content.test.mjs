import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

async function snapshot(html, keyword='相机', searchData) {
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getBoundingClientRect=()=>({width:250,height:350,top:10,bottom:360});
  let handler;
  const context=vm.createContext({window, document, URL, location:{href:`https://mobile.pinduoduo.com/search_result.html?search_key=${encodeURIComponent(keyword)}`,pathname:'/search_result.html'},getComputedStyle:()=>({display:'block',visibility:'visible',overflowY:'visible'}),chrome:{runtime:{onMessage:{addListener:fn=>handler=fn}}}, console, setTimeout, clearTimeout});
  vm.runInContext(await readFile(new URL('../extension/content.js',import.meta.url),'utf8'),context);
  return new Promise(resolve=>handler({type:'PDD_SNAPSHOT',searchData}, {},resolve));
}

test('loaded search data supplies a unique matching ID without overwriting card price or source link',async()=>{
  const html='<div role="button"><img src="https://img.pddpic.com/a.jpg?imageMogr2/thumbnail/200x"><div>数码相机</div><div>¥32</div></div>';
  const searchData={url:'https://mobile.pinduoduo.com/search_result.html?search_key=相机',goods:[{id:'123',title:'数码相机',images:['https://img.pddpic.com/a.jpg']}]};
  const data=await snapshot(html,'相机',searchData);
  assert.equal(data.cards[0].id,'123');assert.equal(data.cards[0].url,'https://mobile.pinduoduo.com/goods.html?goods_id=123');assert.match(data.cards[0].priceText,/¥32/);
});

test('loaded search data rejects mismatched titles, images, ambiguous IDs and another keyword',async()=>{
  const html='<div role="button"><img src="https://img.pddpic.com/a.jpg"><div>数码相机</div><div>¥32</div></div>';
  for(const goods of [
    [{id:'1',title:'另一相机',images:['https://img.pddpic.com/a.jpg']}],
    [{id:'1',title:'数码相机',images:['https://img.pddpic.com/b.jpg']}],
    [{id:'1',title:'数码相机',images:['https://img.pddpic.com/a.jpg']},{id:'2',title:'数码相机',images:['https://img.pddpic.com/a.jpg']}]
  ])assert.equal((await snapshot(html,'相机',{url:'https://mobile.pinduoduo.com/search_result.html?search_key=相机',goods})).cards[0].id,'');
  assert.equal((await snapshot(html,'相机',{url:'https://mobile.pinduoduo.com/search_result.html?search_key=书包',goods:[{id:'1',title:'数码相机',images:['https://img.pddpic.com/a.jpg']}]})).cards[0].id,'');
});
test('reads two similar-image cards independently and joins split price digits',async()=>{
  const data=await snapshot(`<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><h3>高清数码相机</h3><div>立减20元</div><div>券后<span>¥</span><span>29</span><small>.88</small></div><span>已拼7万</span></a><a href="/goods.html?goods_id=456"><img src="https://img.pddpic.com/b.jpg"><h3>同款相机</h3><div>券后¥32</div></a>`);
  assert.equal(data.cards.length,2); assert.equal(data.cards[0].id,'123'); assert.match(data.cards[0].priceText,/¥29\.88/);assert.equal(data.cards[1].id,'456');
});

test('search anchor retains its detail navigation context separately from the clean export URL',async()=>{
  const data=await snapshot('<a href="/goods.html?goods_id=123&amp;page_from=23&amp;_oak_list_price_sign=price-proof"><h3>高清相机</h3><span>¥32</span></a>');
  assert.equal(data.cards[0].detailSourceUrl,'https://mobile.pinduoduo.com/goods.html?goods_id=123&page_from=23&_oak_list_price_sign=price-proof');
  assert.equal(data.cards[0].url,'https://mobile.pinduoduo.com/goods.html?goods_id=123');
});
test('ignores hidden cards and unrelated small icons',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123" hidden><img src="https://img.pddpic.com/a.jpg"><div>¥32</div></a><img width="20" height="20" src="https://img.pddpic.com/icon.png">');
  assert.equal(data.cards.length,0);
});

test('valid product links are independent of absent or unloaded search images',async()=>{
  const data=await snapshot('<section><div><a href="goods.html?goods_id=123"><h3>数码相机</h3><span>¥12.80</span></a></div><div><a href="goods.html?goods_id=456"><img src=""><h3>高清相机</h3><span>¥15.00</span></a></div></section>');
  assert.deepEqual(Array.from(data.cards,c=>[c.id,c.title,c.image]),[['123','数码相机',''],['456','高清相机','']]);
  assert.match(data.cards[0].priceText,/¥12\.80/);assert.doesNotMatch(data.cards[0].priceText,/¥15\.00/);
});

test('image-free product extraction ignores hidden and foreign links without merging two card prices',async()=>{
  const data=await snapshot('<div><a hidden href="goods.html?goods_id=11"><h3>相机</h3><span>¥1</span></a><a href="https://example.com/goods.html?goods_id=22"><h3>相机</h3><span>¥2</span></a><a href="goods.html?goods_id=33"><h3>相机</h3><span>¥3</span></a></div>');
  assert.deepEqual(Array.from(data.cards,c=>c.id),['33']);
  assert.equal(data.cards[0].priceText,'相机¥3');
});
test('visible validation dialog blocks extraction even with cards behind it',async()=>{
  const data=await snapshot('<div role="dialog">请完成安全验证 拖动滑块</div><a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><div>¥32</div></a>');
  assert.equal(data.blocked,true);
});
test('div cards without URLs are retained for safe detail-link resolution',async()=>{
  const data=await snapshot('<div role="button"><img src="https://img.pddpic.com/a.jpg"><div>数码相机</div><div>券后¥32</div></div>');
  assert.equal(data.cards.length,1);assert.equal(data.cards[0].id,'');assert.equal(data.cards[0].title,'数码相机');
});
test('uses the merchandise name after guarantee, reviews and delivery badges',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><span>已缴纳保证金</span><span>好评超98%同款</span><span>1万+人好评</span><span>广东地区不配送</span><div>高清数码相机双摄自拍</div><span>¥29.88</span></a>');
  assert.equal(data.cards[0].title,'高清数码相机双摄自拍');
});
test('does not export a heading badge as the product name',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><h3><span>已缴纳保证金</span>高清数码相机</h3><div>¥29.88</div></a>');
  assert.equal(data.cards[0].title,'高清数码相机');
});
test('keeps the name when a discount badge is directly joined to title text',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><h3>立减20元高清数码相机</h3><div>¥29.88</div></a>');
  assert.equal(data.cards[0].title,'高清数码相机');
});
test('leaves the title empty when a card only contains promotional badges',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><span>已缴纳保证金</span><span>好评超98%同款</span><span>1万+人好评</span><span>广东地区不配送</span><span>¥29.88</span></a>');
  assert.equal(data.cards[0].title,'');
});
test('chooses the searched product name after return and sales labels',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><span>未发货秒退</span><span>本店已拼500万+</span><span>本店已拼17.8万+</span><span>本店已拼92.7万+</span><span>本店已拼2.8万</span><div>苹果手机壳透明防摔</div><span>¥29.88</span></a>','苹果手机壳');
  assert.equal(data.cards[0].title,'苹果手机壳透明防摔');
});
test('does not accept a title with no meaningful character shared with the search',async()=>{
  const data=await snapshot('<a href="goods.html?goods_id=123"><img src="https://img.pddpic.com/a.jpg"><h3>蓝牙音箱</h3><span>¥29.88</span></a>','苹果手机壳');
  assert.equal(data.cards[0].title,'');
});
