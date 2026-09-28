import { encodeGbkQuery, keywordFromSearch } from './gbk.mjs';

const pdd = {
  id: 'pdd',
  label: '拼多多',
  supported: true,
  contentScript: 'content.js',
  detailScript: 'detail-content.js',
  searchUrl(keyword) {
    const url = new URL('https://mobile.pinduoduo.com/search_result.html');
    url.searchParams.set('search_key', keyword);
    return url.href;
  },
  isSearch(raw, keyword) {
    try {
      const url = new URL(raw);
      return url.origin === 'https://mobile.pinduoduo.com' && /\/search_result\.html$/.test(url.pathname) && url.searchParams.get('search_key') === keyword;
    } catch { return false; }
  },
  productId(raw) {
    try {
      const url = new URL(raw);
      const id = url.searchParams.get('goods_id');
      return url.protocol === 'https:' && url.hostname === 'mobile.pinduoduo.com' && /^\d+$/.test(id || '') ? id : '';
    } catch { return ''; }
  },
  productUrl(id) { return `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`; },
  isOnSite(raw) {
    try { return new URL(raw).origin === 'https://mobile.pinduoduo.com'; } catch { return false; }
  }
};

const ali = {
  id: '1688',
  label: '1688',
  supported: true,
  contentScript: 'content-1688.js',
  detailScript: 'detail-1688.js',
  searchUrl(keyword) {
    return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeGbkQuery(keyword)}`;
  },
  isSearch(raw, keyword) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && /(^|\.)1688\.com$/.test(url.hostname) && /offer_search/.test(url.pathname) && keywordFromSearch(url.search, 'keywords') === keyword;
    } catch { return false; }
  },
  productId(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !/(^|\.)1688\.com$/.test(url.hostname)) return '';
      return url.pathname.match(/\/offer\/(\d+)(?:\.html)?$/)?.[1] || '';
    } catch { return ''; }
  },
  productUrl(id) { return `https://detail.1688.com/offer/${id}.html`; },
  isOnSite(raw) {
    try { return new URL(raw).protocol === 'https:' && /(^|\.)1688\.com$/.test(new URL(raw).hostname); } catch { return false; }
  }
};

const sites = { pdd, '1688': ali };

export function siteById(id) { return sites[id] || pdd; }

export function siteForJob(job) { return siteById(job?.site); }

export function resolveSite(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === '1688.com' || host.endsWith('.1688.com')) return ali;
  if (host === 'pinduoduo.com' || host.endsWith('.pinduoduo.com') || host.endsWith('.yangkeduo.com')) return pdd;
  return { id: '', label: '', supported: false };
}

export function allowedImageHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'pddpic.com' || host.endsWith('.pddpic.com') || host === 'mobile.pinduoduo.com'
    || host === 'alicdn.com' || host.endsWith('.alicdn.com');
}
