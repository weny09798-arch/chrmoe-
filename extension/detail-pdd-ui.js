(() => {
  if (globalThis.__pddDetailUI) return;
  const text = node => String(node?.innerText || node?.textContent || '').trim();
  const unique = items => [...new Set(items.filter(Boolean))];
  function mediaUrl(raw) {
    try {
      if (!raw) return '';
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:' || /^(?:avatar\d*|commimg|promotion|funimg[^.]*)\./i.test(url.hostname) || /\/a\/coupon\//i.test(url.pathname)) return '';
      if (/imageMogr2|imageView2/.test(url.search)) url.search = '';
      return url.href;
    } catch { return ''; }
  }
  function current(node, root, id) {
    for (let at = node; at && at !== root.parentElement; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (at.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
      if (at.getAttribute?.('data-goods-id') && at.getAttribute('data-goods-id') !== id) return false;
      if (at.tagName === 'ASIDE' || /recommend|suggest|related|review|avatar|service/i.test(`${at.id || ''} ${at.className || ''} ${at.getAttribute?.('data-role') || ''}`)) return false;
    }
    return true;
  }
  const imageUrl = img => mediaUrl(img?.getAttribute('data-src') || img?.getAttribute('data-original') || img?.currentSrc || img?.getAttribute('src'));
  function images(root, id) {
    const result = { galleryImages: [], detailImages: [], certificateImages: [], sizeChartImages: [] };
    const nodes = [...root.querySelectorAll('*')];
    const detailStart = nodes.findIndex(n => /^(商品详情|图文详情)$/.test(text(n)) && !n.children.length && current(n, root, id));
    const detailEnd = nodes.findIndex((n, index) => index > detailStart && /^(看了又看|推荐商品|猜你喜欢)$/.test(text(n)) && !n.children.length);
    for (const img of root.querySelectorAll('img')) {
      if (!current(img, root, id)) continue;
      if (detailEnd >= 0 && nodes.indexOf(img) >= detailEnd) continue;
      const url = imageUrl(img); if (!url) continue;
      let role = '';
      const label = img.getAttribute('aria-label') || img.getAttribute('alt') || '';
      if (label === '商品大图') role = 'galleryImages';
      if (label === '查看图片' && detailStart >= 0 && nodes.indexOf(img) > detailStart && (detailEnd < 0 || nodes.indexOf(img) < detailEnd)) role = 'detailImages';
      if (!role) for (let at = img.parentElement; at && at !== root; at = at.parentElement) {
        const kind = `${at.getAttribute('data-role') || ''} ${at.id || ''}`;
        if (/certificate|证书/.test(kind)) { role = 'certificateImages'; break; }
        if (/size.chart/.test(kind)) { role = 'sizeChartImages'; break; }
        if (/^(?:\s*)(?:detail|description)(?:\s*)$/.test(kind)) { role = 'detailImages'; break; }
        if (/gallery|轮播|主图/.test(kind)) { role = 'galleryImages'; break; }
      }
      if (role) result[role].push(url);
    }
    for (const key of Object.keys(result)) result[key] = unique(result[key]);
    return result;
  }
  function attributes(root, id) {
    const found = [];
    const heading = [...root.querySelectorAll('p,h2,h3,span')].find(n => text(n) === '商品详情' && current(n, root, id));
    if (heading) for (const pair of heading.parentElement.querySelectorAll('[aria-label]')) {
      if (!current(pair, root, id) || pair.children.length !== 2) continue;
      const [name, val] = [...pair.children].map(text);
      if (name && val && name.length <= 30 && val.length <= 300 && pair.getAttribute('aria-label').replace(/\s/g, '') === (name + val).replace(/\s/g, '')) found.push({ name, value: val });
    }
    return found;
  }
  let state;
  function currentDialog(id) {
    return [...document.querySelectorAll('[role="dialog"]')].find(node => {
      const box = node.getBoundingClientRect();
      return node.querySelector('.sku-specs-key') && current(node, document.body, id)
        && !node.closest('[aria-hidden="true"],[hidden]') && box.width > 0 && box.height > 0;
    });
  }
  function skuUI(root, id, hasStructuredSkus) {
    if (!state || state.id !== id) state = { id, opened: false, targets: null, index: 0, rows: [], stable: '', retries: 0, finished: false, unconfirmed: 0, awaitingPrice: false, beforePrice: '', beforeImage: '' };
    if (hasStructuredSkus) return { skus: [], specNames: [], pending: false };
    let dialog = currentDialog(id);
    if (!dialog && !state.opened) {
      const entry = [...root.querySelectorAll('[data-action="open-sku"],.yK39frdi[role="button"]')]
        .find(n => current(n, root, id) && (/发起拼单/.test(text(n)) || n.getAttribute('data-action') === 'open-sku'));
      if (entry && /^\/goods\.html$/.test(new URL(location.href).pathname)) { state.opened = true; entry.click(); }
      dialog = currentDialog(id);
    }
    const result = () => ({ skus: state.rows, specNames: state.names || [], pending: !state.finished, unconfirmed: state.unconfirmed });
    if (!dialog || state.finished) return result();
    const groups = [...dialog.querySelectorAll('.sku-specs-key')].map(label => ({
      name: text(label), options: [...label.parentElement.querySelectorAll('[role="button"]')].filter(n => text(n) && n.getAttribute('aria-disabled') !== 'true' && !n.hasAttribute('disabled') && !/disabled/i.test(n.className))
    }));
    if (!groups.length || groups.length > 2 || groups.some(g => !g.options.length)) return result();
    if (!state.targets) {
      state.names = groups.map(g => g.name);
      state.targets = groups.reduce((all, g) => all.flatMap(row => g.options.map(n => [...row, text(n)])), [[]]).slice(0, 1000);
    }
    const target = state.targets[state.index];
    if (!target) { state.finished = true; return result(); }
    const selected = node => node.getAttribute('aria-pressed') === 'true' || node.classList.contains('hr353bdX');
    const readPrice = () => text(dialog.querySelector('[data-sku-price],.ujEqGzEB')).match(/^[¥￥]\s*(\d+(?:\.\d+)?)/)?.[1] || '';
    const oldPrice = readPrice();
    const oldImage = imageUrl(dialog.querySelector('img[aria-label="点击查看大图"]'));
    if (!state.awaitingPrice) {
      const next = groups.findIndex((g, index) => !g.options.some(n => text(n) === target[index] && selected(n)));
      if (next >= 0) {
        const option = groups[next].options.find(n => text(n) === target[next]);
        if (option) {
          state.choice = groups.map(g => text(g.options.find(selected)));
          state.choice[next] = target[next];
          state.beforePrice = oldPrice; state.beforeImage = oldImage;
          state.awaitingPrice = true; state.stable = ''; state.retries = 0;
          option.click(); return result();
        }
      }
    }
    const summary = text(dialog.querySelector('[data-sku-selected],.Mbx2m60G'));
    const price = readPrice();
    const image = imageUrl(dialog.querySelector('img[aria-label="点击查看大图"]'));
    const matches = target.every((val, i) => groups[i].options.some(n => text(n) === val && selected(n))) && target.every(val => summary.includes(val));
    const signature = JSON.stringify([target, price, image]);
    // Selection labels can update before the price. A stable old price is not
    // evidence of the new SKU price; prefer structured SKUs when prices repeat.
    const freshPrice = !state.awaitingPrice || Number(price) !== Number(state.beforePrice);
    const choiceMatches = !state.awaitingPrice || state.choice.every((val, i) => val && groups[i].options.some(n => text(n) === val && selected(n)) && summary.includes(val));
    const loading = Boolean(dialog.querySelector('[aria-busy="true"],[data-loading="true"]'));
    if (choiceMatches && freshPrice && Number(price) > 0 && !loading && state.stable === signature) {
      if (!matches) { state.awaitingPrice = false; state.stable = ''; state.retries = 0; return result(); }
      const confirmedImage = state.awaitingPrice && image === state.beforeImage ? '' : image;
      state.rows.push({ id: '', specs: target, price, image: confirmedImage, stock: '', weightKg: '', sizeCm: '' });
      state.index++; state.stable = ''; state.retries = 0;
      state.awaitingPrice = false;
      if (state.index >= state.targets.length) state.finished = true;
    } else {
      state.stable = signature;
      // Stop this fallback when an update cannot be confirmed. Moving to another
      // target could otherwise reuse the same unresolved price for a new row.
      if (++state.retries >= 10) { state.unconfirmed = state.targets.length - state.index; state.finished = true; }
    }
    return result();
  }
  let mediaState;
  globalThis.__pddDetailUI = {
    mediaUrl,
    read(root, id, hasStructuredSkus) {
      const media = images(root, id);
      const attrs = attributes(root, id);
      if (!mediaState || mediaState.id !== id) mediaState = { id, key: '', stable: 0, scans: 0 };
      const key = JSON.stringify(media.detailImages);
      mediaState.stable = key === mediaState.key ? mediaState.stable + 1 : 1;
      mediaState.key = key; mediaState.scans++;
      const detailPending = !media.detailImages.length || mediaState.stable < 5;
      const sku = !detailPending || mediaState.scans >= 10 || hasStructuredSkus
        ? skuUI(root, id, hasStructuredSkus) : { skus: [], specNames: [], pending: true, unconfirmed: 0 };
      // Check the current detail tail while waiting for the address list to settle.
      if (detailPending && mediaState.scans % 2 === 0 && !currentDialog(id)) {
        const heading = [...root.querySelectorAll('p,h2,h3,span')].find(n => text(n) === '商品详情');
        const last = [...root.querySelectorAll('img[aria-label="查看图片"]')].filter(n => current(n, root, id)).at(-1);
        (last || heading)?.scrollIntoView?.({ block: 'end', behavior: 'instant' });
      }
      return { ...media, attributes: attrs, ...sku, detailPending };
    }
  };
})();
