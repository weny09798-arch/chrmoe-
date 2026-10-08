// Small OOXML writer for extension exports. ZIP entries are stored without compression.
const encoder = new TextEncoder();
import { TEMPLATE_HEADERS, TEMPLATE_INSTRUCTIONS } from './template.mjs';
import { outputLimit, validProductTitle } from './core.mjs';
import { fallbackSku } from './detail.mjs';
import { matchTemplateXls } from './xls-biff.mjs';
import { buildImageManifest, imagePositionKey, matchingImageReplacements } from './image-conversion.mjs';
const LINK_HEADERS = new Set(['商品链接', '主图地址', '货源链接', '产品主图']);

function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function column(index) {
  let name = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function sheetXml(sheet, sheetIndex) {
  const rows = sheet.rows || [];
  const count = Math.max(1, ...rows.map(row => row.length));
  const headerRow = sheet.headerRow ?? 0;
  const priceColumn = Math.max(rows[headerRow]?.indexOf('展示价格') ?? -1, rows[headerRow]?.indexOf('*SKU售价') ?? -1);
  const linkColumns = rows[headerRow]?.map((value, index) => LINK_HEADERS.has(value) ? index : -1).filter(index => index >= 0) || [];
  const links = [];
  const rowXml = new Array(rows.length);
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = [];
    row.forEach((value, cellIndex) => {
      if (value === null || value === undefined || value === '') return;
      const ref = `${column(cellIndex)}${rowNumber}`;
      const styleId = sheet.template
        ? rowIndex === 0 && cellIndex === 0 ? 5
          : rowIndex === headerRow ? ([0, 1, 17].includes(cellIndex) ? 4 : 3)
          : rowIndex > headerRow && cellIndex === priceColumn && typeof value === 'number' ? 2 : 0
        : rowIndex === 0 ? 1 : cellIndex === priceColumn && typeof value === 'number' ? 2 : 0;
      const style = styleId ? ` s="${styleId}"` : '';
      if (typeof value === 'number' && Number.isFinite(value)) {
        cells.push(`<c r="${ref}"${style}><v>${value}</v></c>`);
      } else {
        const content = xml(value);
        const preserve = /^\s|\s$/.test(String(value)) ? ' xml:space="preserve"' : '';
        cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t${preserve}>${content}</t></is></c>`);
        if (rowIndex > headerRow && linkColumns.includes(cellIndex) && /^https?:\/\/[^\s，,]+$/i.test(String(value))) {
          links.push({ ref, target: String(value) });
        }
      }
    });
    rowXml[rowIndex] = `<row r="${rowNumber}"${sheet.template && rowIndex < 8 ? ' ht="25" customHeight="1"' : ''}>${cells.join('')}</row>`;
  });
  const body = rowXml.join('');
  const widths = sheet.widths?.length ? `<cols>${sheet.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(width)}" customWidth="1"/>`).join('')}</cols>` : '';
  const lastRef = `${column(count - 1)}${Math.max(rows.length, 1)}`;
  const hyperlinkXml = links.length ? `<hyperlinks>${links.map((link, index) => `<hyperlink ref="${link.ref}" r:id="rId${index + 1}"/>`).join('')}</hyperlinks>` : '';
  const freeze = headerRow + 1;
  const firstHeaderRef = `A${freeze}`;
  const merged = sheet.merge?.length ? `<mergeCells count="${sheet.merge.length}">${sheet.merge.map(range => `<mergeCell ref="${xml(range)}"/>`).join('')}</mergeCells>` : '';
  const content = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastRef}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths}<sheetData>${body}</sheetData><autoFilter ref="${firstHeaderRef}:${lastRef}"/>${merged}${hyperlinkXml}</worksheet>`;
  const relationships = links.length ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((link, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.target)}" TargetMode="External"/>`).join('')}</Relationships>` : null;
  return { content, relationships, sheetIndex };
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF245A81"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint32(14, checksum, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true); local.set(name, 30);
    chunks.push(local, data);
    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint32(16, checksum, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); entry.set(name, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true); e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const chunk of [...chunks, ...central, end]) { output.set(chunk, at); at += chunk.length; }
  return output;
}

export function workbookBytes(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new TypeError('At least one sheet is required');
  const worksheets = sheets.map((sheet, index) => sheetXml(sheet, index + 1));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const files = [['[Content_Types].xml', contentTypes], ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', workbookRels], ['xl/styles.xml', STYLES]];
  worksheets.forEach(({ content, relationships }, index) => {
    files.push([`xl/worksheets/sheet${index + 1}.xml`, content]);
    if (relationships) files.push([`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, relationships]);
  });
  return zip(files);
}

// The user's source template is a BIFF8 .xls. SheetJS is bundled locally in the
// extension for this legacy format; the XLSX writer above remains dependency-free.
export function workbookXlsBytes(sheets, sheetjs = globalThis.XLSX) {
  if (!sheetjs?.utils || !Array.isArray(sheets) || !sheets.length) throw new Error('旧版 XLS 导出组件未加载');
  const workbook = sheetjs.utils.book_new();
  for (const sheet of sheets) {
    if (sheet.rows.length > 65536) throw new Error('旧版 .xls 最多支持 65536 行，请选择 .xlsx 导出');
    const worksheet = sheetjs.utils.aoa_to_sheet(sheet.rows);
    worksheet['!merges'] = (sheet.merge || []).map(sheetjs.utils.decode_range);
    worksheet['!cols'] = (sheet.widths || []).map(wch => ({ wch }));
    const headerRow = sheet.headerRow ?? 0;
    const linkColumns = sheet.rows[headerRow]?.map((value, index) => LINK_HEADERS.has(value) ? index : -1).filter(index => index >= 0) || [];
    for (let row = headerRow + 1; row < sheet.rows.length; row++) for (const column of linkColumns) {
      const value = sheet.rows[row]?.[column];
      const ref = sheetjs.utils.encode_cell({ r: row, c: column });
        if (typeof value === 'string' && /^https?:\/\/[^\s，,]+$/i.test(value) && worksheet[ref]) worksheet[ref].l = { Target: value };
    }
    sheetjs.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  const bytes = new Uint8Array(sheetjs.write(workbook, { bookType: 'biff8', type: 'array', cellStyles: true, bookSST: true }));
  return sheets.length === 1 && sheets[0].template ? matchTemplateXls(bytes, sheetjs) : bytes;
}

const cellText = value => value == null ? '' : String(value).trim();
const joinedValues = values => Array.isArray(values) ? values.map(cellText).filter(Boolean).join('，') : '';

export function productRows(item, fallbackNumber = 0) {
  const id = cellText(item.id);
  const prefix = item.site === 'taobao' ? item.platform === '天猫' ? 'TM' : 'TB' : 'PDD';
  const number = `${prefix}${id || (fallbackNumber ? String(fallbackNumber).padStart(6, '0') : '')}`;
  const gallery = joinedValues(item.galleryImages) || cellText(item.image);
  const attributes = Array.isArray(item.attributes)
    ? item.attributes.map(attribute => {
      const name = cellText(attribute?.name);
      const value = cellText(attribute?.value);
      return name && value ? `${name}:${value}` : '';
    }).filter(Boolean).join('；')
    : '';
  const common = [
    cellText(item.title), 'CNY', gallery, cellText(item.url), cellText(item.platform) || '拼多多', id,
    '', joinedValues(item.detailImages), cellText(item.category),
    attributes, cellText(item.videoUrl), joinedValues(item.certificateImages), joinedValues(item.sizeChartImages)
  ];
  const skus = Array.isArray(item.skus) && item.skus.length ? item.skus : [fallbackSku(item)];
  return skus.map((sku, index) => {
    const cents = Number.isSafeInteger(sku?.cents) && sku.cents > 0 ? sku.cents : item.cents;
    return [
      number, ...(index === 0 ? common : Array(13).fill('')),
      cellText(sku?.specs?.[0]), cellText(sku?.specs?.[1]), cellText(sku?.id),
      (cents / 100).toFixed(2), cellText(sku?.image), cellText(sku?.stock),
      cellText(sku?.weightKg), cellText(sku?.sizeCm)
    ];
  });
}

export function taskSheets(task) {
  const rows = [[TEMPLATE_INSTRUCTIONS], [], [], [], [], [], [], [], [...TEMPLATE_HEADERS]];
  const replacements = new Map(matchingImageReplacements(task,task.imageReplacements).map(ref => [imagePositionKey(ref),ref.published_url]));
  const manifest = buildImageManifest(task);
  const replaced = manifest.filter(ref => replacements.has(imagePositionKey(ref))).length;
  const overlay = (item,job) => {
    const common = {platform:item.site || job.site || 'pdd',product_id:String(item.id ?? '')};
    const replace = (url,kind,index) => replacements.get(imagePositionKey({...common,kind,order:index + 1,sku_index:kind === 'sku' ? index : null,url})) || url;
    return {...item, image:replace(item.image,'main',0), galleryImages:Array.isArray(item.galleryImages) ? item.galleryImages.map((url,index) => replace(url,'main',index)) : item.galleryImages,
      detailImages:Array.isArray(item.detailImages) ? item.detailImages.map((url,index) => replace(url,'detail',index)) : item.detailImages,
      skus:Array.isArray(item.skus) && item.skus.length ? item.skus.map((sku,index) => ({...sku,image:replace(sku?.image,'sku',index)})) : [fallbackSku(item)]};
  };
  let productNumber = 0;
  for (const job of task.jobs) {
    const chosen = (job.groups || []).map(group => group.best).filter(item => item && validProductTitle(item.title, job.keyword)).slice(0, outputLimit(job));
    for (const item of chosen) {
      productNumber++;
      rows.push(...productRows(overlay(item,job), productNumber));
    }
  }
  const widths = Array(22).fill(8.3);
  widths[8] = 39.166; widths[9] = 35.984; widths[10] = 31.256; widths[13] = 20.71;
  return [{ name: '模版', rows, headerRow: 8, template: true, merge: ['A1:L8'], widths, imageReplacementCounts:{replaced,fallback:manifest.length-replaced,total:manifest.length} }];
}
