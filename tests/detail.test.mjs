import test from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_STATUS, fallbackSku, normalizeDetail } from '../extension/lib/detail.mjs';

test('normalizes the documented complete detail fixture', () => {
  const detail = normalizeDetail({
    title: '运动鞋', galleryImages: ['https://img/1.jpg', 'https://img/1.jpg'],
    attributes: [{ name: '品牌', value: '测试牌' }], specNames: ['颜色', '尺码'],
    skus: [{ id: 'sku-1', specs: ['黑色', '42'], price: '29.90', stock: '8' }]
  }, { id: '123', title: '鞋', cents: 3500, image: 'https://img/search.jpg' });

  assert.equal(detail.skus[0].cents, 2990);
  assert.deepEqual(detail.galleryImages, ['https://img/1.jpg']);
  assert.equal(detail.title, '运动鞋');
  assert.deepEqual(detail.attributes, [{ name: '品牌', value: '测试牌' }]);
  assert.deepEqual(detail.specNames, ['颜色', '尺码']);
  assert.equal(detail.detailStatus, 'done');
});

test('does not retain description text while preserving description images and SKU fields',()=>{
  const detail=normalizeDetail({descriptionText:'已售1万+ 多人评价 领券 店长主推 联系客服',detailImages:['https://img.alicdn.com/long.jpg'],attributes:[{name:'材质',value:'玻璃'}],skus:[{id:'a',specs:['大号'],price:'2.90',stock:'10'}]});
  assert.equal(detail.descriptionText,'');assert.deepEqual(detail.detailImages,['https://img.alicdn.com/long.jpg']);assert.equal(detail.skus[0].cents,290);assert.equal(detail.attributes[0].value,'玻璃');
});

test('returns the stable shape, trims title and uses fallback title when missing', () => {
  assert.deepEqual(normalizeDetail({ title: '  原始标题  ' }, { title: '兜底标题' }), {
    title: '原始标题', image: '', galleryImages: [], descriptionText: '', detailImages: [], category: '',
    attributes: [], videoUrl: '', certificateImages: [], sizeChartImages: [], specNames: [],
    skus: [{ id: '', specs: [], cents: 0, image: '', stock: '', weightKg: '', sizeCm: '' }],
    detailCents: 0, detailStatus: 'done', detailNote: ''
  });
  assert.equal(normalizeDetail({}, { title: '  兜底标题  ' }).title, '兜底标题');
});

test('filters unsafe and duplicate URLs and falls back to a valid search image', () => {
  const detail = normalizeDetail({
    galleryImages: ['http://img/a.jpg', 'https://img/a.jpg', 'https://img/a.jpg', '', null],
    detailImages: ['https://img/d.jpg', 'https://img/d.jpg', 'http://img/d.jpg'],
    certificateImages: ['data:image/png,x', 'https://img/c.jpg'],
    sizeChartImages: ['https://img/s.jpg'], videoUrl: 'http://video/v.mp4'
  }, { image: 'https://img/fallback.jpg' });
  assert.deepEqual(detail.galleryImages, ['https://img/a.jpg']);
  assert.deepEqual(detail.detailImages, ['https://img/d.jpg']);
  assert.deepEqual(detail.certificateImages, ['https://img/c.jpg']);
  assert.deepEqual(detail.sizeChartImages, ['https://img/s.jpg']);
  assert.equal(detail.videoUrl, '');
  assert.deepEqual(normalizeDetail({ galleryImages: ['http://img/a.jpg'] }, { image: 'https://img/f.jpg' }).galleryImages, ['https://img/f.jpg']);
});

test('cleans attributes and limits unique spec names and SKU specs to two', () => {
  const detail = normalizeDetail({
    attributes: [
      { name: ' 品牌 ', value: ' 测试牌 ' }, { key: '品牌', value: '测试牌' },
      { name: '', value: '缺名' }, { name: '缺值', value: '  ' }, null
    ],
    specNames: ['颜色', ' 尺码 ', '颜色', '', '批次'],
    skus: [{ id: 'a', specs: ['黑色', '42', '批次'], cents: 100 }]
  });
  assert.deepEqual(detail.attributes, [{ name: '品牌', value: '测试牌' }]);
  assert.deepEqual(detail.specNames, ['颜色', '尺码']);
  assert.deepEqual(detail.skus[0].specs, ['黑色', '42']);
});

test('preserves duplicate SKU spec values in their original dimension positions', () => {
  const detail = normalizeDetail({ skus: [{ id: 'same-values', specs: ['通用', '通用'] , cents: 100 }] });
  assert.deepEqual(detail.skus[0].specs, ['通用', '通用']);
});

test('keeps only valid positive integer prices and deduplicates SKUs by documented keys', () => {
  const detail = normalizeDetail({ skus: [
    { id: 'a', skuId: 'ignored', specs: ['黑色'], cents: 2990, image: 'https://img/a.jpg' },
    { id: 'a', specs: ['白色'], cents: 3500 },
    { skuId: 'b', specs: ['蓝色'], price: '12.34', stock: '3', image: 'http://img/b.jpg' },
    { id: 'c', specs: ['红色'], cents: 0 },
    { id: 'd', specs: ['绿色'], cents: 2.5 },
    { specs: ['黑色'], cents: 100, image: 'https://img/x.jpg' },
    { specs: ['黑色'], cents: 100, image: 'https://img/x.jpg' }
  ] });
  assert.deepEqual(detail.skus, [
    { id: 'a', specs: ['黑色'], cents: 2990, image: 'https://img/a.jpg', stock: '', weightKg: '', sizeCm: '' },
    { id: 'b', specs: ['蓝色'], cents: 1234, image: '', stock: '3', weightKg: '', sizeCm: '' },
    { id: '', specs: ['黑色'], cents: 100, image: 'https://img/x.jpg', stock: '', weightKg: '', sizeCm: '' }
  ]);
});

test('uses unambiguous fields when deduplicating SKUs without IDs', () => {
  const detail = normalizeDetail({ skus: [
    { specs: ['1'], cents: 23 },
    { specs: ['12'], cents: 3 }
  ] });
  assert.deepEqual(detail.skus.map(sku => [sku.specs, sku.cents]), [[['1'], 23], [['12'], 3]]);
});

test('uses exactly one fallback SKU if raw SKUs have no valid prices', () => {
  assert.deepEqual(normalizeDetail({ skus: [{ id: 'bad', specs: ['黑'], cents: 0 }] }, {
    id: 'search-id', title: '鞋', cents: 0, image: 'https://img/search.jpg'
  }).skus, [{ id: '', specs: [], cents: 0, image: 'https://img/search.jpg', stock: '', weightKg: '', sizeCm: '' }]);
});

test('fallback SKU prefers explicit product detail price over the search-card price', () => {
  const fromPrice = normalizeDetail({ price: '20.00', skus: [] }, { cents: 1000, image: 'https://img/search.jpg' });
  assert.equal(fromPrice.detailCents, 2000);
  assert.equal(fromPrice.skus[0].cents, 2000);
  const fromCents = normalizeDetail({ cents: '2150', price: '99.00', skus: [] }, { cents: 1000 });
  assert.equal(fromCents.detailCents, 2150);
  assert.equal(fromCents.skus[0].cents, 2150);
});

test('fallback SKU accepts only positive safe integer cents and HTTPS image', () => {
  assert.deepEqual(fallbackSku({ cents: 3500, image: 'https://img/a.jpg' }), {
    id: '', specs: [], cents: 3500, image: 'https://img/a.jpg', stock: '', weightKg: '', sizeCm: ''
  });
  assert.equal(fallbackSku({ cents: '3500', image: 'http://img/a.jpg' }).cents, 0);
  assert.equal(fallbackSku({ cents: Number.MAX_SAFE_INTEGER + 1, image: 'data:x' }).image, '');
});

test('preserves recognized explicit status and trims detail note to 500 characters', () => {
  assert.deepEqual(DETAIL_STATUS, Object.freeze({ PENDING: 'pending', RUNNING: 'running', DONE: 'done', PARTIAL: 'partial', ERROR: 'error' }));
  assert.equal(normalizeDetail({ detailStatus: 'partial' }).detailStatus, 'partial');
  assert.equal(normalizeDetail({ detailStatus: 'unknown' }).detailStatus, 'done');
  assert.equal(normalizeDetail({ detailNote: `  ${'x'.repeat(600)}  ` }).detailNote, 'x'.repeat(500));
});
