// Executed in the page's MAIN world. Read already-loaded data only; never
// request a search endpoint or return account/session fields to the extension.
export function readLivePddSearch() {
  let url;
  try { url = new URL(location.href); } catch { return null; }
  if (!['https://mobile.pinduoduo.com', 'https://mobile.yangkeduo.com'].includes(url.origin)
    || url.pathname !== '/search_result.html') return null;
  const goods = [], seen = new WeakSet(), queued = new WeakSet(), queue = [];
  const enqueue = (node, depth, local) => {
    if (!node || typeof node !== 'object' || queued.has(node) || queue.length >= 5000) return;
    queued.add(node);queue.push({node,depth,local});
  };
  enqueue(globalThis.rawData,0,false);
  // Client-loaded lists keep records on the rendered card's React ancestors.
  // Read committed props only, never events, stores or contexts.
  const committed = new WeakMap();
  const currentFiber = (node, depth = 0) => {
    if (!node || depth >= 100) return null;
    if (committed.has(node)) return committed.get(node);
    if (node.tag === 3) return node.stateNode?.current || null;
    if (!node.return) return node;
    const parent = currentFiber(node.return, depth + 1);
    let result = null;
    for (let child = parent?.child, count = 0; child && count < 500; child = child.sibling, count++) {
      if (child === node || child === node.alternate) { result = child; break; }
    }
    committed.set(node, result);
    return result;
  };
  const visible = el => {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      if (p.hidden || p.getAttribute('aria-hidden') === 'true') return false;
      const css = getComputedStyle(p);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    return true;
  };
  const inspected = new WeakSet();
  for (const seed of [...(globalThis.document?.querySelectorAll('img,[data-uniqid]') || [])].slice(0,500)) {
    if (!visible(seed)) continue;
    for (let el = seed, depth = 0; el && el !== document.body && depth < 7; el = el.parentElement, depth++) {
      if (inspected.has(el)) continue;
      inspected.add(el);
      for (const key of Object.keys(el)) {
        if (/^__reactProps\$/.test(key)) enqueue(el[key],0,true);
        else if (/^__react(?:Fiber\$|InternalInstance\$)/.test(key)) {
          for (let fiber=currentFiber(el[key]), level=0;fiber&&level<12;fiber=currentFiber(fiber.return),level++) {
            enqueue(fiber.memoizedProps,0,true);
            if (queue.length >= 5000) break;
          }
        }
        if (queue.length >= 5000) break;
      }
      if (queue.length >= 5000) break;
    }
    if (queue.length >= 5000) break;
  }
  for (let index = 0; index < queue.length && index < 5000; index++) {
    const { node, depth, local } = queue[index];
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 10) continue;
    seen.add(node);
    if (!Array.isArray(node)) {
      const rawId = node.goodsID ?? node.goodsId ?? node.goods_id;
      const id = typeof rawId === 'string' ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : '';
      const title = node.goodsName ?? node.goods_name;
      const images = [node.thumbUrl, node.thumb_url, node.hdThumbUrl, node.hd_thumb_url,
        node.goodsImageUrl, node.goods_image_url, node.imgUrl].filter(value => typeof value === 'string' && value);
      if (/^\d+$/.test(id) && typeof title === 'string' && title.trim() && images.length) {
        goods.push({ id, title: title.trim(), images: [...new Set(images)] });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (/recommend|suggest|related|history|avatar|account|user|token|cookie/i.test(key)) continue;
      if (local && /store|context|owner|state|alternate/i.test(key)) continue;
      if (local && !Array.isArray(node) && !['data','goods','goodsData','goodsInfo','item','product','children','props'].includes(key)) continue;
      enqueue(value,depth+1,local);
    }
  }
  return { url: url.href, goods };
}
