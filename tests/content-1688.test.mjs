import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { encodeGbkQuery } from '../extension/lib/gbk.mjs';

async function snapshot(html, keyword = '相机', href = '') {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getBoundingClientRect = () => ({ width: 250, height: 350, top: 10, bottom: 360 });
  let handler;
  const page = href || `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}`;
  const context = vm.createContext({
    window, document, URL, TextDecoder, Uint8Array,
    location: { href: page, pathname: '/selloffer/offer_search.htm', hostname: 's.1688.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
    chrome: { runtime: { onMessage: { addListener: fn => { handler = fn; } } } },
    console, setTimeout, clearTimeout
  });
  vm.runInContext(await readFile(new URL('../extension/content-1688.js', import.meta.url), 'utf8'), context);
  return new Promise(resolve => handler({ type: 'PDD_SNAPSHOT' }, {}, resolve));
}

test('a 1688 offer card keeps one price even when the page adds 起', async () => {
  const data = await snapshot(`<a href="https://detail.1688.com/offer/5566.html"><img src="https://cbu01.alicdn.com/a.jpg"><h3>高清数码相机</h3><div>¥12.80起</div></a>`);
  assert.equal(data.blocked, false);
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0].id, '5566');
  assert.equal(data.cards[0].title, '高清数码相机');
  assert.equal(data.cards[0].priceText, '¥12.80');
  assert.equal(data.cards[0].url, 'https://detail.1688.com/offer/5566.html');
});

test('two prices on one 1688 card are left intact so the price parser can reject them', async () => {
  const data = await snapshot(`<a href="https://detail.1688.com/offer/7788.html"><img src="https://cbu01.alicdn.com/b.jpg"><h3>数码相机套装</h3><div>¥12.80</div><div>¥15.00</div></a>`);
  assert.equal(data.cards.length, 1);
  assert.match(data.cards[0].priceText, /¥12\.80/);
  assert.match(data.cards[0].priceText, /¥15\.00/);
  assert.notEqual(data.cards[0].priceText, '¥12.80');
});

test('a 1688 verification page blocks collection', async () => {
  const data = await snapshot('<div>请完成安全验证</div><a href="https://detail.1688.com/offer/1.html"><img src="https://cbu01.alicdn.com/a.jpg"><h3>数码相机</h3><div>¥9.90</div></a>');
  assert.equal(data.blocked, true);
});

test('a mobile offer link with a plain decimal price is still a product card', async () => {
  const data = await snapshot('<a href="https://detail.m.1688.com/page/index.html?offerId=5566"><img src="https://cbu01.alicdn.com/a.jpg"><div class="title">高清数码相机</div><div>12.80</div></a>');
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0].id, '5566');
  assert.equal(data.cards[0].title, '高清数码相机');
  assert.equal(data.cards[0].priceText, '¥12.80');
  assert.equal(data.cards[0].url, 'https://detail.1688.com/offer/5566.html');
});

test('a GBK search keyword still matches the Chinese product title', async () => {
  const href = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeGbkQuery('玉石手电筒')}`;
  const data = await snapshot('<a href="https://detail.1688.com/offer/8899.html"><img src="https://cbu01.alicdn.com/c.jpg"><h3>天然玉石手电筒</h3><div>¥19.90</div></a>', '玉石手电筒', href);
  assert.equal(data.cards[0].title, '天然玉石手电筒');
  assert.equal(data.cards[0].id, '8899');
});

test('1688 keeps image-free offer IDs and their own title and price, excluding hidden or foreign offers',async()=>{
  const data=await snapshot('<section><a href="https://detail.1688.com/offer/5566.html"><h3>数码相机</h3><div>¥12.80</div></a><a href="https://detail.1688.com/offer/7788.html"><img src=""><h3>高清相机</h3><div>¥15.00</div></a><a hidden href="https://detail.1688.com/offer/9999.html"><h3>相机</h3><div>¥1</div></a><a href="https://example.com/offer/1111.html"><h3>相机</h3><div>¥1</div></a></section>');
  assert.deepEqual(Array.from(data.cards,c=>[c.id,c.title,c.priceText,c.image]),[['5566','数码相机','¥12.80',''],['7788','高清相机','¥15.00','']]);
});
