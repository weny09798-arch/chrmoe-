import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

async function snapshot(html, goodsId = '123') {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 300 });
  let handler;
  const url = `https://mobile.pinduoduo.com/goods.html?goods_id=${goodsId}`;
  const context = vm.createContext({
    window, document, URL,
    location: { href: url, pathname: '/goods.html' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: { onMessage: { addListener: fn => { handler = fn; } } } },
    console
  });
  const source = await readFile(new URL('../extension/detail-content.js', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  vm.runInContext(source, context);
  assert.ok(handler, 'PDD_DETAIL_SNAPSHOT message handler must be installed');
  return new Promise(resolve => handler({ type: 'PDD_DETAIL_SNAPSHOT' }, {}, resolve));
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
  assert.equal(result.detail.title, '当前商品');
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
  assert.equal(JSON.stringify(result.detail).includes('推荐商品'), false);
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
