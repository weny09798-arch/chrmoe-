// Executed in the page's MAIN world. Read already-loaded data only; never
// request a search endpoint or return account/session fields to the extension.
export function readLivePddSearch() {
  let url;
  try { url = new URL(location.href); } catch { return null; }
  if (!['https://mobile.pinduoduo.com', 'https://mobile.yangkeduo.com'].includes(url.origin)
    || url.pathname !== '/search_result.html') return null;
  const goods = [], seen = new WeakSet(), queue = [{ node: globalThis.rawData, depth: 0 }];
  for (let index = 0; index < queue.length && index < 5000; index++) {
    const { node, depth } = queue[index];
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 10) continue;
    seen.add(node);
    if (!Array.isArray(node)) {
      const rawId = node.goodsID ?? node.goodsId ?? node.goods_id;
      const id = typeof rawId === 'string' ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : '';
      const title = node.goodsName ?? node.goods_name;
      const images = [node.thumbUrl, node.thumb_url, node.hdThumbUrl, node.hd_thumb_url,
        node.goodsImageUrl, node.goods_image_url].filter(value => typeof value === 'string' && value);
      if (/^\d+$/.test(id) && typeof title === 'string' && title.trim() && images.length) {
        goods.push({ id, title: title.trim(), images: [...new Set(images)] });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (/recommend|suggest|related|history|avatar|account|user|token|cookie/i.test(key)) continue;
      if (value && typeof value === 'object' && queue.length < 5000) queue.push({ node: value, depth: depth + 1 });
    }
  }
  return { url: url.href, goods };
}
