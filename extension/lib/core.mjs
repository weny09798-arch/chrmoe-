import { similar } from './fingerprint.mjs';
import { candidateExcluded, prepareRefill } from './products.mjs';

export const SCAN_LIMIT = 200;
export const OUTPUT_LIMIT = 20;
export function normalizeLimit(value) {
  if (value == null || value === '') return OUTPUT_LIMIT;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(number) && number >= 1 && number <= SCAN_LIMIT ? number : null;
}
export function normalizePriceCents(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function outputLimit(job) {
  const limit = job?.limit;
  return Number.isInteger(limit) && limit >= 1 && limit <= SCAN_LIMIT ? limit : OUTPUT_LIMIT;
}
export function priceAllowed(cents, job) {
  if (!Number.isSafeInteger(cents) || cents <= 0) return false;
  if (Number.isSafeInteger(job?.priceMin) && cents < job.priceMin) return false;
  if (Number.isSafeInteger(job?.priceMax) && cents > job.priceMax) return false;
  return true;
}
export const STATUS = { pending: '等待', running: '搜索中', paused: '已暂停', blocked: '等待处理', done: '完成', short: '数量不足', error: '失败', stopped: '已停止' };

export function parsePrice(text) {
  const value = String(text).replace(/\u00a0/g, ' ').replace(/,/g, '');
  // Never infer a price from sales counts, coupons, or a bare number in a title.
  const matches = [...value.matchAll(/[¥￥]\s*(\d+)(?:\s*\.\s*(\d{1,2}))?(?!\d|\s*\.\s*\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const before = value.slice(0, match.index);
  if (/(?:优惠券|优惠劵|券面额|领券|抵用券|满减券|代金券|红包|立减|直减|补贴|省)[\s:：·—\-（(]*$/.test(before)) return null;
  const after = value.slice(match.index + match[0].length).trimStart();
  if (/^(?:[-~～—至]|元?\s*起)/.test(after)) return null;
  if (/^(?:元\s*)?[\s:：·—\-）)]*(?:优惠券|优惠劵|券面额|抵用券|满减券|代金券|红包|立减|直减|补贴)/.test(after)) return null;
  const cents = Math.round(Number(`${match[1]}.${match[2] || '0'}`) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function addKeyword(list, text) {
  const keyword = String(text).trim().slice(0, 100);
  if (!keyword || list.includes(keyword)) return false;
  list.push(keyword);
  return true;
}

export function titleRelatedToKeyword(title, keyword) {
  const query = String(keyword || '').normalize('NFKC').toLowerCase();
  const letters = [...query].filter(char => /\p{L}/u.test(char));
  const signals = letters.length ? letters : [...query].filter(char => /\p{N}/u.test(char));
  const candidate = new Set([...String(title || '').normalize('NFKC').toLowerCase()]);
  return signals.some(char => candidate.has(char));
}

export function validProductTitle(title, keyword) {
  const value = String(title || '').trim();
  if (value.length < 2 || !titleRelatedToKeyword(value, keyword)) return false;
  if (/未发货秒退|保证金|(?:不配送|不可配送|不支持配送)/u.test(value)) return false;
  if (/^(?:本店)?已拼[\d.万千+]+(?:件|人)?$/u.test(value)) return false;
  if (/^好评(?:超|率)?[\d.%+万千]+同款$/u.test(value)) return false;
  if (/^[\d.万千+]+人好评$/u.test(value)) return false;
  return true;
}

function createJob(keyword, site = 'pdd', options = {}) {
  const limit = normalizeLimit(options.limit);
  return {
    keyword, site: site === '1688' || site === 'taobao' ? site : 'pdd',
    limit: limit || OUTPUT_LIMIT,
    priceMin: Number.isSafeInteger(options.priceMin) ? options.priceMin : null,
    priceMax: Number.isSafeInteger(options.priceMax) ? options.priceMax : null,
    status: 'pending', phase: 'search', searchStatus: '', detailDone: 0, scanned: 0, skipped: 0, seen: [], groups: [], note: '', scrolls: 0
  };
}

export function createTask(keywords) {
  return {
    version: 1, id: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending',
    jobs: keywords.map(keyword => createJob(keyword))
  };
}

export function enqueueKeyword(task, keyword, site = 'pdd', options = {}) {
  if (!task) {
    const created = createTask([keyword]);
    created.jobs[0] = createJob(keyword, site, options);
    return created;
  }
  task.jobs.push(createJob(keyword, site, options));
  if (['done', 'error', 'stopped'].includes(task.status)) task.status = 'pending';
  return task;
}

export function retryJob(task, index) {
  const previous = task?.jobs?.[index];
  if (!previous) throw new Error('找不到要重新搜索的商品名称');
  task.jobs[index] = createJob(previous.keyword, previous.site || 'pdd', {
    limit: previous.limit, priceMin: previous.priceMin, priceMax: previous.priceMax
  });
  task.jobs[index].exclusions = previous.exclusions || [];
  if (['done', 'error', 'stopped'].includes(task.status)) task.status = 'pending';
  return task.jobs[index];
}

export function selected(job) { return job.groups.slice(0, outputLimit(job)).map(group => group.best); }

const hasValues = value => Array.isArray(value) && value.length > 0;
export function hasDetailData(item) {
  if (!item || typeof item !== 'object') return false;
  if (['descriptionText', 'videoUrl'].some(key => String(item[key] || '').trim())) return true;
  if (['detailImages', 'attributes', 'certificateImages', 'sizeChartImages', 'specNames'].some(key => hasValues(item[key]))) return true;
  return hasValues(item.skus) && item.skus.some(sku =>
    sku && (sku.id || hasValues(sku.specs) || (sku.image && sku.image !== item.image) || sku.stock));
}

const detailFinished = item => ['done', 'partial', 'error'].includes(item.detailStatus);
export function countDetails(job) { return selected(job).filter(detailFinished).length; }

export function addCandidate(job, candidate) {
  if (!candidate.id || !candidate.fingerprint || !Number.isSafeInteger(candidate.cents) || candidate.cents <= 0) return false;
  if (candidateExcluded(job, candidate)) return false;
  // Keep the original group representative stable: replacing it with each winner can cause similarity drift.
  let group = job.groups.find(g => g.ids.includes(candidate.id));
  if (!group) group = job.groups.find(g => g.image === candidate.image || similar(g.fingerprint, candidate.fingerprint));
  if (!group) {
    job.groups.push({ ids: [candidate.id], image: candidate.image, fingerprint: candidate.fingerprint, best: candidate });
  } else {
    if (!group.ids.includes(candidate.id)) group.ids.push(candidate.id);
    if (!group.retained && candidate.cents < group.best.cents) group.best = candidate;
  }
  return true;
}

export function recoverTask(task) {
  if (!task || task.version !== 1 || !Array.isArray(task.jobs)) return null;
  if (['running', 'pending', 'blocked'].includes(task.status)) task.status = 'paused';
  for (const job of task.jobs) {
    if (prepareRefill(job)) { job.status = 'paused'; task.status = 'paused'; }
    if (['running', 'blocked'].includes(job.status)) job.status = 'paused';
    for (const group of job.groups || []) {
      const item = group.best;
      if (!item) continue;
      if (!['pending', 'running', 'done', 'partial', 'error'].includes(item.detailStatus)) {
        item.detailStatus = hasDetailData(item) ? 'done' : 'pending';
      }
    }
    job.detailDone = countDetails(job);
    const pending = selected(job).some(item => !detailFinished(item));
    if (['done', 'short'].includes(job.status) && pending) {
      job.searchStatus = job.searchStatus || job.status;
      job.phase = 'detail';
      job.status = 'paused';
      task.status = 'paused';
    } else {
      job.phase ||= ['done', 'short'].includes(job.status) ? 'done' : 'search';
      job.searchStatus ||= '';
    }
  }
  return task;
}
