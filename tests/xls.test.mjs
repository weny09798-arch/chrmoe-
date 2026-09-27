import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { taskSheets, workbookXlsBytes } from '../extension/lib/xlsx.mjs';

test('creates a real BIFF8 .xls matching the supplied import layout', () => {
  const task = { jobs: [{ keyword: '相机', groups: [{ best: {
    id: '123456', title: '=1+1 相机', cents: 2988,
    image: 'https://img.pddpic.com/123.jpg', url: 'https://mobile.pinduoduo.com/goods.html?goods_id=123456'
  } }] }] };
  const bytes = workbookXlsBytes(taskSheets(task), XLSX);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes.slice(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const workbook = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['模版']);
  const sheet = workbook.Sheets['模版'];
  assert.equal(sheet.A9.v, '*产品主编号');
  assert.equal(sheet.V9.v, 'SKU尺寸(CM)');
  assert.equal(sheet.A10.v, 'PDD123456');
  assert.equal(sheet.B10.v, '=1+1 相机');
  assert.equal(sheet.B10.t, 's');
  assert.equal(sheet.C10.v, 'CNY');
  assert.equal(sheet.D10.v, 'https://img.pddpic.com/123.jpg');
  assert.equal(sheet.E10.v, 'https://mobile.pinduoduo.com/goods.html?goods_id=123456');
  assert.equal(sheet.E10.l?.Target, 'https://mobile.pinduoduo.com/goods.html?goods_id=123456');
  assert.equal(sheet.F10.v, '拼多多');
  assert.equal(sheet.G10.v, '123456');
  assert.equal(sheet.R10.v, '29.88');
  assert.equal(sheet.R10.t, 's');
  assert.deepEqual(sheet['!merges'], [{ s: {r:0,c:0}, e: {r:7,c:11} }]);
});

test('BIFF8 reader recovers three SKU rows and leaves repeated product fields blank', () => {
  const item = {
    id: '7788', title: '运动鞋', cents: 1999, image: 'https://img.example/search.jpg',
    url: 'https://mobile.pinduoduo.com/goods.html?goods_id=7788',
    galleryImages: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
    descriptionText: '轻便透气', detailImages: ['https://img.example/detail1.jpg', 'https://img.example/detail2.jpg'],
    category: '运动鞋', attributes: [{ name: '材质', value: '网面' }, { name: '鞋底', value: '橡胶' }],
    videoUrl: 'https://video.example/demo.mp4', certificateImages: ['https://img.example/cert.jpg'],
    sizeChartImages: ['https://img.example/size.jpg'],
    skus: [
      { id: 'red-40', specs: ['红色', '40'], cents: 2099, image: 'https://img.example/red.jpg', stock: '8', weightKg: '0.7', sizeCm: '30x20x10' },
      { id: 'red-41', specs: ['红色', '41'], cents: 2199, image: 'https://img.example/red41.jpg', stock: '3', weightKg: '', sizeCm: '' },
      { id: 'blue-40', specs: ['蓝色', '40'], cents: 0, image: 'https://img.example/blue.jpg', stock: '12', weightKg: '0.8', sizeCm: '31x21x11' },
    ],
  };
  const sheet = XLSX.read(workbookXlsBytes(taskSheets({ jobs: [{ keyword: '运动鞋', groups: [{ best: item }] }] }), XLSX), { type: 'array' }).Sheets['模版'];
  assert.equal(sheet['!ref'], 'A1:V12');
  assert.equal(sheet.D10.v, 'https://img.example/1.jpg，https://img.example/2.jpg');
  assert.equal(sheet.I10.v, 'https://img.example/detail1.jpg，https://img.example/detail2.jpg');
  assert.equal(sheet.K10.v, '材质:网面；鞋底:橡胶');
  assert.equal(sheet.Q10.v, 'red-40');
  assert.equal(sheet.R10.v, '20.99');
  assert.equal(sheet.S10.v, 'https://img.example/red.jpg');
  assert.equal(sheet.T10.v, '8');
  assert.equal(sheet.U10.v, '0.7');
  assert.equal(sheet.V10.v, '30x20x10');
  for (const row of [11, 12]) {
    assert.equal(sheet[`A${row}`].v, 'PDD7788');
    for (const column of 'BCDEFGHIJKLMN') assert.equal(sheet[`${column}${row}`]?.v ?? '', '');
  }
  assert.equal(sheet.O11.v, '红色');
  assert.equal(sheet.P11.v, '41');
  assert.equal(sheet.Q11.v, 'red-41');
  assert.equal(sheet.R11.v, '21.99');
  assert.equal(sheet.S11.v, 'https://img.example/red41.jpg');
  assert.equal(sheet.T11.v, '3');
  assert.equal(sheet.U11?.v ?? '', '');
  assert.equal(sheet.V11?.v ?? '', '');
  assert.equal(sheet.O12.v, '蓝色');
  assert.equal(sheet.P12.v, '40');
  assert.equal(sheet.Q12.v, 'blue-40');
  assert.equal(sheet.R12.v, '19.99');
  assert.equal(sheet.S12.v, 'https://img.example/blue.jpg');
  assert.equal(sheet.T12.v, '12');
  assert.equal(sheet.U12.v, '0.8');
  assert.equal(sheet.V12.v, '31x21x11');
});

test('legacy export remains readable with forty product rows', () => {
  const groups = Array.from({ length: 40 }, (_, index) => ({ best: {
    id: String(100000 + index), title: `相机商品${index}`, cents: 300 + index,
    image: `https://img.pddpic.com/${index}.jpg`,
    url: `https://mobile.pinduoduo.com/goods.html?goods_id=${100000 + index}`,
  } }));
  const task = { jobs: [
    { keyword: '相机', groups: groups.slice(0, 20) },
    { keyword: '商品', groups: groups.slice(20) },
  ] };
  const bytes = workbookXlsBytes(taskSheets(task), XLSX);
  const workbook = XLSX.read(bytes, { type: 'array' });
  assert.equal(workbook.Sheets['模版'].A49.v, 'PDD100039');
});

test('legacy export refuses rows beyond the old XLS limit instead of silently dropping products', () => {
  const rows = new Array(65537);
  assert.throws(() => workbookXlsBytes([{ name: '模版', rows }], XLSX), /65536|xlsx/);
});
