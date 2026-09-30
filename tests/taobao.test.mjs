import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
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
});

async function page(html, href='https://s.taobao.com/search?q=相机') {
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`);
  document.documentElement.scrollTop=0;
  Object.defineProperties(document.documentElement,{clientHeight:{value:600},scrollHeight:{value:600}});
  let handler; const location=new URL(href);
  const context=vm.createContext({window,document,location,URL,TextDecoder,Uint8Array,console,setTimeout,
    getComputedStyle: node=>({display:node.hidden?'none':'block',visibility:'visible',overflowY:'visible'}),
    chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}}}});
  vm.runInContext(await readFile(new URL('../extension/content-taobao.js',import.meta.url),'utf8'),context);
  return {document,send: message=>new Promise(resolve=>handler(message,{},resolve))};
}
const card=(id,title='高清数码相机',host='item.taobao.com')=>`<a href="https://${host}/item.htm?id=${id}"><img src="//img.alicdn.com/item-${id}.jpg"><div class="Title--title--x">${title}</div><div class="Price--priceText--x"><span>¥</span><span>12</span><span>.80</span></div><span>2000+人付款</span><span>退货包运费</span></a>`;

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
