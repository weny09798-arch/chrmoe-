import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

async function detailPage(html, goodsId = '123') {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 300 });
  const listeners = [];
  const url = `https://mobile.pinduoduo.com/goods.html?goods_id=${goodsId}`;
  const location = { href: url, pathname: '/goods.html' };
  const context = vm.createContext({
    window, document, URL,
    location,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: { onMessage: { addListener: fn => { listeners.push(fn); } } } },
    console
  });
  const source = await readFile(new URL('../extension/detail-content.js', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const inject = () => vm.runInContext(source, context);
  inject();
  assert.ok(listeners.length, 'PDD_DETAIL_SNAPSHOT message handler must be installed');
  return {
    location,
    inject,
    listenerCount: () => listeners.length,
    snapshot: () => new Promise(resolve => listeners[0]({ type: 'PDD_DETAIL_SNAPSHOT' }, {}, resolve))
  };
}

async function snapshot(html, goodsId = '123') {
  return (await detailPage(html, goodsId)).snapshot();
}

test('reads the current product with its actual two-dimensional SKU combinations', async () => {
  const html = `
    <main data-goods-id="123">
      <h1>当前商品</h1>
      <div data-role="gallery"><img src="https://img.pddpic.com/main.jpg"></div>
      <div data-role="detail"><img src="https://img.pddpic.com/detail.jpg"></div>
      <div data-role="certificate"><img src="https://img.pddpic.com/cert.jpg"></div>
      <div data-role="size-chart"><img src="https://img.pddpic.com/size.jpg"></div>
      <dl><dt>材质</dt><dd>棉</dd></dl>
      <video src="https://video.pddpic.com/demo.mp4"></video>
    </main>
    <script type="application/json" id="__PDD_DETAIL_DATA__">${JSON.stringify({ goods: {
      goodsId: '123', goodsName: '当前商品',
      price: '20.00', cents: 2000,
      gallery: ['https://img.pddpic.com/main.jpg'],
      detailGallery: ['https://img.pddpic.com/detail.jpg'],
      properties: [{ name: '材质', value: '棉' }],
      videoUrl: 'https://video.pddpic.com/demo.mp4',
      specNames: ['颜色', '尺码'],
      skus: [
        { id: 'sku-red-s', specs: ['红色', 'S'], price: '19.90', image: 'https://img.pddpic.com/red.jpg', stock: '8', weightKg: '0.2', sizeCm: '20x30' },
        { id: 'sku-blue-m', specs: ['蓝色', 'M'], price: '21.50', image: 'https://img.pddpic.com/blue.jpg', stock: '4', weightKg: '0.3', sizeCm: '25x35' }
      ]
    } })}</script>
    <aside data-role="recommendations" data-goods-id="999"><h2>推荐商品</h2><img src="https://img.pddpic.com/recommend.jpg"></aside>`;
  const result = await snapshot(html);
  assert.equal(result.url, 'https://mobile.pinduoduo.com/goods.html?goods_id=123');
  assert.equal(result.goodsId, '123');
  assert.equal(result.blocked, false);
  assert.equal(result.ready, true);
  assert.equal(result.source, 'json');
  assert.equal(result.detail.title, '当前商品');
  assert.equal(result.detail.price, '20.00');
  assert.equal(result.detail.cents, 2000);
  assert.deepEqual(Array.from(result.detail.specNames), ['颜色', '尺码']);
  assert.deepEqual(Array.from(result.detail.skus, sku => Array.from(sku.specs)), [['红色', 'S'], ['蓝色', 'M']]);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.id), ['sku-red-s', 'sku-blue-m']);
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://img.pddpic.com/main.jpg']);
  assert.deepEqual(Array.from(result.detail.detailImages), ['https://img.pddpic.com/detail.jpg']);
  assert.deepEqual(Array.from(result.detail.certificateImages), ['https://img.pddpic.com/cert.jpg']);
  assert.deepEqual(Array.from(result.detail.sizeChartImages), ['https://img.pddpic.com/size.jpg']);
  assert.deepEqual(Array.from(result.detail.attributes, item => [item.name, item.value]), [['材质', '棉']]);
  assert.equal(result.detail.videoUrl, 'https://video.pddpic.com/demo.mp4');
});

test('ignores matching fields in other products and never invents SKU combinations from DOM', async () => {
  const html = `
    <main data-goods-id="123"><h1>页面商品</h1><div data-role="gallery"><img src="https://img.pddpic.com/current.jpg"></div><dl><dt>面料</dt><dd>亚麻</dd></dl></main>
    <aside data-role="recommendations" data-goods-id="999"><h2>推荐商品</h2><img src="https://img.pddpic.com/other.jpg"></aside>
    <script type="application/json" id="__PDD_DETAIL_DATA__">${JSON.stringify({ goods: { goodsId: '999', goodsName: '错误根商品', gallery: ['https://img.pddpic.com/wrong.jpg'], specNames: ['颜色', '尺码'], skus: [{ id: 'wrong', specs: ['黑', 'L'], price: '1.00' }] } })}</script>
    <script type="application/json">${JSON.stringify({ recommendations: [{ goodsId: '999', goodsName: '推荐商品', skus: [{ id: 'rec', specs: ['白'], price: '2.00' }] }] })}</script>`;
  const result = await snapshot(html);
  assert.equal(result.detail.title, '页面商品');
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://img.pddpic.com/current.jpg']);
  assert.deepEqual(Array.from(result.detail.attributes, item => [item.name, item.value]), [['面料', '亚麻']]);
  assert.deepEqual(Array.from(result.detail.specNames), []);
  assert.deepEqual(Array.from(result.detail.skus), []);
  assert.equal(result.ready, false);
  assert.equal(result.source, 'dom');
  assert.equal(JSON.stringify(result.detail).includes('推荐商品'), false);
});

test('reads only explicit product-root prices and ignores promotional text numbers', async () => {
  const result = await snapshot(`
    <main data-goods-id="123"><h1>商品</h1><p>立减 99 元，本店已拼 500 万+</p></main>
    <script type="application/json">${JSON.stringify({ goods: { goodsId: '123', goodsName: '商品', price: '20.00', cents: 2000 } })}</script>`);
  assert.equal(result.detail.price, '20.00');
  assert.equal(result.detail.cents, 2000);
  assert.equal(JSON.stringify(result.detail).includes('99'), false);
});

test('reports a visible validation challenge before exporting product data', async () => {
  const result = await snapshot('<main data-goods-id="123"><h1>商品</h1></main><div role="dialog">请完成验证，拖动滑块</div>');
  assert.equal(result.blocked, true);
  assert.match(result.reason, /请完成验证|拖动滑块/);
  assert.equal(result.detail, null);
});

test('does not turn missing media URLs into the product page URL', async () => {
  const result = await snapshot('<main data-goods-id="123"><h1>商品</h1><img><video></video></main>');
  assert.deepEqual(Array.from(result.detail.galleryImages), []);
  assert.equal(result.detail.videoUrl, '');
});

test('accepts only the top-level goods root even when an earlier side branch has the same ID', async () => {
  const html = `
    <main data-goods-id="123"><h1>页面商品</h1></main>
    <script type="application/json">${JSON.stringify({ alsoViewed: { goodsId: '123', goodsName: '旁支商品', specNames: ['错误规格'], skus: [{ id: 'wrong', specs: ['错误'], price: '1.00' }] } })}</script>
    <script type="application/json" id="__PDD_DETAIL_DATA__">${JSON.stringify({
      alsoViewed: { goodsId: '123', goodsName: '同 ID 推荐商品', skus: [{ id: 'rec', specs: ['推荐'], price: '2.00' }] },
      goods: { goodsId: '123', goodsName: '根商品', specNames: ['颜色'], skus: [{ id: 'real', specs: ['红'], price: '19.00' }] }
    })}</script>`;
  const result = await snapshot(html);
  assert.equal(result.detail.title, '根商品');
  assert.deepEqual(Array.from(result.detail.specNames), ['颜色']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.id), ['real']);
});

test('ignores an earlier recommendation DOM branch carrying the current goods ID', async () => {
  const result = await snapshot(`
    <aside data-role="recommendations" data-goods-id="123"><h1>推荐副本</h1><img src="https://img.pddpic.com/recommended.jpg"></aside>
    <main data-goods-id="123"><h1>真正商品</h1><img src="https://img.pddpic.com/real.jpg"></main>`);
  assert.equal(result.detail.title, '真正商品');
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://img.pddpic.com/real.jpg']);
});

test('reads the current URL goods ID for each message after History API navigation', async () => {
  const html = `
    <main data-goods-id="123"><h1>第一件</h1></main>
    <main data-goods-id="456"><h1>第二件</h1></main>
    <script type="application/json">${JSON.stringify({ goods: { goodsId: '123', goodsName: '第一件', skus: [{ id: 'first', specs: ['小'], price: '10.00' }] } })}</script>
    <script type="application/json">${JSON.stringify({ goods: { goodsId: '456', goodsName: '第二件', skus: [{ id: 'second', specs: ['大'], price: '20.00' }] } })}</script>`;
  const page = await detailPage(html);
  assert.equal((await page.snapshot()).detail.skus[0].id, 'first');
  page.location.href = 'https://mobile.pinduoduo.com/goods.html?goods_id=456';
  const second = await page.snapshot();
  assert.equal(second.goodsId, '456');
  assert.equal(second.detail.title, '第二件');
  assert.deepEqual(Array.from(second.detail.skus, sku => sku.id), ['second']);
});

test('injecting the reader twice registers only one message listener', async () => {
  const page = await detailPage('<main data-goods-id="123"><h1>商品</h1></main>');
  page.inject();
  assert.equal(page.listenerCount(), 1);
  assert.equal((await page.snapshot()).detail.title, '商品');
});

test('DOM fallback does not infer description text or video URL', async () => {
  const result = await snapshot('<main data-goods-id="123"><h1>商品</h1><section data-role="description">营销描述</section><video src="https://video.pddpic.com/dom-only.mp4"></video></main>');
  assert.equal(result.detail.descriptionText, '');
  assert.equal(result.detail.videoUrl, '');
});

test('visible login and frequent-access prompts block extraction', async () => {
  for (const phrase of ['手机号登录', '访问过于频繁']) {
    const result = await snapshot(`<main data-goods-id="123"><h1>商品</h1></main><div role="dialog">${phrase}</div>`);
    assert.equal(result.blocked, true, phrase);
    assert.equal(result.detail, null, phrase);
  }
});
