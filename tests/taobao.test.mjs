import test from 'node:test';
import assert from 'node:assert/strict';
import {taobaoPage as page,taobaoCard as card} from './helpers/taobao-page.mjs';
import {resolveSite, siteForJob} from '../extension/lib/sites.mjs';
import {enqueueKeyword, retryJob} from '../extension/lib/core.mjs';

test('Taobao source, exact item hosts and search keyword persist through retry', () => {
  const site=resolveSite('https://www.taobao.com/');
  assert.equal(site.id,'taobao'); assert.equal(site.supported,true);
  const url=site.searchUrl('相机 & 配件');
  assert.equal(new URL(url).searchParams.get('q'),'相机 & 配件');
  assert.equal(site.isSearch(url,'相机 & 配件'),true);
  assert.equal(site.isSearch(url,'书包'),false);
  assert.equal(site.productId('https://item.taobao.com/item.htm?id=123&spm=abc'),'123');
  assert.equal(site.productId('https://detail.tmall.com/item.htm?id=123'),'123');
  assert.equal(site.productId('https://item.taobao.com.attacker.example/item.htm?id=123'),'');
  assert.equal(site.productId('https://login.taobao.com/item.htm?id=123'),'');
  assert.equal(site.productId('https://item.taobao.com/item.htm?id=no'),'');
  assert.equal(resolveSite('https://taobao.com.attacker.example/').supported,false);
  const task=enqueueKeyword(null,'相机','taobao',{limit:2}); retryJob(task,0);
  assert.equal(siteForJob(task.jobs[0]).id,'taobao'); assert.equal(task.jobs[0].limit,2);
  assert.equal(task.jobs[0].restartSearch,true);
});

test('search cards keep split current price and canonical Taobao/Tmall links',async()=>{
  const f=await page(card('123')+card('456','专业数码相机','detail.tmall.com'));
  const data=await f.send({type:'PDD_SNAPSHOT'});
  assert.equal(data.blocked,false); assert.equal(data.cards.length,2);
  assert.equal(data.cards[0].priceText,'¥12.80'); assert.equal(data.cards[0].title,'高清数码相机');
  assert.equal(data.cards[0].url,'https://item.taobao.com/item.htm?id=123');
  assert.equal(data.cards[1].url,'https://detail.tmall.com/item.htm?id=456');
});

test('search ignores hidden cards, outside URLs, duplicate IDs and service-only names',async()=>{
  const f=await page(card('123')+card('123')+`<div hidden>${card('456')}</div>`+card('777','满减优惠相机包邮')+card('888','高清相机','item.taobao.com.attacker.example'));
  const data=await f.send({type:'PDD_SNAPSHOT'});
  assert.deepEqual(Array.from(data.cards,c=>c.id),['123','777']);
  assert.equal(data.cards[1].title,'');
});

test('explicit next page is clicked once at bottom and never during position restoration',async()=>{
  const f=await page(card('123')+'<a aria-label="下一页" href="https://s.taobao.com/search?q=相机&s=48">下一页</a>');
  let clicks=0; f.document.querySelector('[aria-label="下一页"]').click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL',position:0}); assert.equal(clicks,0);
  await f.send({type:'PDD_SCROLL'}); await f.send({type:'PDD_SCROLL'}); assert.equal(clicks,1);
});

test('verification and login return blocked before any goods are processed',async()=>{
  const verify=await page('<div>请完成安全验证</div>'+card('123'));
  assert.equal((await verify.send({type:'PDD_SNAPSHOT'})).blocked,true);
  const login=await page('<div>密码登录</div>','https://login.taobao.com/member/login.jhtml');
  assert.equal((await login.send({type:'PDD_SNAPSHOT'})).blocked,true);
});

test('an explicit disabled last-page control at bottom confirms the search end',async()=>{
  const f=await page(card('123')+'<div class="Pagination"><button disabled aria-label="下一页">下一页</button></div>');
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).end,true);
});

test('a thousands-separated actual sale price is not confused with sales counts',async()=>{
  const f=await page(card('123').replace('<span>12</span><span>.80</span>','<span>1,299</span><span>.00</span>'));
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'¥1299.00');
});

test('main image selection uses displayed size instead of an unlabelled promotion badge',async()=>{
  const f=await page(card('123').replace('<img src=', '<img src="//img.alicdn.com/shared-campaign.jpg"><img src='));
  const images=f.document.querySelectorAll('img');
  images[0].getBoundingClientRect=()=>({width:96,height:18});
  images[1].getBoundingClientRect=()=>({width:280,height:280});
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].image,'https://img.alicdn.com/item-123.jpg');
});

test('sale price keeps an integer amount with a promotion suffix and separate coupon savings',async()=>{
  const f=await page(card('123').replace('<span>12</span><span>.80</span>','<span class="Price--priceInt">13</span><span>优惠后</span>').replace('<span>2000+人付款</span>','<div class="Price--promotion">超级立减12% 淘金币抵1.68元</div><span>2000+人付款</span>'));
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'¥13.00');
});

test('a decimal discount in a price-labelled node never replaces the sale amount',async()=>{
  const f=await page(card('123').replace('<span>12</span><span>.80</span>','<span class="Price--priceInt">13</span><span>优惠后</span>').replace('</a>','<div class="Price--coupon">1.68</div></a>'));
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'¥13.00');
});

test('div pagination next control is clicked at the bottom with its nested label',async()=>{
  const f=await page(card('123')+'<div class="Pagination--root"><div class="Pagination--prevNext"><span>下一页</span><svg></svg></div><span>1/100</span></div>');
  let clicks=0;f.document.querySelector('.Pagination--prevNext').click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});
  assert.equal(clicks,1);
});

test('disabled div ancestor ends pagination and never clicks its nested next label',async()=>{
  const f=await page(card('123')+'<div class="Pagination"><div class="next disabled"><span>下一页</span></div><span>100/100</span></div>');
  let clicks=0;f.document.querySelector('.next').click=()=>{clicks++;};
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).end,true);
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,0);
});

test('page transition is pending for stale or empty results and ends only after the new list arrives',async()=>{
  const f=await page(card('123')+'<div class="Pagination"><button>下一页</button></div>');
  let clicks=0;f.document.querySelector('button').click=()=>{clicks++;f.location.search='?q=相机&page=2';};
  await f.send({type:'PDD_SCROLL'});
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).paginationPending,true);
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,1);
  f.document.querySelector('a').remove();
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).paginationPending,true);
  f.document.body.insertAdjacentHTML('afterbegin',card('456'));
  f.document.documentElement.scrollTop=900;
  const loaded=await f.send({type:'PDD_SNAPSHOT'});
  assert.equal(loaded.paginationPending,false);assert.equal(loaded.cards[0].id,'456');
  assert.equal(loaded.position,0);
});

test('pagination timeout reports its real failure without an automatic click loop',async()=>{
  const f=await page(card('123')+'<div class="Pagination"><button>下一页</button></div>');
  let clicks=0;f.document.querySelector('button').click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});f.advance(25001);
  const data=await f.send({type:'PDD_SNAPSHOT'});
  assert.match(data.paginationError,/翻页/);
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,1);
});

test('pagination never clicks an unrelated next button or an external link',async()=>{
  const f=await page(card('123')+'<button>下一页</button><div class="Pagination"><a href="https://example.com/search?q=相机">下一页</a></div>');
  let clicks=0;for(const n of f.document.querySelectorAll('button,a'))n.click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,0);
});

test('an external next link cannot bypass host validation through its nested span',async()=>{
  const f=await page(card('123')+'<div class="Pagination"><a href="https://example.com/search?q=相机"><span>下一页</span></a></div>');
  let clicks=0;for(const n of f.document.querySelectorAll('a,span'))n.click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,0);
});

test('a standalone span or role button next control remains supported in a pager',async()=>{
  for(const tag of ['span','div role="button"']) {
    const close=tag.startsWith('div')?'div':'span';
    const f=await page(card('123')+`<div class="Pagination"><${tag} class="go-next">下一页</${close}><span>1/100</span></div>`);
    let clicks=0;f.document.querySelector('.go-next').click=()=>{clicks++;};
    await f.send({type:'PDD_SCROLL'});assert.equal(clicks,1);
  }
});

test('removing or hiding a subset of old cards is not proof that the next page loaded',async()=>{
  const f=await page(card('123')+card('456')+'<div class="Pagination"><button>下一页</button></div>');
  let clicks=0;f.document.querySelector('button').click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});f.document.querySelector('a').remove();
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).paginationPending,true);
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,1);
});

test('a currency-marked coupon is not substituted when the real sale price is unavailable',async()=>{
  const f=await page(card('123').replace('<span>12</span><span>.80</span>','<span>不明</span>').replace('</a>','<div class="Price--coupon"><span>¥1.68</span></div></a>'));
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'');
});

test('an empty page with a next control is never skipped before its first goods load',async()=>{
  const f=await page('<div class="Pagination"><button>下一页</button></div>');
  let clicks=0;f.document.querySelector('button').click=()=>{clicks++;};
  await f.send({type:'PDD_SCROLL'});assert.equal(clicks,0);
});

test('prepare card scrolls just that product into view without clicking goods or pagination',{timeout:100},async()=>{
  const f=await page(card('1')+card('2'));let scrolls=0,clicks=0;
  const a=f.document.querySelectorAll('a');
  a[0].scrollIntoView=()=>{throw new Error('Wrong card scrolled');};a[1].scrollIntoView=()=>{scrolls++;};
  for(const el of a)el.click=()=>{clicks++;};
  const response=await f.send({type:'PDD_PREPARE_CARD',key:'2'});
  assert.equal(response.ok,true);assert.equal(scrolls,1);assert.equal(clicks,0);
});

test('large lazy product image accepts data-ks-lazyload and source srcset without choosing a badge',async()=>{
  for(const image of ['<img data-ks-lazyload="//img.alicdn.com/main-1.jpg" src="data:image/gif;base64,blank">','<picture><source srcset="//img.alicdn.com/main-1.jpg 600w"><img src="data:image/gif;base64,blank"></picture>']) {
    const f=await page(card('1').replace('<img src="//img.alicdn.com/item-1.jpg">',image));
    assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].image,'https://img.alicdn.com/main-1.jpg');
  }
});

test('split currency and digits in a price region ignore following buyer counts',async()=>{
  const f=await page(card('1').replace('<span>12</span><span>.80</span>','<span>58</span><span>.31</span><span>补贴后</span><span>600+人付款</span>'));
  assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'¥58.31');
});

test('a decimal buyer count is removed only at the end of a labelled sale price',async()=>{
  for(const count of ['1.2万人付款','2.5千+人收货']) {
    const f=await page(card('1').replace('<span>12</span><span>.80</span>',`<span>58</span><span>.31</span><span>补贴后</span><span>${count}</span>`));
    assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'¥58.31');
  }
});

test('buyer count never conceals an additional non-original price in the same region',async()=>{
  for(const suffix of ['<span>补贴后600+人付款¥68.31</span>','<span>补贴后</span><span>600+人付款</span><span>¥68.31</span>','<span>-</span><span>68.31</span>']) {
    const f=await page(card('1').replace('<span>12</span><span>.80</span>',`<span>58</span><span>.31</span>${suffix}`));
    assert.equal((await f.send({type:'PDD_SNAPSHOT'})).cards[0].priceText,'');
  }
});
