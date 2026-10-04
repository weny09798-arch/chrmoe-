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
  const helper = await readFile(new URL('../extension/detail-pdd-ui.js', import.meta.url), 'utf8').catch(error => { if(error.code==='ENOENT')return '';throw error; });
  const source = helper + '\n' + await readFile(new URL('../extension/detail-content.js', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const inject = () => vm.runInContext(source, context);
  inject();
  assert.ok(listeners.length, 'PDD_DETAIL_SNAPSHOT message handler must be installed');
  return {
    window, document,
    location,
    inject,
    listenerCount: () => listeners.length,
    snapshot: pageGoods => new Promise(resolve => listeners[0]({ type: 'PDD_DETAIL_SNAPSHOT', pageGoods }, {}, resolve))
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

test('a matching JSON product root with only base fields is not marked ready', async () => {
  const result = await snapshot(`
    <main data-goods-id="123"><h1>商品</h1></main>
    <script type="application/json">${JSON.stringify({ goods: { goodsId: '123', goodsName: '商品' } })}</script>`);
  assert.equal(result.source, 'json');
  assert.equal(result.ready, false);
  assert.equal(result.detail.title, '商品');
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
    <main data-goods-id="123"><h1>真正商品</h1><img aria-label="商品大图" src="https://img.pddpic.com/real.jpg"></main>`);
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

test('current PDD labels preserve lazy gallery and detail pictures and product attribute pairs only',async()=>{
  const result=await snapshot(`<main><img aria-label="商品大图" data-src="https://img.pddpic.com/main.jpg?imageMogr2/thumbnail/400x"><img aria-label="商品大图" data-src="https://img.pddpic.com/second.jpg">
    <img src="https://commimg.pddpic.com/shield.png"><img src="https://avatar3.pddpic.com/person.jpg"><img src="https://img.pddpic.com/a/coupon/clock.png">
    <div><p>商品详情</p><div><div aria-label="品牌添彩"><div aria-hidden="true">品牌</div><div aria-hidden="true">添彩</div></div><div aria-label="材质聚丙烯(pp)"><div aria-hidden="true">材质</div><div aria-hidden="true">聚丙烯(pp)</div></div></div></div>
    <div><img aria-label="查看图片" data-src="https://img-1.pddpic.com/detail-a.jpg"><img aria-label="查看图片" data-src="https://img-1.pddpic.com/detail-b.jpg"></div>
    <aside><img aria-label="查看图片" src="https://img.pddpic.com/recommend.jpg"></aside></main>`);
  assert.deepEqual(Array.from(result.detail.galleryImages),['https://img.pddpic.com/main.jpg','https://img.pddpic.com/second.jpg']);
  assert.deepEqual(Array.from(result.detail.detailImages),['https://img-1.pddpic.com/detail-a.jpg','https://img-1.pddpic.com/detail-b.jpg']);
  assert.equal(result.detail.descriptionText,'品牌：添彩\n材质：聚丙烯(pp)');
});

test('unscoped service and customer images never become a product gallery',async()=>{
  const result=await snapshot('<main><h1>商品</h1><img src="https://img.pddpic.com/shield.png"><img src="https://img.pddpic.com/landscape.jpg"><img src="https://avatar3.pddpic.com/customer.jpg"></main>');
  assert.deepEqual(Array.from(result.detail.galleryImages),[]);
});

test('a recommendation heading is a final exclusion even inside a detail ancestor',async()=>{
  const result=await snapshot('<main><div data-role="detail"><p>商品详情</p><img aria-label="查看图片" src="https://img.pddpic.com/real.jpg"><p>猜你喜欢</p><img aria-label="查看图片" src="https://img.pddpic.com/other.jpg"></div></main>');
  assert.deepEqual(Array.from(result.detail.detailImages),['https://img.pddpic.com/real.jpg']);
});

test('partial DOM detail images remain pending while later images arrive',async()=>{
  const page=await detailPage('<main><p>商品详情</p><img aria-label="查看图片" src="https://img.pddpic.com/first.jpg"></main>');
  const goods={goodsID:'123',goodsName:'托盘',skus:[{specs:['白色'],price:'0.67'}]};
  assert.equal((await page.snapshot(goods)).detailPending,true);
  await page.snapshot(goods);
  page.document.querySelector('main').insertAdjacentHTML('beforeend','<img aria-label="查看图片" data-src="https://img.pddpic.com/last.jpg">');
  assert.equal((await page.snapshot(goods)).detailPending,true);
  let result;for(let i=0;i<8;i++)result=await page.snapshot(goods);
  assert.equal(result.detailPending,false);
  assert.deepEqual(Array.from(result.detail.detailImages),['https://img.pddpic.com/first.jpg','https://img.pddpic.com/last.jpg']);
});

test('the real product DOM sample preserves all 16 detail pictures and 5 attribute pairs',async()=>{
  const html=await readFile(new URL('./fixtures/pdd-live-detail.html',import.meta.url),'utf8');
  const page=await detailPage(html,'672673135904');
  const result=await page.snapshot();
  assert.equal(result.detail.detailImages.length,16);
  assert.equal(result.detail.attributes.length,5);
  assert.ok(result.detail.galleryImages.length>=8);
  assert.equal(result.detail.attributes[2].value,'聚丙烯(pp)');
});

test('a selected summary alone never assigns the previous SKU price to a delayed new SKU',async()=>{
  const page=await detailPage('<main><div data-role="detail"><img src="https://img.pddpic.com/detail.jpg"></div></main><div role="dialog"><img aria-label="点击查看大图" src="https://img.pddpic.com/white.jpg"><div data-sku-price>¥1</div><span data-sku-selected>已选：白色</span><div><span class="sku-specs-key">颜色</span><div><div role="button" class="hr353bdX">白色</div><div role="button">红色</div></div></div></div>');
  const [white,red]=page.document.querySelectorAll('[role=button]');let remaining=-1;
  red.addEventListener('click',()=>{white.classList.remove('hr353bdX');red.classList.add('hr353bdX');page.document.querySelector('[data-sku-selected]').textContent='已选：红色';remaining=4;});
  let result;
  for(let i=0;i<25;i++){
    if(remaining>0&&!--remaining){page.document.querySelector('[data-sku-price]').textContent='¥2';page.document.querySelector('img[aria-label="点击查看大图"]').setAttribute('src','https://img.pddpic.com/red.jpg');}
    result=await page.snapshot();
    assert.ok(Array.from(result.detail.skus).every(s=>s.specs[0]!=='红色'||s.price==='2'));
  }
  assert.deepEqual(Array.from(result.detail.skus,s=>[s.specs[0],s.price,s.image]),[['白色','1','https://img.pddpic.com/white.jpg'],['红色','2','https://img.pddpic.com/red.jpg']]);
});

test('matching base data keeps SKU pending and never activates an unknown payment control',async()=>{
  const page=await detailPage('<h1>商品</h1><button>立即支付</button><button>确定</button>');let purchases=0;
  for(const node of page.document.querySelectorAll('button'))node.addEventListener('click',()=>purchases++);
  const result=await page.snapshot({goodsID:'123',goodsName:'商品',goodsProperty:[{key:'材质',values:['棉']}],topGallery:['https://img.pddpic.com/main.jpg']});
  assert.equal(result.skuPending,true);assert.equal(result.detail.detailStatus,'partial');assert.equal(purchases,0);
});

test('hidden and other-product SKU dialogs are never read as current product specifications',async()=>{
  for(const marker of ['hidden','aria-hidden="true"','data-goods-id="999"']){
    const page=await detailPage(`<main><div data-role="detail"><img src="https://img.pddpic.com/detail.jpg"></div></main><div role="dialog" ${marker}><div data-sku-price>¥999</div><span data-sku-selected>已选：红色</span><div><span class="sku-specs-key">颜色</span><div role="button" class="hr353bdX">红色</div></div></div>`);
    let result;for(let i=0;i<15;i++)result=await page.snapshot();
    assert.deepEqual(Array.from(result.detail.skus),[],marker);
  }
});

test('two-dimensional selection waits for each individual price update before changing the next option',async()=>{
  const page=await detailPage('<main><div data-role="detail"><img src="https://img.pddpic.com/detail.jpg"></div></main><div role="dialog"><div data-sku-price>¥1</div><span data-sku-selected>已选：白色 140</span><div><span class="sku-specs-key">颜色</span><div><div role="button">红色</div><div role="button" class="hr353bdX">白色</div></div></div><div><span class="sku-specs-key">尺寸</span><div><div role="button">160</div><div role="button" class="hr353bdX">140</div></div></div></div>');
  let remaining=0,pendingPrice='1',clicksWhileLoading=0;
  const dialog=page.document.querySelector('[role=dialog]');
  for(const group of dialog.querySelectorAll('.sku-specs-key'))for(const option of group.parentElement.querySelectorAll('[role=button]'))option.addEventListener('click',()=>{
    if(remaining)clicksWhileLoading++;
    for(const other of group.parentElement.querySelectorAll('[role=button]'))other.classList.remove('hr353bdX');option.classList.add('hr353bdX');
    const selected=[...dialog.querySelectorAll('.hr353bdX')].map(n=>n.textContent);dialog.querySelector('[data-sku-selected]').textContent='已选：'+selected.join(' ');
    pendingPrice=selected[0]==='红色'?(selected[1]==='160'?'3':'2'):(selected[1]==='160'?'1.5':'1');remaining=4;
  });
  let result;for(let i=0;i<80;i++){
    if(remaining&&!--remaining)dialog.querySelector('[data-sku-price]').textContent='¥'+pendingPrice;
    result=await page.snapshot();
    assert.ok(Array.from(result.detail.skus).every(s=>s.specs.join(' ' )!=='红色 160'||s.price==='3'));
  }
  assert.equal(clicksWhileLoading,0);
  assert.equal(result.detail.skus[0].price,'3');
});

test('a known PDD entry opens specifications once and retains only observed variant prices without confirming',async()=>{
  const page=await detailPage('<h1>托盘</h1><div role="button" class="yK39frdi">大促价 ¥0.67 限时直降 发起拼单</div>');
  let openings=0,confirmations=0;
  const mount=()=>{openings++;page.document.body.insertAdjacentHTML('beforeend',`<div role="dialog"><img aria-label="点击查看大图" src="https://img.pddpic.com/white.jpg"><div data-sku-price>¥0.67</div><span data-sku-selected>已选：白色 140型号</span>
    <div><span class="sku-specs-key">颜色</span><div><div role="button" class="hr353bdX">白色</div><div role="button">红色</div></div></div>
    <div><span class="sku-specs-key">尺寸</span><div><div role="button" class="hr353bdX">140型号</div><div role="button">160型号</div></div></div><button aria-label="确定">确定</button></div>`);
    const dialog=page.document.querySelector('[role=dialog]');
    dialog.querySelector('button').addEventListener('click',()=>confirmations++);
    for(const group of dialog.querySelectorAll('.sku-specs-key'))for(const option of group.parentElement.querySelectorAll('[role=button]'))option.addEventListener('click',()=>{
      for(const other of group.parentElement.querySelectorAll('[role=button]'))other.classList.remove('hr353bdX');option.classList.add('hr353bdX');
      const choices=[...dialog.querySelectorAll('.hr353bdX')].map(n=>n.textContent);
      dialog.querySelector('[data-sku-selected]').textContent='已选：'+choices.join(' ');
      dialog.querySelector('[data-sku-price]').textContent=choices[0]==='红色'?(choices[1]==='140型号'?'¥0.68':'¥1.00'):(choices[1]==='140型号'?'¥0.67':'¥0.99');
    });
  };
  page.document.querySelector('[role=button]').addEventListener('click',mount);
  let result;for(let i=0;i<40;i++)result=await page.snapshot();
  assert.equal(openings,1);assert.equal(confirmations,0);
  assert.deepEqual(Array.from(result.detail.skus,sku=>[...sku.specs,sku.price]),[['白色','140型号','0.67'],['白色','160型号','0.99'],['红色','140型号','0.68'],['红色','160型号','1.00']]);
  assert.equal(result.skuPending,false);
});

test('an unchanged price after switching specifications stops fallback with a partial note rather than assigning old prices',async()=>{
  const page=await detailPage('<main><div data-role="detail"><img src="https://img.pddpic.com/detail.jpg"></div></main><div role="dialog"><div data-sku-price>¥1</div><span data-sku-selected>已选：白色</span><div><span class="sku-specs-key">颜色</span><div><div role="button" class="hr353bdX">白色</div><div role="button">红色</div><div role="button">绿色</div></div></div></div>');
  const [white,red]=page.document.querySelectorAll('[role=button]');
  red.addEventListener('click',()=>{white.classList.remove('hr353bdX');red.classList.add('hr353bdX');page.document.querySelector('[data-sku-selected]').textContent='已选：红色';});
  let result;for(let i=0;i<40;i++)result=await page.snapshot();
  assert.equal(result.detail.skus.length,1);assert.equal(result.detail.skus[0].specs[0],'白色');
  assert.equal(result.detail.detailStatus,'partial');assert.match(result.detail.detailNote,/2 组规格未能确认/);
  assert.equal(result.skuPending,false);
});

test('visible login and frequent-access prompts block extraction', async () => {
  for (const phrase of ['手机号登录', '访问过于频繁', '商品已售罄，推荐以下相似商品']) {
    const result = await snapshot(`<main data-goods-id="123"><h1>商品</h1></main><div role="dialog">${phrase}</div>`);
    assert.equal(result.blocked, true, phrase);
    assert.equal(result.detail, null, phrase);
  }
});

test('reads Pinduoduo window.rawData goods, SKU specs, galleries and attributes', async () => {
  const raw = {
    store: {
      initDataObj: {
        alsoViewed: {
          goodsId: '123', goodsName: '旁支商品',
          skus: [{ skuID: 1, specs: [{ spec_key: '颜色', spec_value: '错误' }], groupPrice: '1.00', thumbUrl: 'https://img.pddpic.com/wrong.jpg' }]
        },
        goods: {
          goodsID: 123,
          goodsName: '真实商品',
          shareDesc: '真实商品',
          catID1: 8439,
          minGroupPrice: '12.8',
          topGallery: [{ url: 'https://img.pddpic.com/main.jpg' }],
          detailGallery: [{ url: 'https://img.pddpic.com/detail.jpg', width: 750, height: 400 }],
          goodsProperty: [{ key: '材质', values: ['棉', '聚酯纤维'] }],
          videoGallery: [{ url: 'https://img.pddpic.com/cover.jpg', videoUrl: 'https://video.pddpic.com/demo.mp4' }],
          decoration: [{ key: 'DecImage', type: 'image', contents: [{ imgUrl: 'https://img.pddpic.com/detail.jpg' }] }],
          skus: [
            {
              skuID: 57114357891, skuId: 57114357891, goodsId: 123,
              price: 0, groupPrice: '12.80', oldGroupPrice: 1280, normalPrice: '15',
              quantity: 8, weight: 0, thumbUrl: 'https://img.pddpic.com/red.jpg',
              specs: [
                { spec_key: '颜色', spec_value: '红色', spec_key_id: 1215 },
                { spec_key: '尺码', spec_value: 'S', spec_key_id: 1226 }
              ]
            },
            {
              skuID: 57114357892, price: 0, groupPrice: '13.50', quantity: 0, weight: 500,
              thumbUrl: 'https://img.pddpic.com/blue.jpg',
              specs: [
                { spec_key: '颜色', spec_value: '蓝色' },
                { spec_key: '尺码', spec_value: 'M' }
              ]
            }
          ]
        }
      }
    }
  };
  const result = await snapshot(`<main data-goods-id="123"><h1>真实商品</h1></main><script>window.rawData = ${JSON.stringify(raw)};</script>`);
  assert.equal(result.ready, true);
  assert.equal(result.source, 'json');
  assert.equal(result.detail.title, '真实商品');
  assert.equal(result.detail.descriptionText, '材质：棉，聚酯纤维');
  assert.equal(result.detail.category, '');
  assert.equal(result.detail.price, '12.8');
  assert.deepEqual(Array.from(result.detail.galleryImages), ['https://img.pddpic.com/main.jpg']);
  assert.deepEqual(Array.from(result.detail.detailImages), ['https://img.pddpic.com/detail.jpg']);
  assert.deepEqual(Array.from(result.detail.attributes, item => [item.name, item.value]), [['材质', '棉，聚酯纤维']]);
  assert.equal(result.detail.videoUrl, 'https://video.pddpic.com/demo.mp4');
  assert.deepEqual(Array.from(result.detail.specNames), ['颜色', '尺码']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.id), ['57114357891', '57114357892']);
  assert.deepEqual(Array.from(result.detail.skus, sku => Array.from(sku.specs)), [['红色', 'S'], ['蓝色', 'M']]);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.price), ['12.80', '13.50']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.image), ['https://img.pddpic.com/red.jpg', 'https://img.pddpic.com/blue.jpg']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.stock), ['8', '0']);
  assert.deepEqual(Array.from(result.detail.skus, sku => sku.weightKg), ['', '0.5']);
  assert.equal(JSON.stringify(result.detail).includes('旁支商品'), false);
  assert.equal(JSON.stringify(result.detail).includes('错误'), false);
});
