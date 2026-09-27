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
