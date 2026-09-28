(() => {
  if (globalThis.__pddCollectorInstalled) return;
  globalThis.__pddCollectorInstalled = true;

  function visible(el) {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      if (p.hidden || p.getAttribute('aria-hidden') === 'true') return false;
      const css = getComputedStyle(p);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  const text = el => (el?.innerText || el?.textContent || '').trim();
  function imageUrl(img) {
    const raw = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
    try { const url = new URL(raw, location.href); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
  }
  function largeImage(img) {
    if (!visible(img) || !imageUrl(img)) return false;
    const rect = img.getBoundingClientRect();
    const w = Number(img.getAttribute('width')) || rect.width, h = Number(img.getAttribute('height')) || rect.height;
    return w >= 70 && h >= 70;
  }
  function goodsId(el) {
    for (const node of [el, ...el.querySelectorAll('a[href], [data-goods-id]')]) {
      const attr = node.getAttribute('data-goods-id');
      if (/^\d+$/.test(attr || '')) return attr;
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        const id = url.searchParams.get('goods_id');
        if (url.hostname === 'mobile.pinduoduo.com' && /^\d+$/.test(id || '')) return id;
      } catch { /* An unrelated link is not a product. */ }
    }
    return '';
  }
  function cardFor(img) {
    for (let el = img.parentElement, depth = 0; el && el !== document.body && depth < 7; el = el.parentElement, depth++) {
      if ([...el.querySelectorAll('img')].filter(largeImage).length > 1) return null;
      const value = text(el);
      if (value.length > 1600) return null;
      if (/[¥￥]\s*\d/.test(value)) return el;
    }
    return null;
  }
  const badgePrefix = /^(?:已(?:缴纳|交纳|交付)保证金|好评(?:超|率)?\d+(?:\.\d+)?%?同款|\d+(?:\.\d+)?(?:万|千)?\+?人好评|[\p{L}]{1,12}(?:地区|地方|省|市)?(?:不配送|不可配送|不支持配送)|未发货秒退|(?:券后|立减|补贴|满减)[¥￥]?\d+(?:\.\d+)?(?:元|折)?|(?:本店)?已拼\d+(?:\.\d+)?(?:万|千)?\+?(?:件|人)?|包邮|旗舰店|正品险|退货包运费)[\s·|]*/u;
  function cleanTitle(value) {
    let title = String(value || '').trim();
    while (badgePrefix.test(title)) title = title.replace(badgePrefix, '').trim();
    if (title.length < 2 || !/[\p{L}]/u.test(title) || /[¥￥]|^商品(?:主图|图片|图)$/.test(title)) return '';
    return title.slice(0, 300);
  }
  const ownText = el => [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim();
  function relatedToSearch(title) {
    const query = new URL(location.href).searchParams.get('search_key') || '';
    const letters = [...query.normalize('NFKC').toLowerCase()].filter(char => /\p{L}/u.test(char));
    const signals = letters.length ? letters : [...query.normalize('NFKC')].filter(char => /\p{N}/u.test(char));
    const candidate = new Set([...title.normalize('NFKC').toLowerCase()]);
    return signals.some(char => candidate.has(char));
  }
  function titleFor(card, img) {
    const explicit = card.querySelector('h1,h2,h3,h4,[data-goods-name]');
    const candidates = [
      ...(explicit ? [ownText(explicit), ...[...explicit.querySelectorAll('span,div,p')].filter(el => !el.children.length).map(text)] : []),
      ...[...card.querySelectorAll('span,div,p')].filter(el => !el.children.length).map(text),
      img.getAttribute('alt'), ownText(card)
    ];
    return candidates.map(cleanTitle).find(title => title && relatedToSearch(title)) || '';
  }
  function cardsWithElements() {
    const found = [], seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      if (!largeImage(img)) continue;
      const el = cardFor(img);
      if (!el || !visible(el)) continue;
      const id = goodsId(el), image = imageUrl(img), title = titleFor(el, img);
      const priceText = text(el), key = id || `${image}|${title}|${priceText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ el, card: { id, key, image, title, priceText, url: id ? `https://mobile.pinduoduo.com/goods.html?goods_id=${id}` : '' } });
    }
    return found;
  }
  function scrollRoot() {
    const img = [...document.querySelectorAll('img')].find(largeImage);
    for (let p = img?.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
    }
    return document.scrollingElement || document.documentElement;
  }
  function snapshot() {
    const cards = cardsWithElements().map(x => x.card);
    const phrases = [...document.querySelectorAll('div,p,span,h1,h2')].filter(el => !el.children.length && visible(el)).map(text);
    const verify = phrases.find(s => s.length < 150 && /请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|商品已售罄|推荐以下相似商品|当前访问人数较多/.test(s));
    const login = /\/(?:login|login_phone|login_password)\b/.test(location.pathname) || (!cards.length && phrases.some(s => /手机号登录|请先登录|登录后查看/.test(s)));
    const root = scrollRoot();
    return {
      url: location.href, cards, blocked: Boolean(verify || login), reason: verify || (login ? '请在采集页登录拼多多' : ''),
      end: phrases.some(s => /^(?:没有更多(?:商品|了)?|已到底(?:了)?|暂无(?:相关)?商品|没有找到相关商品|没有搜索到相关商品)[！!。\s]*$/.test(s)),
      position: root.scrollTop || 0
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    try {
      if (message.type === 'PDD_SNAPSHOT') respond(snapshot());
      else if (message.type === 'PDD_SCROLL') {
        const root = scrollRoot();
        if (typeof message.position === 'number') root.scrollTop = Math.max(0, message.position);
        else root.scrollTop += Math.max(350, root.clientHeight * .8);
        respond({ ok: true });
      } else if (message.type === 'PDD_OPEN_CARD') {
        const result = cardsWithElements().find(x => x.card.key === message.key);
        if (!result) respond({ error: '商品卡片已变化，请重试' });
        else {
          // Only a product card previously returned by the reader can be clicked.
          const target = result.el.querySelector('img');
          respond({ ok: true, position: scrollRoot().scrollTop });
          setTimeout(() => target.click(), 50);
        }
      }
    } catch (error) { respond({ error: error.message }); }
  });
})();
