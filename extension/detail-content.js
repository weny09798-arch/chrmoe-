(() => {
  if (globalThis.__pddDetailReaderInstalled) return;
  globalThis.__pddDetailReaderInstalled = true;

  const value = item => item == null ? '' : String(item).trim();
  const words = element => value(element?.innerText || element?.textContent);
  const unique = items => [...new Set(items.filter(Boolean))];
  function httpsUrl(input) {
    const raw = value(input);
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  function yuan(input) {
    const price = value(input);
    return /^\d+(?:\.\d+)?$/.test(price) && Number(price) > 0 ? price : '';
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
    if (/\/(?:login|login_phone|login_password)\b/.test(new URL(location.href).pathname)) return '请在采集页登录拼多多';
    const phrases = [...document.querySelectorAll('div,p,span,h1,h2,h3,button')]
      .filter(element => !element.children.length && visible(element))
      .map(words).filter(phrase => phrase.length < 150);
    return phrases.find(phrase => /请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|商品已售罄|推荐以下相似商品|当前访问人数较多/.test(phrase))
      || (phrases.some(phrase => /手机号登录|请先登录|登录后查看|登录拼多多|^登录$/.test(phrase)) ? '请在采集页登录拼多多' : '');
  }

  function matchesGoods(node, goodsId) {
    if (!goodsId || !node || typeof node !== 'object' || Array.isArray(node)) return false;
    const id = value(node.goodsID ?? node.goodsId ?? node.goods_id);
    if (id !== goodsId) return false;
    return Boolean(value(node.goodsName ?? node.goods_name ?? node.title) || Array.isArray(node.skus) || Array.isArray(node.skuList));
  }

  function goodsFromState(state, goodsId) {
    if (!state || typeof state !== 'object') return null;
    const nested = state.store?.initDataObj?.goods || state.initDataObj?.goods;
    if (matchesGoods(nested, goodsId)) return nested;
    if (matchesGoods(state.goods, goodsId)) return state.goods;
    if (matchesGoods(state, goodsId)) return state;
    return null;
  }

  function jsonObjectAt(text, start) {
    let depth = 0, inString = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return '';
  }

  function scriptStates(script) {
    const text = script.textContent || '';
    if (!text.trim()) return [];
    if ((script.getAttribute('type') || '') === 'application/json') {
      try { return [JSON.parse(text)]; } catch { return []; }
    }
    const marker = /window\.rawData\s*=\s*/.exec(text);
    if (!marker) return [];
    const start = text.indexOf('{', marker.index + marker[0].length);
    if (start < 0) return [];
    const json = jsonObjectAt(text, start);
    if (!json) return [];
    try { return [JSON.parse(json)]; } catch { return []; }
  }

  function productCandidates(goodsId, pageGoods) {
    const candidates = [];
    const add = state => {
      const goods = goodsFromState(state, goodsId);
      if (goods && !candidates.includes(goods)) candidates.push(goods);
    };
    add(pageGoods);
    for (const script of document.querySelectorAll('script')) {
      for (const state of scriptStates(script)) add(state);
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

  function productRoot(goodsId) {
    const explicit = [...document.querySelectorAll('[data-goods-id]')]
      .find(element => element.getAttribute('data-goods-id') === goodsId && visible(element) && isCurrent(element, document.body, goodsId));
    const general = [...document.querySelectorAll('main,[data-product-detail]')]
      .find(element => visible(element) && isCurrent(element, document.body, goodsId));
    return explicit || general || document.body;
  }

  function isCurrent(element, root, goodsId) {
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

  function domImages(root, goodsId) {
    const images = { galleryImages: [], detailImages: [], certificateImages: [], sizeChartImages: [] };
    for (const image of root.querySelectorAll('img')) {
      if (!visible(image) || !isCurrent(image, root, goodsId)) continue;
      const url = httpsUrl(image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original'));
      const role = imageRole(image, root);
      if (url && role !== 'sku') images[role].push(url);
    }
    for (const key of Object.keys(images)) images[key] = unique(images[key]);
    return images;
  }

  function domAttributes(root, goodsId) {
    const attributes = [];
    for (const term of root.querySelectorAll('dt')) {
      const description = term.nextElementSibling;
      if (description?.tagName === 'DD' && visible(term) && visible(description) && isCurrent(term, root, goodsId)) {
        attributes.push({ name: words(term), value: words(description) });
      }
    }
    return attributes.filter(item => item.name && item.value);
  }

  function jsonAttributes(raw) {
    return (Array.isArray(raw) ? raw : []).map(item => {
      const name = value(item?.name ?? item?.key);
      const joined = Array.isArray(item?.values) ? item.values.map(value).filter(Boolean).join('，') : '';
      return { name, value: value(item?.value ?? item?.vvalue) || joined };
    }).filter(item => item.name && item.value);
  }

  function mediaUrls(raw) {
    const found = [];
    const visit = item => {
      if (typeof item === 'string') {
        const url = httpsUrl(item);
        if (url) found.push(url);
        return;
      }
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (item && typeof item === 'object') {
        const url = httpsUrl(item.url || item.imgUrl || item.imageUrl || item.image || item.src);
        if (url) found.push(url);
      }
    };
    visit(raw);
    return found;
  }

  function decorationMedia(raw) {
    const detailImages = [], certificateImages = [], sizeChartImages = [];
    if (!Array.isArray(raw)) return { detailImages, certificateImages, sizeChartImages };
    for (const floor of raw) {
      const label = `${floor?.key || ''} ${floor?.type || ''} ${floor?.title || ''}`;
      const bucket = /尺码|尺寸表|sizechart/i.test(label) ? sizeChartImages
        : /证书|资质|certificate/i.test(label) ? certificateImages
        : detailImages;
      bucket.push(...mediaUrls(floor?.contents || floor?.content));
    }
    return { detailImages, certificateImages, sizeChartImages };
  }

  function decorationText(raw) {
    if (!Array.isArray(raw)) return '';
    const parts = [];
    for (const floor of raw) {
      const contents = floor?.contents || floor?.content || [];
      for (const item of Array.isArray(contents) ? contents : [contents]) {
        const text = value(item?.text);
        if (text) parts.push(text);
      }
    }
    return parts.join('\n').slice(0, 8000);
  }

  function categoryName(raw) {
    const name = value(raw);
    return name && !/^\d+$/.test(name) ? name : '';
  }

  function videoFrom(candidates) {
    const direct = httpsUrl(first(candidates, ['videoUrl']));
    if (direct) return direct;
    const galleries = [];
    for (const key of ['videoGallery', 'descVideoGallery']) {
      const found = first(candidates, [key]);
      if (Array.isArray(found)) galleries.push(...found);
    }
    for (const item of galleries) {
      const video = httpsUrl(item?.videoUrl || item?.video_url);
      if (video) return video;
      const url = httpsUrl(typeof item === 'string' ? item : item?.url);
      if (url && /\.(mp4|m3u8|webm)(\?|$)/i.test(url)) return url;
    }
    return '';
  }

  function specValues(specs) {
    if (!Array.isArray(specs)) return [];
    return specs.map(spec => spec && typeof spec === 'object'
      ? value(spec.spec_value ?? spec.specValue ?? spec.value)
      : value(spec)).filter(Boolean);
  }

  function specNamesFrom(candidates, rawSkus) {
    const named = first(candidates, ['specNames']);
    const explicit = Array.isArray(named) ? named.map(value).filter(Boolean) : [];
    if (explicit.length) return explicit;
    const names = [];
    for (const sku of rawSkus || []) {
      for (const spec of sku?.specs || []) {
        const key = value(spec?.spec_key ?? spec?.specKey);
        if (key && !names.includes(key)) names.push(key);
      }
    }
    return names;
  }

  function skuStock(sku) {
    const explicit = value(sku?.stock);
    if (explicit) return explicit;
    if (sku?.quantity == null || sku.quantity === '') return '';
    const quantity = Number(sku.quantity);
    return Number.isFinite(quantity) && quantity >= 0 ? String(quantity) : '';
  }

  function skuWeightKg(sku) {
    const explicit = value(sku?.weightKg);
    if (explicit) return explicit;
    const grams = Number(sku?.weight);
    if (!Number.isFinite(grams) || grams <= 0) return '';
    return String(Number((grams / 1000).toFixed(3)));
  }

  function mapSku(sku) {
    const price = yuan(sku?.groupPrice) || yuan(sku?.normalPrice) || yuan(sku?.price);
    let cents = sku?.cents;
    if (!price && Number.isSafeInteger(sku?.oldGroupPrice) && sku.oldGroupPrice > 0) cents = sku.oldGroupPrice;
    return {
      id: value(sku?.id ?? sku?.skuId ?? sku?.skuID),
      specs: specValues(sku?.specs),
      cents,
      price,
      image: httpsUrl(sku?.image || sku?.thumbUrl || sku?.thumb_url),
      stock: skuStock(sku),
      weightKg: skuWeightKg(sku),
      sizeCm: value(sku?.sizeCm)
    };
  }

  function detailSnapshot(pageGoods) {
    const url = location.href;
    const goodsId = new URL(url).searchParams.get('goods_id') || '';
    const reason = blockedReason();
    if (reason) return { url, goodsId, blocked: true, reason, ready: false, source: 'blocked', detail: null };

    const candidates = productCandidates(goodsId, pageGoods);
    const root = productRoot(goodsId);
    const structuredSkus = first(candidates, ['skus', 'skuList']);
    const hasStructuredSkus = Array.isArray(structuredSkus) && structuredSkus.some(sku => {
      const mapped = mapSku(sku);
      return Number(mapped.price) > 0 || Number(mapped.cents) > 0;
    });
    const ui = globalThis.__pddDetailUI?.read(root, goodsId, hasStructuredSkus);
    const images = ui || domImages(root, goodsId);
    const titleElement = [...root.querySelectorAll('h1,[data-goods-name]')]
      .find(element => visible(element) && isCurrent(element, root, goodsId));
    const jsonSkus = first(candidates, ['skus', 'skuList']);
    const rawSkus = Array.isArray(jsonSkus) ? jsonSkus : [];
    const attributes = jsonAttributes(first(candidates, ['goodsProperty', 'properties', 'attributes']));
    for (const item of [...domAttributes(root, goodsId), ...(ui?.attributes || [])]) {
      if (!attributes.some(existing => existing.name === item.name && existing.value === item.value)) attributes.push(item);
    }
    const title = value(first(candidates, ['goodsName', 'goods_name', 'title'])) || words(titleElement);
    const jsonGallery = mediaUrls(first(candidates, ['topGallery', 'gallery', 'galleryImages', 'viewImageData']));
    const jsonDetail = mediaUrls(first(candidates, ['detailGallery', 'detailImages']));
    const decoration = decorationMedia(first(candidates, ['decoration']));
    const detail = {
      title,
      price: yuan(first(candidates, ['minGroupPrice'])) || yuan(first(candidates, ['price'])),
      cents: first(candidates, ['cents']),
      galleryImages: unique([...jsonGallery, ...images.galleryImages].map(url => ui ? globalThis.__pddDetailUI.mediaUrl(url) : url)),
      descriptionText: attributes.map(item => `${item.name}：${item.value}`).join('\n'),
      detailImages: unique([...jsonDetail, ...decoration.detailImages, ...images.detailImages].map(url => ui ? globalThis.__pddDetailUI.mediaUrl(url) : url)),
      category: categoryName(first(candidates, ['category', 'catName', 'categoryName'])),
      attributes,
      videoUrl: videoFrom(candidates),
      certificateImages: unique([...mediaUrls(first(candidates, ['certificateImages'])), ...decoration.certificateImages, ...images.certificateImages]),
      sizeChartImages: unique([...mediaUrls(first(candidates, ['sizeChartImages'])), ...decoration.sizeChartImages, ...images.sizeChartImages]),
      specNames: hasStructuredSkus ? specNamesFrom(candidates, rawSkus) : ui?.specNames || [],
      skus: hasStructuredSkus ? rawSkus.map(mapSku) : ui?.skus || [],
      detailStatus: hasStructuredSkus && (jsonDetail.length || images.detailImages.length) ? 'done' : 'partial',
      detailNote: hasStructuredSkus ? '' : '正在读取规格弹窗；页面未提供的 SKU 编号、库存等字段留空'
    };
    const ready = Boolean(candidates.length && (
      detail.descriptionText || detail.category || detail.videoUrl ||
      detail.detailImages.length || detail.certificateImages.length || detail.sizeChartImages.length ||
      detail.attributes.length || detail.specNames.length || detail.skus.length
    ));
    const skuPending = !hasStructuredSkus && (ui?.pending ?? true);
    const detailPending = !detail.detailImages.length || Boolean(ui?.detailPending && !jsonDetail.length && !decoration.detailImages.length);
    if (skuPending || detailPending) detail.detailStatus = 'partial';
    if (!skuPending && !hasStructuredSkus) detail.detailNote = '已按选中规格等待页面稳定，读取展示价格和图片；页面未提供的 SKU 编号、库存等字段留空';
    if (ui?.unconfirmed) detail.detailNote += `；${ui.unconfirmed} 组规格未读取到稳定的选中状态、价格或图片，未导出这些规格`;
    if (ui?.unavailable) detail.detailNote += `；已跳过 ${ui.unavailable} 组页面不可选的缺货规格`;
    if (detailPending) detail.detailNote += (detail.detailNote ? '；' : '') + '未读取到图文详情图片';
    return { url, goodsId, blocked: false, reason: '', ready: ready && !skuPending && !detailPending, skuPending, skuTotal: ui?.skuTotal || 0, skuDimensions: ui?.skuDimensions || 0, detailPending, source: candidates.length ? 'json' : 'dom', detail };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'PDD_DETAIL_SNAPSHOT') respond(detailSnapshot(message.pageGoods));
  });
})();
