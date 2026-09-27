(() => {
  if (globalThis.__pddDetailReaderInstalled) return;
  globalThis.__pddDetailReaderInstalled = true;

  const value = item => item == null ? '' : String(item).trim();
  const words = element => value(element?.innerText || element?.textContent);
  const unique = items => [...new Set(items.filter(Boolean))];
  const goodsId = new URL(location.href).searchParams.get('goods_id') || '';

  function httpsUrl(input) {
    const raw = value(input);
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  function urls(items) {
    return unique((Array.isArray(items) ? items : []).map(httpsUrl));
  }

  function visible(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function blockedReason() {
    if (/\/(?:login|login_phone|login_password)\b/.test(location.pathname)) return '请在采集页登录拼多多';
    const phrases = [...document.querySelectorAll('div,p,span,h1,h2,h3,button')]
      .filter(element => !element.children.length && visible(element))
      .map(words).filter(phrase => phrase.length < 150);
    return phrases.find(phrase => /请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份/.test(phrase))
      || (phrases.some(phrase => /手机号登录|请先登录|登录后查看|登录拼多多|^登录$/.test(phrase)) ? '请在采集页登录拼多多' : '');
  }

  function productCandidates() {
    const candidates = [];
    const visited = new Set();
    function scan(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 30 || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) scan(item, depth + 1);
        return;
      }
      const id = node.goodsId ?? node.goods_id;
      if (id != null) {
        if (value(id) !== goodsId) return;
        candidates.push(node);
      }
      for (const [key, child] of Object.entries(node)) {
        if (/recommend|suggest|related|hotGoods/i.test(key)) continue;
        if (child && typeof child === 'object') scan(child, depth + 1);
      }
    }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try { scan(JSON.parse(script.textContent)); } catch { /* Non-JSON page data is ignored. */ }
    }
    return candidates;
  }

  function first(candidates, keys) {
    for (const item of candidates) {
      for (const key of keys) {
        const found = item[key];
        if (Array.isArray(found) ? found.length : value(found)) return found;
      }
    }
    return undefined;
  }

  function productRoot() {
    const explicit = [...document.querySelectorAll('[data-goods-id]')]
      .find(element => element.getAttribute('data-goods-id') === goodsId && visible(element));
    return explicit || document.querySelector('main,[data-product-detail]') || document.body;
  }

  function isCurrent(element, root) {
    for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
      const id = node.getAttribute?.('data-goods-id');
      if (id && id !== goodsId) return false;
      const role = `${node.getAttribute?.('data-role') || ''} ${node.id || ''} ${node.className || ''}`;
      if (/recommend|suggest|related/i.test(role)) return false;
      if (node.tagName === 'ASIDE') return false;
    }
    return true;
  }

  function imageRole(image, root) {
    for (let node = image.parentElement; node && node !== root.parentElement; node = node.parentElement) {
      const label = `${node.getAttribute?.('data-role') || ''} ${node.id || ''} ${node.className || ''}`;
      if (/certificat|资质|证书|检测报告/i.test(label)) return 'certificateImages';
      if (/size.chart|尺码|尺寸/i.test(label)) return 'sizeChartImages';
      if (/\bsku\b|规格|款式/i.test(label)) return 'sku';
      if (/detail|描述|详情/i.test(label)) return 'detailImages';
      if (/gallery|主图|轮播/i.test(label)) return 'galleryImages';
    }
    const alt = image.getAttribute('alt') || '';
    if (/证书|资质/.test(alt)) return 'certificateImages';
    if (/尺码|尺寸/.test(alt)) return 'sizeChartImages';
    if (/详情/.test(alt)) return 'detailImages';
    return 'galleryImages';
  }

  function domImages(root) {
    const images = { galleryImages: [], detailImages: [], certificateImages: [], sizeChartImages: [] };
    for (const image of root.querySelectorAll('img')) {
      if (!visible(image) || !isCurrent(image, root)) continue;
      const url = httpsUrl(image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original'));
      const role = imageRole(image, root);
      if (url && role !== 'sku') images[role].push(url);
    }
    for (const key of Object.keys(images)) images[key] = unique(images[key]);
    return images;
  }

  function domAttributes(root) {
    const attributes = [];
    for (const term of root.querySelectorAll('dt')) {
      const description = term.nextElementSibling;
      if (description?.tagName === 'DD' && visible(term) && visible(description) && isCurrent(term, root)) {
        attributes.push({ name: words(term), value: words(description) });
      }
    }
    return attributes.filter(item => item.name && item.value);
  }

  function jsonAttributes(raw) {
    return (Array.isArray(raw) ? raw : []).map(item => ({ name: value(item?.name ?? item?.key), value: value(item?.value) }))
      .filter(item => item.name && item.value);
  }

  function detailSnapshot() {
    const url = location.href;
    const reason = blockedReason();
    if (reason) return { url, goodsId, blocked: true, reason, detail: null };

    const candidates = productCandidates();
    const root = productRoot();
    const images = domImages(root);
    const titleElement = [...root.querySelectorAll('h1,[data-goods-name]')]
      .find(element => visible(element) && isCurrent(element, root));
    const descriptionElement = [...root.querySelectorAll('[data-role="description"],[class*="description"]')]
      .find(element => visible(element) && isCurrent(element, root));
    const video = [...root.querySelectorAll('video[src],video source[src]')]
      .find(element => visible(element) && isCurrent(element, root));
    const jsonSkus = first(candidates, ['skus', 'skuList']);
    const attributes = jsonAttributes(first(candidates, ['properties', 'attributes']));
    for (const item of domAttributes(root)) {
      if (!attributes.some(existing => existing.name === item.name && existing.value === item.value)) attributes.push(item);
    }
    const detail = {
      title: value(first(candidates, ['goodsName', 'title'])) || words(titleElement),
      galleryImages: unique([...urls(first(candidates, ['gallery', 'galleryImages'])), ...images.galleryImages]),
      descriptionText: value(first(candidates, ['descriptionText', 'description'])) || words(descriptionElement),
      detailImages: unique([...urls(first(candidates, ['detailGallery', 'detailImages'])), ...images.detailImages]),
      category: value(first(candidates, ['category'])),
      attributes,
      videoUrl: httpsUrl(first(candidates, ['videoUrl'])) || httpsUrl(video?.getAttribute('src')),
      certificateImages: unique([...urls(first(candidates, ['certificateImages'])), ...images.certificateImages]),
      sizeChartImages: unique([...urls(first(candidates, ['sizeChartImages'])), ...images.sizeChartImages]),
      specNames: (Array.isArray(first(candidates, ['specNames'])) ? first(candidates, ['specNames']) : []).map(value).filter(Boolean),
      skus: Array.isArray(jsonSkus) ? jsonSkus.map(sku => ({
        id: value(sku?.id ?? sku?.skuId),
        specs: Array.isArray(sku?.specs) ? sku.specs.map(value) : [],
        price: value(sku?.price),
        image: httpsUrl(sku?.image),
        stock: value(sku?.stock),
        weightKg: value(sku?.weightKg),
        sizeCm: value(sku?.sizeCm)
      })) : [],
      detailStatus: candidates.length ? 'done' : 'partial',
      detailNote: ''
    };
    return { url, goodsId, blocked: false, reason: '', detail };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'PDD_DETAIL_SNAPSHOT') respond(detailSnapshot());
  });
})();
