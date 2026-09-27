// The supplied BIFF8 template uses Calibri 11 and a red font for its three
// required headings. SheetJS CE writes cell values but drops those styles.
// These records were copied from 导入产品模板.xls and applied to its layout.
const TEMPLATE_FONTS = [
  '31001e00dc000000080090010000000000000701430061006c006900620072006900',
  '31001e00dc0000000a0090010000000000000701430061006c006900620072006900',
];
const TEMPLATE_XFS = [
  'e0001400000000000100200000c000000000000000000904',
  'e0001400000000000100280000d000000000000000000904',
  'e0001400010000000100200000c800000000000000000904',
];

function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g), part => Number.parseInt(part, 16));
}

function records(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let at = 0; at < bytes.length;) {
    if (at + 4 > bytes.length) throw new Error('XLS 工作簿记录不完整');
    const id = view.getUint16(at, true), length = view.getUint16(at + 2, true);
    if (at + 4 + length > bytes.length) throw new Error('XLS 工作簿记录长度错误');
    result.push({ id, bytes: bytes.slice(at, at + 4 + length) });
    at += 4 + length;
  }
  return result;
}

function join(records) {
  const length = records.reduce((total, record) => total + record.bytes.length, 0);
  const result = new Uint8Array(length);
  let at = 0;
  for (const record of records) { result.set(record.bytes, at); at += record.bytes.length; }
  return result;
}

export function matchTemplateXls(bytes, sheetjs) {
  if (!sheetjs?.CFB) throw new Error('XLS 模板样式组件未加载');
  const cfb = sheetjs.CFB.read(bytes, { type: 'array' });
  const entry = sheetjs.CFB.find(cfb, 'Workbook');
  if (!entry?.content) throw new Error('XLS 工作簿内容缺失');
  const all = records(entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content));
  const globalEnd = all.findIndex(record => record.id === 0x000a);
  if (globalEnd < 0) throw new Error('XLS 全局记录缺失');
  const global = all.slice(0, globalEnd + 1), cells = all.slice(globalEnd + 1);
  const fonts = global.filter(record => record.id === 0x0031);
  const xfs = global.filter(record => record.id === 0x00e0);
  if (fonts.length !== 1 || xfs.length !== 17) throw new Error('XLS 模板样式布局发生变化');
  const oldGlobalLength = global.reduce((total, record) => total + record.bytes.length, 0);
  const styled = [];
  let fontIndex = 0, xfIndex = 0;
  for (const record of global) {
    if (record.id === 0x0031) {
      styled.push({ id: record.id, bytes: fromHex(TEMPLATE_FONTS[fontIndex++]) });
      styled.push({ id: record.id, bytes: fromHex(TEMPLATE_FONTS[1]) });
    } else if (record.id === 0x00e0) {
      styled.push(xfIndex >= 15 ? { id: record.id, bytes: fromHex(TEMPLATE_XFS[xfIndex - 15]) } : record);
      if (++xfIndex === xfs.length) styled.push({ id: record.id, bytes: fromHex(TEMPLATE_XFS[2]) });
    } else styled.push(record);
  }
  const delta = styled.reduce((total, record) => total + record.bytes.length, 0) - oldGlobalLength;
  for (const record of styled) if (record.id === 0x0085) {
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    view.setUint32(4, view.getUint32(4, true) + delta, true);
  }
  for (const record of cells) if ([0x00fd, 0x0204, 0x0203, 0x027e, 0x0201].includes(record.id) && record.bytes.length >= 10) {
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    const row = view.getUint16(4, true), column = view.getUint16(6, true);
    if (row >= 8) view.setUint16(8, row === 8 && [0, 1, 17].includes(column) ? 17 : 15, true);
  }
  entry.content = join([...styled, ...cells]);
  entry.size = entry.content.length;
  return new Uint8Array(sheetjs.CFB.write(cfb, { type: 'array' }));
}
