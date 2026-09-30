import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

async function snapshot(html, offerId = '888', layout = {}) {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  layout.setup?.(window,document);
  const hidden = layout.hidden === true;
  const box = layout.box ?? 300;
  window.Element.prototype.getBoundingClientRect = () => ({ width: box, height: box, top: 0, left: 0 });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const listeners = [];
  const href = `https://detail.1688.com/offer/${offerId}.html`;
  const context = vm.createContext({
    window, document, URL,
    location: { href, pathname: `/offer/${offerId}.html`, hostname: 'detail.1688.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: { onMessage: { addListener: fn => { listeners.push(fn); } } } },
    console
  });
  vm.runInContext(await readFile(new URL('../extension/detail-1688.js', import.meta.url), 'utf8'), context);
  assert.ok(listeners.length);
  return new Promise(resolve => listeners[0]({ type: 'PDD_DETAIL_SNAPSHOT' }, {}, resolve));
}

test('reads the current 1688 offer and ignores a side recommendation', async () => {
  const payload = {
    data: {
      offerId: '888',
      subject: '真实现货棉布',
      imageList: [{ fullPathImageURI: '//cbu01.alicdn.com/main.jpg' }],
      productAttribute: [{ name: '材质', value: '棉' }],
      skuModel: {
        skuInfoMap: {
          '颜色>红;尺码>S': { skuId: 's1', discountPrice: '12.80', canBookCount: 8, imageUrl: 'https://cbu01.alicdn.com/red.jpg' }
        }
      }
    },
    recommendations: {
      offerId: '999',
      subject: '推荐商品',
      skuModel: { skuInfoMap: { '颜色>蓝': { skuId: 'other', discountPrice: '1.00' } } }
    }
  };
  const result = await snapshot(`<h1>页面标题</h1><script>window.__INIT_DATA = ${JSON.stringify(payload)};</script>`);
  assert.equal(result.blocked, false);
  assert.equal(result.ready, true);
  assert.equal(result.source, 'json');
  assert.equal(result.goodsId, '888');
  assert.equal(result.detail.title, '真实现货棉布');
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://cbu01.alicdn.com/main.jpg']);
  assert.deepEqual(Array.from(result.detail.attributes, item => [item.name, item.value]), [['材质', '棉']]);
  assert.equal(result.detail.skus.length, 1);
  assert.deepEqual(Array.from(result.detail.skus[0].specs), ['红', 'S']);
  assert.equal(result.detail.skus[0].id, 's1');
  assert.equal(result.detail.skus[0].price, '12.80');
  assert.equal(result.detail.skus[0].stock, '8');
  assert.equal(result.detail.skus.some(sku => sku.id === 'other'), false);
});

test('content heading bounds 1688 descriptions while ignoring reviews, the confirmed cow and unrelated frames',async()=>{
  const result=await snapshot(`<h1>紫光手电筒</h1><nav><a>商品详情</a></nav>
    <section class="reviews"><img src="https://cbu01.alicdn.com/buyer.jpg"></section>
    <h2>商品详情</h2><img src="https://cbu01.alicdn.com/img/ibank/2020/428/378/22185873824_536529798.jpg">
    <img src="https://cbu01.alicdn.com/img/ibank/real-long.jpg"><img src="https://cbu01.alicdn.com/i2/O1CN01GUka98mSWgB2BxV2_!!4611686018427381191-0-rate.jpg">
    <h2>店铺推荐</h2><img src="https://cbu01.alicdn.com/other.jpg">
    <iframe id="feedback" src="https://feedback.1688.com/a"></iframe>
    <iframe id="offer-desc" src="https://desc.alicdn.com/i8/offer.desc"></iframe>`, '888',{setup(_window,document){
      const frames=document.querySelectorAll('iframe');
      Object.defineProperty(frames[0],'contentDocument',{value:parseHTML('<img src="https://cbu01.alicdn.com/unrelated-frame.jpg">').document});
      Object.defineProperty(frames[1],'contentDocument',{value:parseHTML('<img data-src="https://cbu01.alicdn.com/frame-long.jpg" src="data:image/gif;base64,a">').document});
    }});
  assert.deepEqual(Array.from(result.detail.detailImages),['https://cbu01.alicdn.com/img/ibank/real-long.jpg','https://cbu01.alicdn.com/frame-long.jpg']);
});

test('a deep description remains separate when the whole page has exactly one priced SKU',async()=>{
  const result=await snapshot('<h1>紫光手电筒</h1><div class="sku-row"><img src="https://cbu01.alicdn.com/red.jpg"><span>红色</span><span>¥12.50</span><span>库存8件</span></div><h2>商品详情</h2>'+'<div>'.repeat(8)+'<img src="https://cbu01.alicdn.com/long.jpg">'+'</div>'.repeat(8));
  assert.deepEqual(Array.from(result.detail.detailImages),['https://cbu01.alicdn.com/long.jpg']);assert.equal(result.detail.skus[0].image,'https://cbu01.alicdn.com/red.jpg');
});

test('a 1688 page without offer data keeps only the visible title and pictures', async () => {
  const result = await snapshot('<h1>棉布窗帘</h1><img src="https://cbu01.alicdn.com/plain.jpg">');
  assert.equal(result.source, 'dom');
  assert.equal(result.detail.title, '棉布窗帘');
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://cbu01.alicdn.com/plain.jpg']);
  assert.deepEqual(Array.from(result.detail.skus), []);
  assert.equal(result.detail.descriptionText, '');
});

test('the purchase panel title, every visible SKU and the main video come from the page', async () => {
  const html = `
    <div class="shop"><h1>宁波西店道意电器厂</h1></div>
    <div class="buy">
      <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
      <div>¥30.50</div>
      <div class="sku-row"><img src="https://cbu01.alicdn.com/blue.jpg"><span>B88三光源照玉灯【蓝色】</span><span>¥30.5</span><span>库存99992盒</span></div>
      <div class="sku-row"><img src="https://cbu01.alicdn.com/black.jpg"><span>B88三光源照玉灯【黑色】</span><span>¥30.5</span><span>库存99996盒</span></div>
      <div class="sku-row"><img src="https://cbu01.alicdn.com/c8.jpg"><span>C8-XPE-全网热销款</span><span>¥44.5</span><span>库存3600套</span><span>-</span><span>0</span><span>+</span></div>
      <button>立即下单</button>
    </div>
    <img src="https://cbu01.alicdn.com/main.jpg">
    <video src="https://cloud.video.taobao.com/play/demo.mp4"></video>`;
  const result = await snapshot(html);
  assert.equal(result.detail.title, '三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯');
  assert.equal(result.detail.videoUrl, 'https://cloud.video.taobao.com/play/demo.mp4');
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.specs[0]), ['B88三光源照玉灯【蓝色】', 'B88三光源照玉灯【黑色】', 'C8-XPE-全网热销款']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.price), ['30.5', '30.5', '44.5']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.stock), ['99992', '99996', '3600']);
  assert.equal(result.detail.skus[0].image, 'https://cbu01.alicdn.com/blue.jpg');
  assert.ok(Array.from(result.detail.galleryImages).includes('https://cbu01.alicdn.com/main.jpg'));
});

test('SKU thumbnails beside each row fill the SKU image, and 商品详情 pictures fill the detail images', async () => {
  const html = `
    <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
    <div>¥25.5</div>
    <div class="sku-row"><img src="https://cbu01.alicdn.com/sku-365.jpg"><div><span>三光源365【充电套装】</span><span>¥25.5</span><span>库存156盒</span></div></div>
    <div class="sku-row"><img data-src="https://cbu01.alicdn.com/sku-white.jpg" src="data:image/gif;base64,AAAA"><div><span>白光款（单个电筒）</span><span>¥12.5</span><span>库存9506盒</span></div></div>
    <button>立即下单</button>
    <h2>商品详情</h2>
    <img src="https://cbu01.alicdn.com/detail-pack.jpg">
    <img width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://cbu01.alicdn.com/img/ibank/detail-long.jpg">
    <img src="https://cbu01.alicdn.com/detail-banner.jpg">
    <h2>看了又看</h2>
    <img src="https://cbu01.alicdn.com/recommend.jpg">`;
  const result = await snapshot(html);
  assert.deepEqual(Array.from(result.detail.skus, sku => [sku.specs[0], sku.image]), [
    ['三光源365【充电套装】', 'https://cbu01.alicdn.com/sku-365.jpg'],
    ['白光款（单个电筒）', 'https://cbu01.alicdn.com/sku-white.jpg']
  ]);
  assert.deepEqual(Array.from(result.detail.detailImages), ['https://cbu01.alicdn.com/detail-pack.jpg', 'https://cbu01.alicdn.com/img/ibank/detail-long.jpg', 'https://cbu01.alicdn.com/detail-banner.jpg']);
});

test('SKU images are the full-size pictures after 参数, in thumbnail order', async () => {
  const html = `
    <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
    <div class="thumbs">
      <div><img src="https://cbu01.alicdn.com/img/ibank/main-a.jpg_sum.jpg"></div>
      <div><img src="https://cbu01.alicdn.com/img/ibank/main-b.jpg_60x60.jpg"></div>
      <div><span>参数</span></div>
      <div><img src="https://cbu01.alicdn.com/img/ibank/sku-white.jpg_sum.jpg"></div>
      <div><img src="https://cbu01.alicdn.com/img/ibank/sku-yellow.jpg_.webp"></div>
      <div><img src="https://cbu01.alicdn.com/img/ibank/sku-purple.jpg_80x80.jpg"></div>
    </div>
    <div>¥25.5</div>
    <div class="sku-row"><img src="https://cbu01.alicdn.com/img/ibank/sku-white.jpg_50x50.jpg"><div><span>白光款</span><span>¥12.5</span><span>库存9盒</span></div></div>
    <div class="sku-row"><img src="https://cbu01.alicdn.com/tiny.jpg"><div><span>黄光款</span><span>¥13.5</span><span>库存8盒</span></div></div>
    <div class="sku-row"><div><span>紫光款</span><span>¥14.5</span><span>库存7盒</span></div></div>
    <button>立即下单</button>`;
  const result = await snapshot(html);
  assert.deepEqual(Array.from(result.detail.skus, sku => [sku.specs[0], sku.image]), [
    ['白光款', 'https://cbu01.alicdn.com/img/ibank/sku-white.jpg'],
    ['黄光款', 'https://cbu01.alicdn.com/img/ibank/sku-yellow.jpg'],
    ['紫光款', 'https://cbu01.alicdn.com/img/ibank/sku-purple.jpg']
  ]);
});

test('thumbnail pictures after 参数 stay on the SKU and out of 详情图', async () => {
  const html = `
    <h2>商品详情</h2>
    <div class="desc-layout" aria-hidden="true">
      <div class="thumbs">
        <div><img src="https://cbu01.alicdn.com/img/ibank/main-a.jpg_sum.jpg"></div>
        <div><span>参数</span></div>
        <div><img src="https://cbu01.alicdn.com/img/ibank/sku-white.jpg_sum.jpg"></div>
        <div><img src="https://cbu01.alicdn.com/img/ibank/sku-yellow.jpg_.webp"></div>
      </div>
    </div>
    <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
    <div class="sku-row"><img src="https://cbu01.alicdn.com/img/ibank/sku-white.jpg_50x50.jpg"><div><span>白光款</span><span>¥12.5</span><span>库存9盒</span></div></div>
    <div class="sku-row"><img src="https://cbu01.alicdn.com/tiny.jpg"><div><span>黄光款</span><span>¥13.5</span><span>库存8盒</span></div></div>
    <button>立即下单</button>
    <img src="https://cbu01.alicdn.com/img/ibank/detail-long.jpg">
    <h2>看了又看</h2>
    <img src="https://cbu01.alicdn.com/recommend.jpg">`;
  const result = await snapshot(html);
  assert.deepEqual(Array.from(result.detail.skus, sku => [sku.specs[0], sku.image]), [
    ['白光款', 'https://cbu01.alicdn.com/img/ibank/sku-white.jpg'],
    ['黄光款', 'https://cbu01.alicdn.com/img/ibank/sku-yellow.jpg']
  ]);
  assert.deepEqual(Array.from(result.detail.detailImages), ['https://cbu01.alicdn.com/img/ibank/detail-long.jpg']);
});

test('the long 商品详情 pictures are addressed by the description document, not by the offer page', async () => {
  const html = `
    <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
    <div>¥25.5</div>
    <div class="sku-row"><span>三光源365【充电套装】</span><span>¥25.5</span><span>库存156盒</span></div>
    <button>立即下单</button>
    <h2>商品详情</h2>
    <script>window.context={"result":{"data":{"description":{"detailUrl":"https:\\/\\/itemcdn.tmall.com\\/desc\\/icoss123"}}}}</script>
    <iframe src="https://desc.alicdn.com/i8/offer.desc"></iframe>
    <iframe src="https://detail.1688.com/offer/888.html"></iframe>`;
  const result = await snapshot(html);
  assert.deepEqual(Array.from(result.descriptionUrls), [
    'https://itemcdn.tmall.com/desc/icoss123',
    'https://desc.alicdn.com/i8/offer.desc'
  ]);
});

test('a background 1688 tab still reads the purchase panel when the page has no layout box', async () => {
  const html = `
    <div class="title">三光源照玉石专用手电筒强光充电珠宝翡翠蜜蜡防伪鉴定文玩验钞灯</div>
    <div class="sku-row"><span>白光款</span><span>¥12.5</span><span>库存9盒</span></div>
    <button>立即下单</button>`;
  const result = await snapshot(html, '888', { hidden: true, box: 0 });
  assert.equal(result.detail.skus[0].specs[0], '白光款');
  assert.equal(result.detail.skus[0].price, '12.5');
});

test('a 1688 login wall blocks the detail page', async () => {
  const result = await snapshot('<h1>请登录后查看</h1>');
  assert.equal(result.blocked, true);
  assert.equal(result.detail, null);
});
