import test from 'node:test';
import assert from 'node:assert/strict';
import { workbookBytes, taskSheets } from '../extension/lib/xlsx.mjs';

const decoder = new TextDecoder();

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const dataAt = at + 30 + nameLength + extraLength;
    result.set(name, decoder.decode(bytes.subarray(dataAt, dataAt + size)));
    at = dataAt + size;
  }
  assert.equal(view.getUint32(at, true), 0x02014b50, 'ZIP central directory follows local entries');
  return result;
}

test('writes a readable two-sheet OOXML package with string and numeric cells', () => {
  const bytes = workbookBytes([
    { name: '商品链接', rows: [['搜索名称', '展示价格'], ['苹果', 12.5]], widths: [20, 12] },
    { name: '任务汇总', rows: [['状态'], ['完成']] },
  ]);
  assert.ok(bytes instanceof Uint8Array);
  const files = zipEntries(bytes);
  for (const path of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(files.has(path), path);
  }
  assert.match(files.get('xl/workbook.xml'), /name="商品链接"[^>]*sheetId="1"/);
  assert.match(files.get('xl/workbook.xml'), /name="任务汇总"[^>]*sheetId="2"/);
  assert.match(files.get('xl/worksheets/sheet1.xml'), /<c r="A2" t="inlineStr"><is><t>苹果<\/t><\/is><\/c>/);
  assert.match(files.get('xl/worksheets/sheet1.xml'), /<c r="B2" s="2"><v>12\.5<\/v><\/c>/);
  assert.match(files.get('xl/worksheets/sheet1.xml'), /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(files.get('xl/worksheets/sheet1.xml'), /<autoFilter ref="A1:B2"\/>/);
  assert.match(files.get('xl/styles.xml'), /numFmtId="164" formatCode="0\.00"/);
  assert.match(files.get('xl/styles.xml'), /<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"\/><\/cellStyles>/);
});

test('escapes XML and keeps formula-looking text as literal text', () => {
  const files = zipEntries(workbookBytes([{ name: 'A&B', rows: [['标题'], ['=HYPERLINK("x") & <tag>\u0001']] }]));
  assert.match(files.get('xl/workbook.xml'), /name="A&amp;B"/);
  assert.match(files.get('xl/worksheets/sheet1.xml'), /t="inlineStr"><is><t>=HYPERLINK\(&quot;x&quot;\) &amp; &lt;tag&gt;<\/t>/);
  assert.doesNotMatch(files.get('xl/worksheets/sheet1.xml'), /<f>/);
  assert.doesNotMatch(files.get('xl/worksheets/sheet1.xml'), /\u0001/);
});

test('maps first twenty selected groups into the supplied 22-column import template', () => {
  const groups = Array.from({ length: 21 }, (_, index) => ({ best: {
    id: `id-${index}`, title: `苹果商品${index}`, cents: 1234 + index,
    url: `https://mobile.pinduoduo.com/goods.html?goods_id=${index}`,
    image: `https://img.example/${index}.jpg`, collectedAt: '2026-09-26T10:00:00.000Z',
  } }));
  const task = { jobs: [
    { keyword: '=苹果', status: 'done', scanned: 200, skipped: 4, note: '', groups },
    { keyword: '梨', status: 'paused', scanned: 5, skipped: 2, note: '验证码', groups: [] },
  ] };
  const sheets = taskSheets(task);
  assert.deepEqual(sheets.map(sheet => sheet.name), ['模版']);
  assert.match(sheets[0].rows[0][0], /^各个字段说明：/);
  assert.deepEqual(sheets[0].rows[8], [
    '*产品主编号','*产品名称','货币类型','产品主图','货源链接','货源平台','货源ID','详情描述','详情图','货源类目','自定义属性','产品视频','产品证书','尺寸图表','SKU规格1','SKU规格2','平台SKU','*SKU售价','SKU图片','SKU库存','SKU重量(KG)','SKU尺寸(CM)'
  ]);
  assert.equal(sheets[0].rows.length, 29); // 9 template rows + 20 products
  assert.deepEqual(sheets[0].rows[9], [
    'PDDid-0','苹果商品0','CNY','https://img.example/0.jpg','https://mobile.pinduoduo.com/goods.html?goods_id=0','拼多多','id-0',
    '', '', '', '', '', '', '', '', '', '', '12.34', '', '', '', ''
  ]);
  assert.equal(sheets[0].rows[28][0], 'PDDid-19');
  assert.equal(sheets[0].rows[28][17], '12.53');
  const templateWidths = Array(22).fill(8.3);
  templateWidths[8] = 39.166; templateWidths[9] = 35.984; templateWidths[10] = 31.256; templateWidths[13] = 20.71;
  assert.deepEqual(sheets[0].widths, templateWidths);
  assert.deepEqual(sheets[0].merge, ['A1:L8']);
  const output = zipEntries(workbookBytes(sheets));
  assert.match(output.get('xl/worksheets/sheet1.xml'), /<mergeCell ref="A1:L8"\/>/);
  assert.match(output.get('xl/worksheets/sheet1.xml'), /<c r="R10" t="inlineStr"><is><t>12\.34<\/t><\/is><\/c>/);
  assert.doesNotMatch(output.get('xl/worksheets/sheet1.xml'), /验证码/);
});
test('template export omits stale promotional titles while retaining a searched product', () => {
  const old={id:'1',title:'未发货秒退',cents:1000,url:'https://mobile.pinduoduo.com/goods.html?goods_id=1',image:'https://img.example/1.jpg'};
  const good={id:'2',title:'苹果手机壳透明防摔',cents:2000,url:'https://mobile.pinduoduo.com/goods.html?goods_id=2',image:'https://img.example/2.jpg'};
  const task={jobs:[{keyword:'苹果手机壳',groups:[{best:old},{best:good}]}]};
  const rows=taskSheets(task)[0].rows;
  assert.equal(rows.length,10);
  assert.equal(rows[9][1],'苹果手机壳透明防摔');
});

test('product main numbers do not restart for a different export', () => {
  const product = id => ({ id, title: '平板电脑', cents: 19900,
    url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`, image: `https://img.pddpic.com/${id}.jpg` });
  const rowsFor = id => taskSheets({ jobs: [{ keyword: '平板', groups: [{ best: product(id) }] }] })[0].rows;
  assert.equal(rowsFor('1009365571102')[9][0], 'PDD1009365571102');
  assert.equal(rowsFor('1009674887012')[9][0], 'PDD1009674887012');
});
