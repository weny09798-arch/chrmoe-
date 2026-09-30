(() => {
  if (globalThis.__aliCollectorInstalled) return;
  globalThis.__aliCollectorInstalled = true;

  function shown(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    return true;
  }
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const ANCHOR_SEL = 'a[href*="detail.1688.com/offer/"], a[href*="detail.m.1688.com"], a[href*="m.1688.com/offer"], [data-offer-id], [data-offerid]';
  function imageUrl(img) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '';
    const raw = /tps-|placeholder|blank|grey\.gif|gray\.gif|1x1/.test(src) && lazy ? lazy : (src || lazy);
    try { const url = new URL(raw, location.href); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
  }
  function offerIdFromHref(href) {
    try {
      const url = new URL(href, location.href);
      if (!/(^|\.)1688\.com$/.test(url.hostname)) return '';
      const queryId = url.searchParams.get('offerId') || '';
      if (/^\d+$/.test(queryId)) return queryId;
      return url.pathname.match(/\/offer\/(\d+)(?:\.html)?/)?.[1] || '';
    } catch { return ''; }
  }
  function offerIdFrom(el) {
    const attr = el.getAttribute?.('data-offer-id') || el.getAttribute?.('data-offerid') || '';
    if (/^\d{5,}$/.test(attr)) return attr;
    return offerIdFromHref(el.getAttribute?.('href') || '');
  }
  function cardForAnchor(anchor) {
    let card = anchor;
    for (let depth = 0; depth < 15; depth++) {
      const parent = card.parentElement;
      if (!parent || parent === document.body) break;
      const ids = new Set();
      for (const node of parent.querySelectorAll(ANCHOR_SEL)) {
        const id = offerIdFrom(node);
        if (id) ids.add(id);
      }
      if (ids.size > 1) return card;
      card = parent;
    }
    return card;
  }
  function productImage(card, anchor) {
    const images = [anchor, ...card.querySelectorAll('img')].flatMap(node => node.tagName === 'IMG' ? [node] : [...node.querySelectorAll('img')]);
    for (const img of images) {
      const url = imageUrl(img);
      if (!url || !shown(img)) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch { continue; }
      if (!(host === 'alicdn.com' || host.endsWith('.alicdn.com'))) continue;
      const width = Number(img.getAttribute('width')) || 0;
      const height = Number(img.getAttribute('height')) || 0;
      if ((width && width < 40) || (height && height < 40)) continue;
      return { img, url };
    }
    for (const node of [anchor, ...card.querySelectorAll('div,a,span')].slice(0, 40)) {
      const match = String(getComputedStyle(node).backgroundImage || '').match(/url\(["']?(https:[^"')]+)["']?\)/i);
      if (!match) continue;
      try {
        const url = new URL(match[1]);
        if (url.hostname === 'alicdn.com' || url.hostname.endsWith('.alicdn.com')) return { img: node, url: url.href };
      } catch { /* A broken background image is ignored. */ }
    }
    return null;
  }
  function cleanTitle(value) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if (title.length < 2 || !/[\p{L}]/u.test(title) || /[¥￥]/.test(title)) return '';
    return title.slice(0, 300);
  }
  function searchKeyword() {
    const raw = String(location.href).match(/[?&]keywords=([^&#]*)/)?.[1] || '';
    const source = raw.replace(/\+/g, ' ');
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
    const data = new Uint8Array(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { return new TextDecoder('gbk').decode(data); }
  }
  function relatedToSearch(title) {
    const query = searchKeyword();
    const letters = [...query.normalize('NFKC').toLowerCase()].filter(char => /\p{L}/u.test(char));
    const signals = letters.length ? letters : [...query.normalize('NFKC')].filter(char => /\p{N}/u.test(char));
    const candidate = new Set([...title.normalize('NFKC').toLowerCase()]);
    return signals.some(char => candidate.has(char));
  }
  function titleFor(card, anchor, img) {
    const candidates = [];
    for (const node of card.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="Title"]')) candidates.push(node.getAttribute('title'), text(node));
    candidates.push(anchor.getAttribute('title'), img?.getAttribute('alt'));
    return candidates.map(cleanTitle).find(title => title && relatedToSearch(title)) || '';
  }
  function isolatedPrice(card) {
    const symbol = [], bare = [];
    for (const el of card.querySelectorAll('*')) {
      if (el.children.length || !shown(el)) continue;
      const raw = text(el).replace(/\s+/g, '');
      if (!raw || raw.length > 24) continue;
      const withMark = raw.match(/^[¥￥](\d+(?:\.\d{1,2})?)(?:起)?$/);
      if (withMark) { symbol.push(withMark[1]); continue; }
      const plain = raw.match(/^(\d+\.\d{1,2})(?:起)?$/);
      if (plain) bare.push(plain[1]);
    }
    const chosen = symbol.length ? symbol : bare;
    const unique = [...new Set(chosen)];
    if (unique.length !== 1) return '';
    const [whole, frac = '00'] = unique[0].split('.');
    return `¥${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
  }
  function priceText(card) {
    return isolatedPrice(card) || text(card);
  }
  function cardsWithElements() {
    const found = [], seen = new Set();
    for (const anchor of document.querySelectorAll(ANCHOR_SEL)) {
      if (!shown(anchor)) continue;
      const id = offerIdFrom(anchor);
      if (!id || seen.has(id)) continue;
      const el = cardForAnchor(anchor);
      const picture = productImage(el, anchor);
      const title = titleFor(el, anchor, picture?.img);
      const price = priceText(el);
      seen.add(id);
      found.push({ el, anchor, card: { id, key: id, image: picture?.url || '', title, priceText: price, url: `https://detail.1688.com/offer/${id}.html` } });
    }
    return found;
  }
  function scrollRoot() {
    const seed = cardsWithElements()[0]?.el;
    for (let node = seed; node && node !== document.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement || document.documentElement;
  }
  function snapshot() {
    const cards = cardsWithElements().map(item => item.card);
    const phrases = [...document.querySelectorAll('div,p,span,h1,h2,button')].filter(el => !el.children.length && shown(el)).map(text);
    const verify = phrases.find(phrase => phrase.length < 150 && /请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|验证码/.test(phrase));
    const login = /login\.1688\.com$/.test(location.hostname) || /login\.taobao\.com$/.test(location.hostname) || (!cards.length && phrases.some(phrase => /请登录|登录后查看|手机号登录/.test(phrase)));
    const root = scrollRoot();
    return {
      url: location.href, cards, blocked: Boolean(verify || login), reason: verify || (login ? '请在采集页登录 1688' : ''),
      end: phrases.some(phrase => /没有找到与|没有找到相关|暂无相关商品|没有更多商品|抱歉，没有找到/.test(phrase)),
      position: root.scrollTop || 0
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    try {
      if (message.type === 'PDD_SNAPSHOT') respond(snapshot());
      else if (message.type === 'PDD_SCROLL') {
        const root = scrollRoot();
        if (typeof message.position === 'number') root.scrollTop = Math.max(0, message.position);
        else root.scrollTop += Math.max(350, root.clientHeight * 0.8);
        respond({ ok: true });
      } else if (message.type === 'PDD_OPEN_CARD') {
        const result = cardsWithElements().find(item => item.card.key === message.key);
        if (!result) respond({ error: '商品卡片已变化，请重试' });
        else {
          const target = result.anchor?.tagName === 'A' ? result.anchor : (result.el.querySelector('a[href*="1688.com"]') || result.el.querySelector('img'));
          respond({ ok: true, position: scrollRoot().scrollTop });
          setTimeout(() => target.click(), 50);
        }
      }
    } catch (error) { respond({ error: error.message }); }
    return true;
  });
})();
