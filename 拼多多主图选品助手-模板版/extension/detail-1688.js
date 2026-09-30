(() => {
  if (globalThis.__aliDetailReaderInstalled) return;
  globalThis.__aliDetailReaderInstalled = true;

  const value = item => item == null ? '' : String(item).trim();
  const words = element => value(element?.innerText || element?.textContent);
  function httpsUrl(input) {
    const raw = value(input);
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }
  function fullSize(input) {
    const absolute = httpsUrl(input);
    if (!absolute) return '';
    try {
      const parsed = new URL(absolute);
      if (parsed.hostname !== 'alicdn.com' && !parsed.hostname.endsWith('.alicdn.com')) return absolute;
      parsed.pathname = parsed.pathname.replace(/(\.(?:jpg|jpeg|png|webp))(?:_[^/]*)?$/i, '$1');
      if (/x-oss-process|resize/i.test(parsed.search)) parsed.search = '';
      return parsed.href;
    } catch { return absolute; }
  }
  function visible(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    if (document.hidden) return true;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }
  function present(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function blockedReason() {
    if (/login\.1688\.com$/.test(location.hostname)) return '请在采集页登录 1688';
    const phrases = [...document.querySelectorAll('div,p,span,h1,h2,button')]
      .filter(element => !element.children.length && visible(element))
      .map(words).filter(phrase => phrase.length < 150);
    return phrases.find(phrase => /请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|验证码/.test(phrase))
      || (phrases.some(phrase => /请登录|登录后查看|手机号登录/.test(phrase)) ? '请在采集页登录 1688' : '');
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
  function initData() {
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      const marker = /__INIT_DATA\s*=\s*/.exec(text);
      if (!marker) continue;
      const start = text.indexOf('{', marker.index + marker[0].length);
      if (start < 0) continue;
      const json = jsonObjectAt(text, start);
      if (!json) continue;
      try { return JSON.parse(json); } catch { /* A non-JSON assignment is ignored. */ }
    }
    return null;
  }
  function offerRoot(data, goodsId) {
    const candidates = [data?.data, data?.result?.data, data].filter(item => item && typeof item === 'object' && !Array.isArray(item));
    const matched = candidates.find(item => value(item.offerId || item.offerID) === goodsId);
    if (matched) return matched;
    return candidates.find(item => (item.skuModel || item.subject) && item.offerId == null && item.offerID == null) || null;
  }
  function specValues(key) {
    return String(key || '').split(/[;；]/).map(part => {
      const bits = part.split('>');
      return value(bits.length > 1 ? bits.at(-1) : part);
    }).filter(Boolean).slice(0, 2);
  }
  function yuan(input) {
    if (typeof input === 'number' && Number.isFinite(input)) input = String(input);
    const price = value(input);
    return /^\d+(?:\.\d+)?$/.test(price) && Number(price) > 0 ? price : '';
  }
  function isShopName(text) {
    const name = value(text).replace(/\s+/g, '');
    return name.length > 1 && name.length <= 40 && /(?:厂|公司|商行|经营部)$/.test(name);
  }
  function skusFrom(root) {
    const model = root?.skuModel;
    const map = model?.skuInfoMap || model?.skuMap;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map).map(([key, sku]) => ({
      id: value(sku?.skuId || sku?.specId),
      specs: specValues(key),
      price: yuan(sku?.discountPrice ?? sku?.price),
      image: fullSize(sku?.imageUrl || sku?.skuImageUrl),
      stock: sku?.canBookCount == null ? '' : value(sku.canBookCount)
    })).filter(sku => sku.price);
  }
  function media(values) {
    const found = [];
    const visit = item => {
      if (typeof item === 'string') { const url = fullSize(item); if (url) found.push(url); return; }
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (item && typeof item === 'object') {
        const url = fullSize(item.fullPathImageURI || item.size310x310ImageURI || item.imageURI || item.url || item.imgUrl);
        if (url) found.push(url);
      }
    };
    visit(values);
    return [...new Set(found)];
  }
  function attributesFrom(root) {
    const raw = root?.productAttribute || root?.offerAttribute || root?.attributes;
    if (!Array.isArray(raw)) return [];
    return raw.map(item => ({
      name: value(item?.name || item?.attributeName || item?.fidName),
      value: value(typeof item?.value === 'object' ? '' : (item?.value ?? item?.valueContent))
    })).filter(item => item.name && item.value && item.name !== item.value);
  }
  function chooseTitle(jsonTitle, domTitle) {
    if (!jsonTitle) return domTitle;
    if (!domTitle) return jsonTitle;
    if (isShopName(jsonTitle) && !isShopName(domTitle)) return domTitle;
    if (domTitle.length >= jsonTitle.length + 4 && !isShopName(domTitle)) return domTitle;
    return jsonTitle;
  }
  function titleInOrderPanel() {
    const order = [...document.querySelectorAll('button,a,span,div')].find(element => !element.children.length && words(element) === '立即下单' && visible(element));
    if (!order) return '';
    let panel = order.parentElement;
    for (let depth = 0; depth < 6 && panel?.parentElement && panel.parentElement !== document.body; depth++) {
      const parent = panel.parentElement;
      const blob = words(parent);
      if (!/[¥￥]\s*\d/.test(blob) || blob.length > 8000) break;
      panel = parent;
    }
    const firstPrice = [...panel.querySelectorAll('*')].find(element => !element.children.length && /^[¥￥]/.test(words(element).replace(/\s+/g, '')));
    const texts = [];
    for (const element of panel.querySelectorAll('h1,h2,h3,div,span,p')) {
      if (!visible(element)) continue;
      if (element.children.length && !/title/i.test(String(element.className || ''))) continue;
      if (firstPrice && (element.compareDocumentPosition(firstPrice) & 4) === 0) continue;
      const title = words(element).replace(/\s+/g, ' ').trim();
      if (title.length < 8 || title.length > 120 || /[¥￥]|库存|立即下单|加采购车|收藏/.test(title) || isShopName(title)) continue;
      texts.push(title);
    }
    return texts.sort((left, right) => right.length - left.length)[0] || '';
  }
  function productTitleFromDom() {
    const ordered = titleInOrderPanel();
    if (ordered) return ordered;
    const headings = [...document.querySelectorAll('h1,h2')].map(element => words(element).replace(/\s+/g, ' ').trim()).filter(title => title && !isShopName(title) && !/请登录|验证/.test(title));
    return headings.sort((left, right) => right.length - left.length)[0] || '';
  }
  function skuName(raw) {
    return raw
      .replace(/[¥￥]\s*\d+(?:\.\d+)?/g, ' ')
      .replace(/库存\s*[:：]?\s*\d+\s*[\u4e00-\u9fa5]{0,2}/g, ' ')
      .replace(/(?:\s*[+\-−]\s*)+\d*(?:\s*[+\-−]\s*)+$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function pictureUrl(img) {
    const current = img?.currentSrc || '';
    const src = img?.getAttribute?.('src') || '';
    const lazy = [img?.getAttribute?.('data-src'), img?.getAttribute?.('data-lazy-src'), img?.getAttribute?.('data-lazyload-src'), img?.getAttribute?.('data-ks-lazyload'), img?.getAttribute?.('data-original')].find(Boolean) || '';
    const placeholder = value => !value || value.startsWith('data:') || /tps-|placeholder|blank|grey\.gif|gray\.gif|1x1|_50x50|_60x60/.test(value);
    const shown = placeholder(current) ? '' : current;
    return fullSize(placeholder(shown) ? (lazy || src) : (lazy || shown || src));
  }
  function singleSku(element) {
    const raw = words(element);
    const prices = raw.match(/[¥￥]\s*\d+(?:\.\d+)?/g) || [];
    const stocks = raw.match(/库存\s*[:：]?\s*\d+/g) || [];
    return prices.length === 1 && stocks.length === 1;
  }
  function imageNear(element) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (depth > 0 && !singleSku(node)) break;
      const image = [...node.querySelectorAll('img')].map(pictureUrl).find(Boolean);
      if (image) return image;
      const background = String(getComputedStyle(node).backgroundImage || '').match(/url\(["']?((?:https?:)?\/\/[^"')]+)["']?\)/i);
      const url = background ? fullSize(background[1]) : '';
      if (url) return url;
    }
    return '';
  }
  function skuRows() {
    const rows = [];
    const seen = new Set();
    for (const element of document.querySelectorAll('div,li,tr')) {
      if (!visible(element) || !singleSku(element)) continue;
      const raw = words(element).replace(/\s+/g, ' ').trim();
      if (raw.length < 4 || raw.length > 240) continue;
      if ([...element.querySelectorAll('div,li,tr')].some(child => child !== element && singleSku(child))) continue;
      const name = skuName(raw);
      if (name.length < 2 || seen.has(name) || /立即下单|加采购车|颜色|尺码/.test(name)) continue;
      seen.add(name);
      const price = raw.match(/[¥￥]\s*(\d+(?:\.\d+)?)/)[1];
      const stock = raw.match(/库存\s*[:：]?\s*(\d+)/)[1];
      rows.push({ id: '', specs: [name], price, image: imageNear(element), stock });
    }
    return rows;
  }
  function specLabel(element) {
    const text = words(element).replace(/\s+/g, '');
    const alt = `${element.getAttribute?.('alt') || ''}${element.getAttribute?.('aria-label') || ''}${element.getAttribute?.('title') || ''}`.replace(/\s+/g, '');
    return text === '参数' || alt === '参数';
  }
  function imageInCell(cell) {
    if (!cell) return '';
    const imgs = cell.tagName === 'IMG' ? [cell] : [...cell.querySelectorAll('img')];
    const pictured = imgs.map(pictureUrl).find(Boolean);
    if (pictured) return pictured;
    const inline = cell.getAttribute?.('style') || '';
    let computed = '';
    try { computed = getComputedStyle(cell).backgroundImage || ''; } catch { computed = ''; }
    const match = `${inline} ${computed}`.match(/url\(["']?((?:https?:)?\/\/[^"')]+)["']?\)/i);
    return match ? fullSize(match[1]) : '';
  }
  function thumbColumn() {
    const labels = [...document.querySelectorAll('div,span,li,a,button,p,img')].filter(element => present(element) && specLabel(element) && ![...element.children].some(specLabel));
    for (const label of labels) {
      let item = label;
      for (let depth = 0; item?.parentElement && depth < 6; depth++) {
        if (item.parentElement.children.length >= 3) break;
        item = item.parentElement;
      }
      const parent = item?.parentElement;
      if (!parent) continue;
      const children = [...parent.children];
      const index = children.indexOf(item);
      if (index < 0) continue;
      const before = children.slice(0, index).map(imageInCell).filter(Boolean);
      const after = children.slice(index + 1).map(imageInCell).filter(Boolean);
      if (before.length && after.length) return { root: parent, before, after };
    }
    return null;
  }
  function skuStripImages() {
    return thumbColumn()?.after || [];
  }
  function looseThumbList() {
    if (thumbColumn()) return false;
    for (const element of document.querySelectorAll('div,ul,ol')) {
      const count = element.children.length;
      if (count < 5 || count > 30) continue;
      const pictured = [...element.children].filter(imageInCell).length;
      if (pictured >= 4) return true;
    }
    return false;
  }
  function assignStripImages(skus) {
    const strip = skuStripImages();
    const rows = skuRows();
    const ordered = strip.length && rows.length ? rows.map(row => {
      const donor = skus.find(sku => (sku.specs || []).join('\u001f') === (row.specs || []).join('\u001f'));
      return donor ? { ...donor, specs: row.specs, price: row.price || donor.price, stock: row.stock || donor.stock, image: row.image || donor.image } : row;
    }) : skus;
    if (!strip.length) return ordered.map(sku => ({ ...sku, image: fullSize(sku.image) }));
    return ordered.map((sku, index) => ({ ...sku, image: fullSize(strip[index] || sku.image) }));
  }
  function detailHeading() {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,div,span,a,li,button')].filter(element => visible(element) && words(element).replace(/\s+/g, '') === '商品详情');
    return headings.find(element => /^H[1-4]$/.test(element.tagName)) || headings.at(-1);
  }
  let detailRevealPasses = 0;
  function revealDetail(heading) {
    if (!heading) return;
    detailRevealPasses += 1;
    const clickable = heading.closest('a,button,[role="tab"],li') || heading;
    const href = clickable.getAttribute?.('href') || '';
    if (detailRevealPasses === 1 && (!href || href.startsWith('#'))) { try { clickable.click(); } catch { /* A static document has nothing to open. */ } }
    try {
      const top = heading.getBoundingClientRect().top + (window.scrollY || 0);
      window.scrollTo(0, top + Math.min(detailRevealPasses, 6) * 700);
    } catch { /* Layout is unavailable in tests. */ }
  }
  function descriptionDocumentUrl(input) {
    const raw = value(input).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
    if (!raw) return '';
    let url;
    try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, location.href); }
    catch { return ''; }
    if (url.protocol !== 'https:') return '';
    const host = url.hostname;
    const allowed = host === 'alicdn.com' || host.endsWith('.alicdn.com') || host === 'tmall.com' || host.endsWith('.tmall.com') || host === '1688.com' || host.endsWith('.1688.com');
    if (!allowed || /\/offer\/\d+\.html?$/i.test(url.pathname) || /\.(?:jpg|jpeg|png|webp|gif)(?:$|\?)/i.test(url.pathname)) return '';
    return url.href;
  }
  function descriptionSources() {
    const urls = [];
    const push = (raw, requireHint) => {
      const url = descriptionDocumentUrl(raw);
      if (!url || (requireHint && !/desc|icoss|1688offer|lazyload/i.test(url))) return;
      urls.push(url);
    };
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (!/detailUrl|descUrl|descriptionUrl/i.test(text)) continue;
      for (const match of text.matchAll(/"(?:detailUrl|descUrl|descriptionUrl)"\s*:\s*"((?:\\.|[^"\\])*)"/gi)) push(match[1], false);
    }
    for (const frame of document.querySelectorAll('iframe')) push(frame.getAttribute('src') || frame.getAttribute('data-src') || frame.getAttribute('data-lazy-src'), true);
    return [...new Set(urls)].slice(0, 5);
  }
  function keepDetailImage(url) {
    if (!url || /tps-|\/icon|avatar|logo|sprite|_20x20|_30x30|-rate(?:[_.])|22185873824_536529798\.jpg/i.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      return host === 'alicdn.com' || host.endsWith('.alicdn.com');
    } catch { return false; }
  }
  function detailImagesFromDom() {
    const column = thumbColumn();
    const heading = detailHeading();
    revealDetail(heading);
    const found = [];
    const push = image => {
      if (column?.root && (image === column.root || column.root.contains(image))) return;
      let node = image;
      for (let depth=0; node?.nodeType === 1; depth++, node = node.parentElement) {
        if ((depth<6 && singleSku(node)) || /review|feedback|rate-list|recommend|related|avatar|loading|placeholder/i.test(node.id+' '+node.className)) return;
      }
      const url = pictureUrl(image);
      if (keepDetailImage(url)) found.push(url);
    };
    if (heading) {
      const stop = [...document.querySelectorAll('h1,h2,h3,div,span')].find(element => {
        if (element === heading || !visible(element)) return false;
        const label = words(element).replace(/\s+/g, '');
        if (label.length > 12 || (heading.compareDocumentPosition(element) & 4) === 0) return false;
        return /看了又看|热门推荐|同类推荐|店铺推荐|你可能喜欢/.test(label);
      });
      for (const image of document.querySelectorAll('img')) {
        if ((heading.compareDocumentPosition(image) & 4) === 0) continue;
        if (stop && ((stop.compareDocumentPosition(image) & 4) || stop.contains(image))) continue;
        push(image);
      }
    }
    for (const frame of document.querySelectorAll('iframe')) {
      const src = frame.getAttribute('src') || frame.getAttribute('data-src') || frame.getAttribute('data-lazy-src');
      if (!descriptionDocumentUrl(src) || !/desc|icoss|1688offer|lazyload/i.test((src || '')+' '+frame.id+' '+frame.className)) continue;
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        for (const image of doc.querySelectorAll('img')) push(image);
      } catch { /* A description frame from another site cannot be read here. */ }
    }
    return [...new Set(found)];
  }
  function videoFromDom() {
    for (const element of document.querySelectorAll('video, source')) {
      const url = httpsUrl(element.currentSrc || element.getAttribute('src') || element.getAttribute('data-src'));
      if (url) return url;
    }
    return '';
  }
  function skusFromLive(live) {
    if (!Array.isArray(live?.skus)) return [];
    return live.skus.map(sku => ({
      id: value(sku?.skuId || sku?.id),
      specs: specValues(sku?.key || sku?.name || ''),
      price: yuan(sku?.price),
      image: fullSize(sku?.image),
      stock: sku?.stock == null ? '' : value(sku.stock)
    })).filter(sku => sku.price);
  }
  function mergeSkus(groups) {
    const lists = groups.filter(group => group.length);
    if (!lists.length) return [];
    const pictured = group => group.filter(sku => sku.image).length;
    let primary = lists[0];
    for (const group of lists.slice(1)) {
      if (group.length > primary.length || (group.length === primary.length && pictured(group) > pictured(primary))) primary = group;
    }
    const donors = lists.filter(group => group !== primary).flat();
    return primary.map(sku => {
      if (sku.image) return sku;
      const name = (sku.specs || []).join('\u001f');
      const donor = donors.find(item => item.image && (item.specs || []).join('\u001f') === name);
      return donor ? { ...sku, image: donor.image } : sku;
    });
  }
  function detailSnapshot(pageGoods) {
    const url = location.href;
    const goodsId = url.match(/\/offer\/(\d+)(?:\.html)?/)?.[1] || '';
    const reason = blockedReason();
    if (reason) return { url, goodsId, blocked: true, reason, ready: false, source: 'blocked', detail: null };
    const live = pageGoods && typeof pageGoods === 'object' ? pageGoods : null;
    const root = offerRoot(initData(), goodsId) || {};
    const jsonTitle = value(live?.title || root.subject || root.title);
    const domTitle = productTitleFromDom();
    const title = chooseTitle(jsonTitle, domTitle);
    const gallery = media(live?.images || root.imageList || root.offerImgList || root.images);
    const domGallery = [...document.querySelectorAll('img')].filter(image => visible(image) && (document.hidden || image.getBoundingClientRect().width >= 120)).map(image => httpsUrl(image.currentSrc || image.getAttribute('src'))).filter(Boolean);
    const skus = assignStripImages(mergeSkus([skusFromLive(live), skusFrom(root), skuRows()]));
    const skuImages = new Set(skus.map(sku => sku.image).filter(Boolean));
    const descriptionUrls = [...new Set([...(Array.isArray(live?.detailUrls) ? live.detailUrls : []), live?.detailUrl, ...descriptionSources()].map(descriptionDocumentUrl).filter(Boolean))].slice(0, 5);
    const column = thumbColumn();
    const reserved = new Set([...(column?.before || []), ...(column?.after || []), ...skus.map(sku => sku.image)].map(fullSize).filter(Boolean));
    const detailImages = [...new Set([...media(root.detailImages || root.descImages), ...detailImagesFromDom()])].filter(url => keepDetailImage(url) && !reserved.has(fullSize(url)));
    const detailImageSet = new Set(detailImages);
    const galleryImages = [...new Set([...(gallery.length ? gallery : domGallery.filter(image => !skuImages.has(image) && !detailImageSet.has(image))), ...gallery])];
    const videoUrl = httpsUrl(live?.videoUrl || root.videoUrl || root.video?.videoUrl || root.video?.playUrl) || videoFromDom();
    const detail = {
      title,
      price: yuan(live?.price || root.price),
      galleryImages,
      descriptionText: value(root.description || root.offerDesc),
      detailImages,
      category: value(root.categoryName || root.catName),
      attributes: attributesFrom(root),
      videoUrl,
      certificateImages: [],
      sizeChartImages: [],
      specNames: skus[0]?.specs?.length ? ['规格'] : [],
      skus,
      detailStatus: title && (skus.length || galleryImages.length) ? 'done' : 'partial',
      detailNote: title && (skus.length || videoUrl) ? '' : '仅通过页面可见内容采集，部分详情可能缺失'
    };
    const ready = Boolean(title && !isShopName(title) && (detail.galleryImages.length || detail.skus.length || detail.attributes.length || detail.detailImages.length || detail.videoUrl));
    const skuPending = detail.skus.length > 0 && !column && looseThumbList();
    return { url, goodsId, blocked: false, reason: '', ready, detailPending: detail.detailImages.length === 0, skuPending, descriptionUrls, source: jsonTitle || root.skuModel || live?.skus?.length ? 'json' : 'dom', detail };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'PDD_DETAIL_SNAPSHOT') respond(detailSnapshot(message.pageGoods));
  });
})();
