let encodeMap;

function gbkMap() {
  if (encodeMap) return encodeMap;
  encodeMap = new Map();
  const decoder = new TextDecoder('gbk');
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const text = decoder.decode(new Uint8Array([lead, trail]));
      if (!text || text.includes('\uFFFD') || [...text].length !== 1 || encodeMap.has(text)) continue;
      encodeMap.set(text, [lead, trail]);
    }
  }
  return encodeMap;
}

function percent(bytes) {
  return bytes.map(byte => {
    const plain = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e;
    return plain ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

// 1688 reads the keywords query as GBK. UTF-8 percent-encoding is shown as mojibake.
export function encodeGbkQuery(value) {
  const text = String(value);
  const chars = [...text];
  const map = gbkMap();
  if (chars.some(char => char.codePointAt(0) > 0x7f && !map.has(char))) return percent([...new TextEncoder().encode(text)]);
  const bytes = [];
  for (const char of chars) {
    const code = char.codePointAt(0);
    if (code <= 0x7f) bytes.push(code);
    else bytes.push(...map.get(char));
  }
  return percent(bytes);
}

export function decodeSearchKeyword(raw) {
  const source = String(raw ?? '').replace(/\+/g, ' ');
  if (!source) return '';
  const bytes = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '%' && /[0-9a-fA-F]{2}/.test(source.slice(index + 1, index + 3))) {
      bytes.push(parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const code = source.charCodeAt(index);
    if (code > 0x7f) return source;
    bytes.push(code);
  }
  const data = Uint8Array.from(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { return new TextDecoder('gbk').decode(data); }
}

export function keywordFromSearch(search, name) {
  const match = String(search || '').match(new RegExp(`[?&]${name}=([^&]*)`));
  return match ? decodeSearchKeyword(match[1]) : '';
}
