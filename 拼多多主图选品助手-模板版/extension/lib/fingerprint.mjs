// A 63-bit perceptual hash plus color and contrast gates. All computation is local.
export function fingerprint(rgba, size = 32) {
  if (rgba.length !== size * size * 4 || size < 8) throw new Error('图片像素尺寸不正确');
  const gray = [], color = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) color[c] += rgba[i + c];
    gray.push(.299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2]);
  }
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const spread = Math.sqrt(gray.reduce((a, b) => a + (b - mean) ** 2, 0) / gray.length);
  const cos = Array.from({ length: 8 }, (_, u) => Array.from({ length: size }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * size))));
  const coeff = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    if (!u && !v) continue;
    let value = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) value += gray[y * size + x] * cos[u][x] * cos[v][y];
    coeff.push(value);
  }
  const median = [...coeff].sort((a, b) => a - b)[31];
  let bits = 0n;
  for (const v of coeff) bits = (bits << 1n) | BigInt(v > median);
  return { bits: bits.toString(16).padStart(16, '0'), color: color.map(v => v / gray.length), spread };
}

export function similar(a, b) {
  if (!a || !b || a.spread < 8 || b.spread < 8) return false;
  if (Math.max(...a.color.map((v, i) => Math.abs(v - b.color[i]))) > 28) return false;
  if (Math.abs(a.spread - b.spread) > 22) return false;
  let x = BigInt(`0x${a.bits}`) ^ BigInt(`0x${b.bits}`), distance = 0;
  while (x) { x &= x - 1n; distance++; }
  return distance <= 6;
}
