import { fingerprint } from './fingerprint.mjs';
import { normalizeDetail } from './detail.mjs';

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function productId(raw) {
  try {
    const url = new URL(raw);
    const id = url.searchParams.get('goods_id');
    return url.protocol === 'https:' && url.hostname === 'mobile.pinduoduo.com' && /^\d+$/.test(id || '') ? id : '';
  } catch { return ''; }
}
export function searchUrl(keyword) {
  const url = new URL('https://mobile.pinduoduo.com/search_result.html');
  url.searchParams.set('search_key', keyword);
  return url.href;
}
function isSearch(url, keyword) {
  try { const u = new URL(url); return u.origin === 'https://mobile.pinduoduo.com' && /\/search_result\.html$/.test(u.pathname) && u.searchParams.get('search_key') === keyword; } catch { return false; }
}
function blocked(message, permissionOrigin = '') { return Object.assign(new Error(message), { blocked: true, permissionOrigin }); }

export function browserPorts({ save, update }) {
  let tabId, task, detailTabId;
  const imageCache = new Map();
  async function closeDetail() {
    const id = detailTabId;
    detailTabId = undefined;
    if (id !== undefined) await chrome.tabs.remove(id).catch(() => {});
  }
  async function enrich(item) {
    const id = typeof item?.id === 'string' ? item.id : Number.isSafeInteger(item?.id) ? String(item.id) : '';
    if (!/^\d+$/.test(id)) throw new Error('无效商品 ID');
    const detailUrl = `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`;
    try {
      const tab = await chrome.tabs.create({ url: detailUrl, active: false });
      detailTabId = tab.id;
      let ready = false;
      for (let i = 0; i < 40; i++) {
        if ((await chrome.tabs.get(detailTabId)).status === 'complete') { ready = true; break; }
        await wait(300);
      }
      if (!ready) throw new Error('商品详情加载超时');
      await chrome.scripting.executeScript({ target: { tabId: detailTabId }, files: ['detail-content.js'] });
      for (let i = 0; i < 40; i++) {
        const snapshot = await chrome.tabs.sendMessage(detailTabId, { type: 'PDD_DETAIL_SNAPSHOT' });
        if (!snapshot) throw new Error('商品详情页未响应');
        if (snapshot.goodsId !== id) throw new Error('商品详情 ID 不匹配');
        if (snapshot.blocked) throw blocked(snapshot.reason || '商品详情页已阻断');
        if (snapshot.error) throw new Error(snapshot.error);
        const detail = snapshot.detail;
        if (detail && (detail.title || ['galleryImages', 'detailImages', 'certificateImages', 'sizeChartImages', 'attributes', 'skus'].some(key => detail[key]?.length))) {
          return normalizeDetail(detail, item);
        }
        if (i < 39) await wait(300);
      }
      throw new Error('商品详情加载超时');
    } finally { await closeDetail(); }
  }
  async function ready() {
    for (let i = 0; i < 40; i++) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
      await wait(300);
    }
    throw new Error('采集页加载超时，请检查网络后重新生成');
  }
  async function message(data) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const response = await chrome.tabs.sendMessage(tabId, data);
    if (!response) throw new Error('采集页未响应');
    if (response.error) throw new Error(response.error);
    return response;
  }
  async function read(job) {
    await ready();
    let page;
    try { page = await message({ type: 'PDD_SNAPSHOT' }); }
    catch (error) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url?.startsWith('https://mobile.pinduoduo.com/')) throw blocked('采集页离开拼多多，请返回搜索页面后继续');
      throw error;
    }
    if (page.blocked) return page;
    if (!isSearch(page.url, job.keyword)) throw blocked(`采集页已离开“${job.keyword}”的搜索结果，请返回后继续`);
    return page;
  }
  async function hash(rawUrl) {
    if (imageCache.has(rawUrl)) return imageCache.get(rawUrl);
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'pddpic.com' || url.hostname.endsWith('.pddpic.com') || url.hostname === 'mobile.pinduoduo.com')) throw new Error(`暂不支持的图片来源：${url.hostname}`);
    const origin = `${url.origin}/*`;
    if (!await chrome.permissions.contains({ origins: [origin] })) throw blocked(`需要读取 ${url.hostname} 的商品主图；点击“授权图片并继续”`, origin);
    const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
    if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('商品图片过大');
    const blob = await response.blob();
    if (blob.size > 10 * 1024 * 1024) throw new Error('商品图片过大');
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width < 40 || bitmap.height < 40) throw new Error('图片尺寸不足，无法可靠去重');
      const canvas = new OffscreenCanvas(32, 32), ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 32, 32); ctx.drawImage(bitmap, 0, 0, 32, 32);
      const value = fingerprint(ctx.getImageData(0, 0, 32, 32).data);
      if (value.spread < 8) throw new Error('主图内容过少，无法可靠去重');
      if (imageCache.size >= 400) imageCache.delete(imageCache.keys().next().value);
      imageCache.set(rawUrl, value);
      return value;
    } finally { bitmap.close(); }
  }
  async function resolve(card, page, job) {
    // Some mobile result cards have only a click handler. Read the resulting detail URL.
    const children = new Set();
    const onCreated = tab => { if (tab.openerTabId === tabId) children.add(tab.id); };
    chrome.tabs.onCreated.addListener(onCreated);
    let id = '', sameTab = false;
    try {
      await message({ type: 'PDD_OPEN_CARD', key: card.key });
      for (let i = 0; i < 32 && !id; i++) {
        await wait(250);
        for (const candidateTabId of [tabId, ...children]) {
          const tab = await chrome.tabs.get(candidateTabId).catch(() => null);
          const found = productId(tab?.url || '');
          if (found) { id = found; sameTab = candidateTabId === tabId; break; }
        }
      }
      if (!id) {
        const current = await message({ type: 'PDD_SNAPSHOT' });
        if (current.blocked) throw blocked(current.reason);
        throw Object.assign(new Error('无法从商品卡片获取详情链接；已暂停以免误操作，请联系适配页面'), { blocked: true });
      }
      if (sameTab) {
        // Browser history can return to the Pinduoduo home page after a SPA card click.
        await chrome.tabs.update(tabId, { url: searchUrl(job.keyword) });
        await wait(300); await ready();
        let restored = await read(job);
        for (let i = 0; i < 8 && !restored.cards.length; i++) { await wait(500); restored = await read(job); }
        await message({ type: 'PDD_SCROLL', position: page.position });
        await wait(500);
      }
      return { ...card, id, url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`, navigated: sameTab };
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
      for (const child of children) await chrome.tabs.remove(child).catch(() => {});
    }
  }
  return {
    async open(job, currentTask) {
      task = currentTask; tabId = task.tabId;
      let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!tab || !tab.url?.startsWith('https://mobile.pinduoduo.com/')) {
        tab = await chrome.tabs.create({ url: searchUrl(job.keyword), active: false });
        tabId = tab.id; task.tabId = tabId;
      } else if (!isSearch(tab.url, job.keyword)) await chrome.tabs.update(tabId, { url: searchUrl(job.keyword) });
      await save(task); await wait(900); await ready();
    },
    read, hash, resolve, enrich, close: closeDetail, wait, save, update,
    async scroll() { await message({ type: 'PDD_SCROLL' }); }
  };
}
