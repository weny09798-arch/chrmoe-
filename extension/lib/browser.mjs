import { normalizeDetail } from './detail.mjs';
import {parsePrice,validProductTitle} from './core.mjs';
import { siteById, siteForJob } from './sites.mjs';
import { readLiveTaobao } from './taobao-page.mjs';
import { readLivePddSearch } from './pdd-search-page.mjs';

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function productId(raw) {
  try {
    const url = new URL(raw);
    const id = url.searchParams.get('goods_id');
    return siteById('pdd').isOnSite(raw) && /^\d+$/.test(id || '') ? id : '';
  } catch { return ''; }
}
export function searchUrl(keyword) {
  const url = new URL('https://mobile.pinduoduo.com/search_result.html');
  url.searchParams.set('search_key', keyword);
  return url.href;
}
function blocked(message, permissionOrigin = '') { return Object.assign(new Error(message), { blocked: true, permissionOrigin }); }

export async function closeTaskDetailTab(currentTask) {
  if (!currentTask || typeof currentTask !== 'object') return;
  const id = Number.isInteger(currentTask.detailTabId) ? currentTask.detailTabId : undefined;
  delete currentTask.detailTabId;
  delete currentTask.detailGoodsId;
  delete currentTask.detailSite;
  if (id !== undefined && !currentTask.detailBorrowed) await chrome.tabs.remove(id).catch(() => {});
}

function readLiveGoods() {
  const raw = globalThis.rawData;
  const id = new URL(location.href).searchParams.get('goods_id');
  const goods = [raw?.store?.initDataObj?.goods, raw?.initDataObj?.goods, raw?.goods, raw]
    .find(candidate => candidate && String(candidate.goodsID ?? candidate.goodsId ?? candidate.goods_id) === id);
  if (!goods || typeof goods !== 'object' || Array.isArray(goods)) return null;
  const skuList = Array.isArray(goods.skus) ? goods.skus : Array.isArray(goods.skuList) ? goods.skuList : [];
  return {
    goodsID: goods.goodsID ?? goods.goodsId ?? goods.goods_id,
    goodsName: goods.goodsName ?? goods.goods_name,
    title: goods.title,
    shareDesc: goods.shareDesc,
    goodsDesc: goods.goodsDesc,
    descriptionText: goods.descriptionText,
    description: goods.description,
    minGroupPrice: goods.minGroupPrice,
    price: goods.price,
    cents: goods.cents,
    category: goods.category,
    catName: goods.catName,
    categoryName: goods.categoryName,
    topGallery: goods.topGallery,
    gallery: goods.gallery,
    galleryImages: goods.galleryImages,
    viewImageData: goods.viewImageData,
    detailGallery: goods.detailGallery,
    detailImages: goods.detailImages,
    decoration: goods.decoration,
    goodsProperty: goods.goodsProperty,
    properties: goods.properties,
    attributes: goods.attributes,
    videoUrl: goods.videoUrl,
    videoGallery: goods.videoGallery,
    descVideoGallery: goods.descVideoGallery,
    certificateImages: goods.certificateImages,
    sizeChartImages: goods.sizeChartImages,
    specNames: goods.specNames,
    skus: skuList.map(sku => ({
      id: sku?.id,
      skuId: sku?.skuId,
      skuID: sku?.skuID,
      specs: sku?.specs,
      groupPrice: sku?.groupPrice,
      oldGroupPrice: sku?.oldGroupPrice,
      normalPrice: sku?.normalPrice,
      price: sku?.price,
      cents: sku?.cents,
      thumbUrl: sku?.thumbUrl,
      thumb_url: sku?.thumb_url,
      image: sku?.image,
      quantity: sku?.quantity,
      stock: sku?.stock,
      weight: sku?.weight,
      weightKg: sku?.weightKg,
      sizeCm: sku?.sizeCm
    }))
  };
}

export function descriptionDocumentUrl(input) {
  const raw = String(input || '').trim().replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
  if (!raw) return '';
  let url;
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); }
  catch { return ''; }
  if (url.protocol !== 'https:') return '';
  const host = url.hostname;
  const allowed = /(^|\.)(alicdn|tmall|taobao|1688)\.com$/.test(host);
  if (!allowed || /\/offer\/\d+\.html?$/i.test(url.pathname) || /\/(?:item|detail)\.htm$/i.test(url.pathname) || /\.(?:jpg|jpeg|png|webp|gif)(?:$|\?)/i.test(url.pathname)) return '';
  return url.href;
}

export function imageUrlsInDescription(text) {
  let source = String(text || '').replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/\\["']/g, '"');
  source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<(?:img|div|p|section)\b/i.test(source)) {
    source = [...source.matchAll(/<img\b[^>]*>|(?:background(?:-image)?\s*:\s*[^;"']*url\([^)]*\))/gi)].map(m => m[0]).join('\n');
  }
  const found = [];
  for (const match of source.matchAll(/(?:https?:)?\/\/[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi)) {
    let url = match[0].startsWith('//') ? `https:${match[0]}` : match[0];
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'alicdn.com' || parsed.hostname.endsWith('.alicdn.com')) {
        parsed.pathname = parsed.pathname.replace(/(\.(?:jpg|jpeg|png|webp))(?:_[^/]*)?$/i, '$1');
        if (/x-oss-process|resize/i.test(parsed.search)) parsed.search = '';
        url = parsed.href;
      } else continue;
    } catch { /* Keep the original address when it is not a URL. */ }
    if (/^https:/.test(url) && !/tps-|\/tps\/|avatar|sprite|_20x20|_30x30|_50x50|1x1|-rate(?:[_.])|22185873824_536529798\.jpg/i.test(url)) found.push(url.replace(/&amp;/g,'&'));
  }
  return [...new Set(found)].slice(0, 60);
}

function readLive1688() {
  const offerId = location.pathname.match(/\/offer\/(\d+)/)?.[1] || '';
  const found = { title: '', price: '', images: [], detailImages: [], detailUrl: '', detailUrls: [], videoUrl: '', skus: [] };
  const seen = new Set();
  let visited = 0;
  const descriptionDocumentUrl = input => {
    const raw = String(input || '').trim().replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
    if (!raw) return '';
    let url;
    try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); }
    catch { return ''; }
    if (url.protocol !== 'https:') return '';
    const host = url.hostname;
    const allowed = host === 'alicdn.com' || host.endsWith('.alicdn.com') || host === 'tmall.com' || host.endsWith('.tmall.com') || host === '1688.com' || host.endsWith('.1688.com');
    if (!allowed || /\/offer\/\d+\.html?$/i.test(url.pathname) || /\.(?:jpg|jpeg|png|webp|gif)(?:$|\?)/i.test(url.pathname)) return '';
    return url.href;
  };
  const considerTitle = text => {
    const title = typeof text === 'string' ? text.trim() : '';
    if (title.length < 8 || title.length > 120 || title.length <= found.title.length || /[¥￥]/.test(title)) return;
    if (/(?:厂|公司|商行|经营部)$/.test(title)) return;
    found.title = title;
  };
  const visit = node => {
    if (!node || typeof node !== 'object' || seen.has(node) || visited > 4000) return;
    seen.add(node);
    visited += 1;
    if (Array.isArray(node)) { node.slice(0, 60).forEach(visit); return; }
    const id = node.offerId || node.offerID;
    if (id != null && offerId && /^\d+$/.test(String(id)) && String(id) !== offerId) return;
    considerTitle(node.subject || node.offerTitle);
    considerTitle(node.title);
    const video = node.videoUrl || node.videoURL || node.playUrl || node.videoPlayUrl;
    if (!found.videoUrl && typeof video === 'string' && /^https?:\/\//.test(video)) found.videoUrl = video;
    if (!found.price && /^\d+(?:\.\d+)?$/.test(String(node.price ?? '')) && Number(node.price) > 0) found.price = String(node.price);
    for (const key of ['fullPathImageURI', 'originalImageURI', 'size310x310ImageURI']) {
      const image = node[key];
      if (typeof image === 'string' && /alicdn\.com/.test(image)) found.images.push(image);
    }
    const map = node.skuInfoMap || node.skuMap;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [key, sku] of Object.entries(map)) {
        if (!sku || typeof sku !== 'object') continue;
        found.skus.push({
          key,
          skuId: sku.skuId || sku.specId || '',
          price: sku.discountPrice ?? sku.price ?? '',
          image: sku.imageUrl || sku.skuImageUrl || '',
          stock: sku.canBookCount ?? sku.stock ?? ''
        });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /^(?:detailUrl|descUrl|descriptionUrl|description|detailHtml|descHtml)$/i.test(key)) {
        const doc = descriptionDocumentUrl(value);
        if (doc) found.detailUrls.push(doc);
        else if (/<img\b/i.test(value)) {
          for (const match of value.matchAll(/(?:https?:)?\/\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)/gi)) found.detailImages.push(match[0]);
        }
      } else if (value && typeof value === 'object') visit(value);
    }
  };
  const harvestDocs = node => {
    const local = new Set();
    let count = 0;
    const walk = current => {
      if (!current || typeof current !== 'object' || local.has(current) || count > 8000) return;
      local.add(current);
      count += 1;
      if (Array.isArray(current)) { current.slice(0, 40).forEach(walk); return; }
      for (const [key, value] of Object.entries(current)) {
        if (typeof value === 'string' && /detailUrl|descUrl|descriptionUrl/i.test(key)) {
          const url = descriptionDocumentUrl(value);
          if (url) found.detailUrls.push(url);
        } else if (value && typeof value === 'object' && !/skuInfoMap|skuMap/i.test(key)) walk(value);
      }
    };
    walk(node);
  };
  harvestDocs(globalThis.context);
  harvestDocs(globalThis.__INIT_DATA);
  visit(globalThis.context);
  visit(globalThis.__INIT_DATA);
  found.images = [...new Set(found.images)].slice(0, 30);
  found.detailImages = [...new Set(found.detailImages.map(item => item.startsWith('//') ? `https:${item}` : item))].slice(0, 60);
  found.detailUrls = [...new Set(found.detailUrls)].slice(0, 5);
  found.detailUrl = found.detailUrls[0] || '';
  found.skus = found.skus.filter(sku => sku.price !== '' && sku.price != null).slice(0, 200);
  return found.title || found.skus.length || found.images.length || found.detailImages.length || found.detailUrls.length || found.videoUrl ? found : null;
}

async function descriptionImages(detailUrl) {
  const url = descriptionDocumentUrl(detailUrl);
  if (!url) return [];
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!response.ok) return [];
    return imageUrlsInDescription(await response.text());
  } catch { return []; }
}

export function browserPorts({ save, update, detailPollLimit, detailPollWait = wait, cardPollWait = wait }) {
  let tabId, task, detailTabId, currentJob;
  async function closeDetail({ preserveBlocked = false } = {}) {
    if (preserveBlocked && task?.status === 'blocked' && Number.isInteger(task.detailTabId)) return;
    if (detailTabId === undefined && Number.isInteger(task?.detailTabId)) detailTabId = task.detailTabId;
    const id = detailTabId;
    detailTabId = undefined;
    if (task) {
      delete task.detailTabId;
      delete task.detailGoodsId;
      delete task.detailSite;
    }
    if (id !== undefined && !task?.detailBorrowed) await chrome.tabs.remove(id).catch(() => {});
    if (task) await save(task).catch(() => {});
  }
  function usableDetail(detail) {
    return detail && (detail.title || ['galleryImages', 'detailImages', 'certificateImages', 'sizeChartImages', 'attributes', 'skus'].some(key => detail[key]?.length));
  }
  function detailScore(detail) {
    if (!detail) return -1;
    let score = detail.title ? 1 : 0;
    if (detail.descriptionText) score += 8;
    if (detail.category) score += 4;
    if (detail.videoUrl) score += 4;
    if (detail.price || detail.cents) score += 2;
    for (const key of ['galleryImages', 'detailImages', 'certificateImages', 'sizeChartImages', 'attributes', 'specNames', 'skus']) score += (detail[key]?.length || 0) * 3;
    return score;
  }
  function hasReadyDetail(detail) {
    return Boolean(detail && (
      detail.descriptionText || detail.category || detail.videoUrl ||
      ['detailImages', 'certificateImages', 'sizeChartImages', 'attributes', 'specNames', 'skus'].some(key => detail[key]?.length)
    ));
  }
  async function enrich(item, currentTask, cancelled) {
    const checkCancelled = () => {
      if (cancelled?.()) throw Object.assign(new Error('商品详情采集已取消'), { cancelled: true });
    };
    const interruptibleWait = async (ms, pause = detailPollWait) => {
      checkCancelled();
      if (!cancelled) return pause(ms);
      for (let remaining = ms; remaining > 0;) {
        const slice = Math.min(100, remaining), started = Date.now();
        await pause(slice);
        checkCancelled();
        // Hidden-page timers may wake much later than requested. Count that time
        // instead of multiplying the delay across every cancellation-check slice.
        remaining -= Math.max(slice, Date.now() - started);
      }
    };
    checkCancelled();
    task = currentTask || task;
    const id = typeof item?.id === 'string' ? item.id : Number.isSafeInteger(item?.id) ? String(item.id) : '';
    if (!/^\d+$/.test(id)) throw new Error('无效商品 ID');
    const site = siteById(item?.site);
    const detailUrl = site.detailUrl ? site.detailUrl(id, item.detailSourceUrl || item.url) : site.productUrl(id, item.url);
    let preserveDetailTab = false;
    try {
      let tab = null;
      if (Number.isInteger(task?.detailTabId) && (!task.detailGoodsId || task.detailGoodsId === id) && (!task.detailSite || task.detailSite === site.id)) {
        tab = await chrome.tabs.get(task.detailTabId).catch(() => null);
        checkCancelled();
        if (tab && (!task.detailGoodsId && site.productId(tab.url || '') !== id)) tab = null;
        if (tab && task.detailSite && task.detailSite !== site.id) tab = null;
      }
      if (!tab) {
        if (Number.isInteger(task?.detailTabId)) await closeDetail();
        checkCancelled();
        if (task) delete task.detailBorrowed;
        tab = await chrome.tabs.create({ url: detailUrl, active: false });
        detailTabId = tab.id;
        if (task) {
          task.detailTabId = detailTabId;
          task.detailGoodsId = id;
          task.detailSite = site.id;
          await save(task);
        }
      } else {
        detailTabId = tab.id;
        if (task) {
          task.detailTabId = detailTabId;
          task.detailGoodsId = id;
          task.detailSite = site.id;
          await save(task);
        }
      }
      checkCancelled();
      let ready = false;
      for (let i = 0; i < 40; i++) {
        checkCancelled();
        const loadedTab = await chrome.tabs.get(detailTabId);
        checkCancelled();
        if (loadedTab.status === 'complete') { ready = true; break; }
        await interruptibleWait(300, wait);
      }
      if (!ready) throw new Error('商品详情加载超时');
      if (site.id === 'pdd') await interruptibleWait(1200);
      checkCancelled();
      await chrome.scripting.executeScript({ target: { tabId: detailTabId }, files: [...(site.detailHelpers || []), site.detailScript] });
      checkCancelled();
      let pollLimit = detailPollLimit ?? (site.id === 'pdd' ? 160 : 40);
      let best = null, bestScore = -1, stableKey = '', stableCount = 0;
      const fetchedDocs = new Set();
      let fetchedDetailImages = [];
      for (let i = 0; i < pollLimit; i++) {
        checkCancelled();
        let pageGoods = null;
        if (site.id === 'pdd' || site.id === '1688' || site.id === 'taobao') {
          const injected = await chrome.scripting.executeScript({
            target: { tabId: detailTabId }, world: 'MAIN', func: site.id === '1688' ? readLive1688 : site.id === 'taobao' ? readLiveTaobao : readLiveGoods
          }).catch(() => null);
          pageGoods = injected?.[0]?.result || null;
        }
        checkCancelled();
        const snapshot = await chrome.tabs.sendMessage(detailTabId, pageGoods
          ? { type: 'PDD_DETAIL_SNAPSHOT', pageGoods }
          : { type: 'PDD_DETAIL_SNAPSHOT' });
        if (snapshot?.blocked) {
          preserveDetailTab = true;
          throw blocked(snapshot.reason || '商品详情页已阻断');
        }
        checkCancelled();
        if (!snapshot) throw new Error('商品详情页未响应');
        if (snapshot.error) throw new Error(snapshot.error);
        if (site.id === 'pdd' && detailPollLimit == null && Number.isSafeInteger(snapshot.skuTotal) && snapshot.skuTotal > 0) {
          // Allow every dimension change and its bounded retries per target.
          // Very large products retain an overall wait cap and a partial note.
          const dimensions = Number.isSafeInteger(snapshot.skuDimensions) && snapshot.skuDimensions > 0 ? snapshot.skuDimensions : 2;
          pollLimit = Math.max(pollLimit, Math.min(3600, 30 + snapshot.skuTotal * (dimensions * 20 + 4)));
        }
        if (snapshot.goodsId !== id) throw new Error('商品详情 ID 不匹配');
        const docUrls = [...new Set([...(pageGoods?.detailUrls || []), pageGoods?.detailUrl, ...(snapshot.descriptionUrls || [])].filter(url => typeof url === 'string' && url))];
        if ((site.id === '1688' || site.id === 'taobao') && docUrls.length) {
          for (const url of docUrls) {
            if (fetchedDocs.has(url)) continue;
            fetchedDocs.add(url);
            fetchedDetailImages.push(...await descriptionImages(url));
            checkCancelled();
          }
          fetchedDetailImages = [...new Set(fetchedDetailImages)];
          const reserved = new Set((snapshot.detail?.skus || []).map(sku => sku?.image).filter(Boolean));
          const detailOnly = fetchedDetailImages.filter(url => !reserved.has(url));
          if (detailOnly.length && snapshot.detail) {
            snapshot.detail.detailImages = [...new Set([...(snapshot.detail.detailImages || []),...detailOnly])].slice(0,60);
            if (site.id === 'taobao' && !snapshot.detailLoading) {
              snapshot.detailPending = false;
              if (!snapshot.skuPending) { snapshot.detail.detailStatus = 'done'; snapshot.detail.detailNote = ''; }
            }
          }
        }
        const detail = snapshot.detail;
        if (usableDetail(detail)) {
          const score = detailScore(detail);
          if (score >= bestScore) { best = detail; bestScore = score; }
          const key = JSON.stringify(detail);
          stableCount = key === stableKey ? stableCount + 1 : 1;
          stableKey = key;
          // A matching top-level JSON product root is the reader's explicit readiness signal.
          // Responses from older reader versions did not include this field and remain compatible.
          const detailWait = docUrls.length ? 30 : 15;
          const waitingForDetail = snapshot.detailPending && (site.id === 'pdd' || (snapshot.detailLoading ? i < pollLimit - 1 : stableCount < detailWait));
          const waitingForSku = snapshot.skuPending && (site.id === 'pdd' || stableCount < (site.id === 'taobao' ? 20 : 12));
          if (!waitingForDetail && !waitingForSku && ((snapshot.ready !== false && hasReadyDetail(detail)) || stableCount >= 8)) return normalizeDetail(best, item);
        }
        if (i < pollLimit - 1) await interruptibleWait(site.id === 'pdd' ? 1200 : 300);
      }
      if (best) return normalizeDetail({ ...best, detailStatus: 'partial', detailNote: [best.detailNote, '加载等待已达到上限，仅保留已确认的数据'].filter(Boolean).join('；') }, item);
      throw new Error('商品详情加载超时');
    } finally {
      if (!preserveDetailTab) await closeDetail();
    }
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
    await chrome.scripting.executeScript({ target: { tabId }, files: [siteForJob(currentJob).contentScript] });
    const response = await chrome.tabs.sendMessage(tabId, data);
    if (!response) throw new Error('采集页未响应');
    if (response.error) throw new Error(response.error);
    return response;
  }
  async function read(job) {
    currentJob = job;
    const site = siteForJob(job);
    await ready();
    let page;
    try { page = await message({ type: 'PDD_SNAPSHOT' }); }
    catch (error) {
      const tab = await chrome.tabs.get(tabId);
      if (!site.isOnSite(tab.url || '')) throw blocked(`采集页离开${site.label}，请返回搜索页面后继续`);
      throw error;
    }
    if (page.blocked) return page;
    if (!site.isSearch(page.url, job.keyword)) throw blocked(`采集页已离开“${job.keyword}”的搜索结果，请返回后继续`);
    if (site.id === 'pdd' && page.cards?.some(card => !card.id)) {
      const injected = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readLivePddSearch }).catch(() => null);
      const searchData = injected?.[0]?.result;
      if (searchData) {
        page = await message({ type: 'PDD_SNAPSHOT', searchData });
        if (page.blocked) return page;
        if (!site.isSearch(page.url, job.keyword)) throw blocked(`采集页已离开“${job.keyword}”的搜索结果，请返回后继续`);
      }
    }
    return page;
  }
  async function prepareCard(card,job,cancelled=()=>false) {
    const complete=c=>c&&validProductTitle(c.title,job.keyword)&&parsePrice(c.priceText)!==null;
    if(siteForJob(job).id!=='taobao'||complete(card)||cancelled())return card;
    currentJob=job;
    const before=await read(job);
    if(before.blocked)throw blocked(before.reason);
    const initial=before.cards.find(c=>c.key===card.key&&c.id===card.id);
    if(complete(initial))return initial;
    if(cancelled())return card;
    await message({type:'PDD_PREPARE_CARD',key:card.key});
    let latest=initial;
    for(let i=0;i<12;i++) {
      if(cancelled())return card;
      if(i)await cardPollWait(500);
      if(cancelled())return card;
      const page=await read(job);
      if(page.blocked)throw blocked(page.reason);
      latest=page.cards.find(c=>c.key===card.key&&c.id===card.id);
      if(complete(latest))return latest;
    }
    if(!latest)throw new Error('待采集商品已离开列表，未使用旧快照');
    return latest;
  }
  async function restoreSearch(job, position, cancelled = () => false) {
    const check = () => { if (cancelled()) throw Object.assign(new Error('商品链接读取已取消'), {cancelled:true}); };
    check();
    await chrome.tabs.update(tabId, {url:siteForJob(job).searchUrl(job.keyword,job.sourceOrigin)});
    await cardPollWait(300); check(); await ready(); check();
    let restored = await read(job); check();
    if (restored.blocked) throw blocked(restored.reason);
    for (let i=0;i<8&&!restored.cards.length;i++) {
      await cardPollWait(500); check(); restored=await read(job); check();
      if(restored.blocked)throw blocked(restored.reason);
    }
    await message({type:'PDD_SCROLL',position:Number.isFinite(position)?position:0}); check();
  }
  function clearHeldCard() {
    delete task.resolveBlockedTabId; delete task.resolveBlockedCardKey; delete task.resolveBlockedKeyword;
    delete task.resolveBlockedPosition; delete task.resolvePendingCard;
    delete task.resolveRestorePending;
  }
  async function rememberSearchRestore(result,card,position,job,cancelled) {
    task.resolvedCard = {...card,...result,key:card.key,keyword:job.keyword,site:siteForJob(job).id};
    task.resolveBlockedTabId = tabId; task.resolveBlockedCardKey = card.key; task.resolveBlockedKeyword = job.keyword;
    task.resolveBlockedPosition = position; task.resolvePendingCard = {...card}; task.resolveRestorePending = true;
    await save(task);
    await restoreSearch(job,position,cancelled);
    clearHeldCard(); delete task.resolvedCard; await save(task);
  }
  async function resolve(card, page, job, cancelled = () => false) {
    currentJob = job;
    const site = siteForJob(job);
    const check = () => { if (cancelled()) throw Object.assign(new Error('商品链接读取已取消'), {cancelled:true}); };
    check();
    const attemptKey = `${site.id}:${card.key}`;
    if (Number.isInteger(task.resolveBlockedTabId)) {
      if(task.resolveBlockedCardKey && task.resolveBlockedCardKey !== card.key) throw blocked('请先处理之前受限的商品卡片');
      if(task.resolveBlockedKeyword && task.resolveBlockedKeyword !== job.keyword) throw blocked('请先处理之前受限的搜索任务');
      const heldId = task.resolveBlockedTabId;
      const held = await chrome.tabs.get(heldId).catch(() => null);
      check();
      if (held) {
        await chrome.scripting.executeScript({target:{tabId:heldId},files:[site.contentScript]});
        const state = await chrome.tabs.sendMessage(heldId,{type:'PDD_SNAPSHOT'});
        if (state?.blocked) throw blocked(state.reason || '请处理保留页面');
        check();
        const found = site.productId(held.url || '');
        if (found) {
          if(heldId===tabId)await rememberSearchRestore({id:found,url:site.productUrl(found,held.url),detailSourceUrl:held.url,navigated:true},card,task.resolveBlockedPosition ?? page.position,job,cancelled);
          clearHeldCard(); await save(task); check();
          return {...card,id:found,url:site.productUrl(found,held.url),detailSourceUrl:held.url,navigated:heldId===tabId};
        }
      }
      throw blocked('保留页面尚未返回有效商品');
    }
    if(task.resolvedCard?.key === card.key && task.resolvedCard.keyword === job.keyword && task.resolvedCard.site === site.id) {
      const resolved=task.resolvedCard;delete task.resolvedCard;await save(task);check();return {...card,...resolved};
    }
    if (site.productId(card.url || '')) return {...card,id:site.productId(card.url),navigated:false};
    task.resolveAttempts ||= {};
    if (task.resolveAttempts[attemptKey]) throw blocked('该商品卡片已经尝试打开，请手动处理后继续');
    task.resolveAttempts[attemptKey] = true;
    task.resolvePendingCard = {...card}; task.resolveBlockedPosition = page.position;
    await save(task);
    check();
    // Some result cards have only a click handler. Read the resulting detail URL.
    const children = new Set();
    const onCreated = tab => { if (tab.openerTabId === tabId) children.add(tab.id); };
    chrome.tabs.onCreated.addListener(onCreated);
    let id = '', sameTab = false, sourceUrl = '';
    const preserved = new Set();
    try {
      check();
      const opened = await message({ type: 'PDD_OPEN_CARD', key: card.key });
      if (opened.blocked) throw blocked(opened.reason || '商品卡片打开被阻断');
      for (let i = 0; i < 32 && !id; i++) {
        await cardPollWait(250);
        check();
        for (const candidateTabId of [tabId, ...children]) {
          const tab = await chrome.tabs.get(candidateTabId).catch(() => null);
          if (!tab) continue;
          let state;
          try {
            await chrome.scripting.executeScript({target:{tabId:candidateTabId},files:[site.contentScript]});
            state = await chrome.tabs.sendMessage(candidateTabId,{type:'PDD_SNAPSHOT'});
          } catch { /* A navigating page is checked again on the next bounded poll. */ }
          if (state?.blocked || /(?:captcha|verify|login|punish)/i.test(tab.url || '')) {
            preserved.add(candidateTabId);
            task.resolveBlockedTabId = candidateTabId;
            task.resolveBlockedCardKey = card.key;
            task.resolveBlockedKeyword = job.keyword;
            await save(task);
            throw blocked(state?.reason || '商品页面需要验证或登录');
          }
          check();
          const found = site.productId(tab?.url || '');
          if (found) { id = found; sourceUrl = tab.url; sameTab = candidateTabId === tabId; break; }
        }
      }
      if (!id) {
        const current = await message({ type: 'PDD_SNAPSHOT' });
        if (current.blocked) throw blocked(current.reason);
        throw Object.assign(new Error('无法从商品卡片获取详情链接；已暂停以免误操作，请联系适配页面'), { blocked: true });
      }
      check();
      if (sameTab) {
        await rememberSearchRestore({id,url:site.productUrl(id,sourceUrl),detailSourceUrl:sourceUrl,navigated:true},card,page.position,job,cancelled);
      }
      return { ...card, id, url: site.productUrl(id, sourceUrl || card.url || job.sourceOrigin),
        ...(site.detailUrl ? { detailSourceUrl: site.detailUrl(id, sourceUrl) } : {}), navigated: sameTab };
    } catch (error) {
      if (!error.cancelled) {
        const actual = task.resolveBlockedTabId ?? [...children].at(-1) ?? tabId;
        preserved.add(actual);
        task.resolveBlockedTabId = actual; task.resolveBlockedCardKey = card.key; task.resolveBlockedKeyword = job.keyword;
        await save(task);
        if (!error.blocked) throw blocked(error.message || '商品链接适配失败');
      }
      throw error;
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
      for (const child of children) if (!preserved.has(child)) await chrome.tabs.remove(child).catch(() => {});
    }
  }
  return {
    async open(job, currentTask) {
      task = currentTask; currentJob = job; tabId = task.tabId;
      const site = siteForJob(job);
      const target = site.searchUrl(job.keyword, job.sourceOrigin);
      let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (tab && task.resolveRestorePending && task.resolvedCard?.keyword===job.keyword && task.resolvedCard.site===site.id) {
        await chrome.scripting.executeScript({target:{tabId},files:[site.contentScript]});
        const state=await chrome.tabs.sendMessage(tabId,{type:'PDD_SNAPSHOT'});
        if(state?.blocked)throw blocked(state.reason || '请处理保留页面');
        if(site.isSearch(tab.url || '',job.keyword)) await message({type:'PDD_SCROLL',position:task.resolveBlockedPosition || 0});
        else if(site.productId(tab.url || '')===task.resolvedCard.id) await restoreSearch(job,task.resolveBlockedPosition);
        else throw blocked('请恢复原搜索结果后继续，已确认的商品链接仍保留');
        clearHeldCard(); await save(task); return;
      }
      if (!tab) {
        tab = await chrome.tabs.create({ url: target, active: false });
        tabId = tab.id; task.tabId = tabId;
      } else if (job.restartSearch || !site.isSearch(tab.url || '', job.keyword)) {
        if ((task.wasBlocked || job.wasBlocked || task.status === 'blocked' || job.status === 'blocked' || Number.isInteger(task.resolveBlockedTabId)) && !job.restartSearch) {
          const held = task.resolveBlockedTabId || tabId;
          const heldTab = await chrome.tabs.get(held).catch(() => null);
          if (heldTab) {
            await chrome.scripting.executeScript({target:{tabId:held},files:[site.contentScript]});
            const snapshot = await chrome.tabs.sendMessage(held,{type:'PDD_SNAPSHOT'});
            if (snapshot?.blocked) throw blocked(snapshot.reason || '请先处理保留页面');
            const resolvedId=site.productId(heldTab.url || '');
            if(resolvedId && task.resolveBlockedCardKey && task.resolveBlockedKeyword===job.keyword) {
              task.resolvedCard={...task.resolvePendingCard,key:task.resolveBlockedCardKey,keyword:job.keyword,site:site.id,id:resolvedId,url:site.productUrl(resolvedId,heldTab.url),detailSourceUrl:heldTab.url,navigated:held===tabId};
              if(held===tabId){task.resolveRestorePending=true;await save(task);await restoreSearch(job,task.resolveBlockedPosition);}
              clearHeldCard();
              await save(task);return;
            }
          }
          throw blocked('请返回搜索结果后继续，保留页未重新导航');
        }
        await chrome.tabs.update(tabId, { url: target });
      }
      job.restartSearch = false;
      await save(task); await wait(900); await ready();
    },
    async listCurrentTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.filter(tab => Number.isInteger(tab.id) && siteById('taobao').productId(tab.url || ''))
        .map(tab => ({id:tab.id,url:tab.url,title:tab.title || ''}));
    },
    async current(id, currentTask, cancelled = () => false) {
      const check = () => { if(cancelled()) throw Object.assign(new Error('当前商品采集已取消'),{cancelled:true}); };
      check();
      const tab = await chrome.tabs.get(id);
      check();
      const site = siteById('taobao'), goodsId = site.productId(tab.url || '');
      if (!goodsId) throw blocked('当前标签不是有效淘宝或天猫商品');
      task = currentTask;
      task.detailTabId = id; task.detailGoodsId = goodsId; task.detailSite = 'taobao'; task.detailBorrowed = true;
      await save(task); check();
      const item = {id:goodsId,site:'taobao',platform:site.label,url:site.productUrl(goodsId,tab.url)};
      const detail = await enrich(item,task,cancelled);
      check();
      const latest = await chrome.tabs.get(id);
      check();
      if (site.productId(latest.url || '') !== goodsId) throw blocked('当前商品标签已切换，未保存旧商品');
      return {...detail,...item};
    },
    read, prepareCard, resolve, enrich, close: closeDetail, wait, save, update,
    async scroll() { return message({ type: 'PDD_SCROLL' }); }
  };
}
