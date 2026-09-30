import { similar } from './fingerprint.mjs';

function safeImage(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
}
export function productImage(item) {
  for (const image of Array.isArray(item?.galleryImages) ? item.galleryImages : []) {
    const url = safeImage(image); if (url) return url;
  }
  return safeImage(item?.image);
}
export function candidateExcluded(job, candidate) {
  return (job.exclusions || []).some(group =>
    (candidate.id && group.ids.includes(candidate.id)) ||
    (candidate.image && group.images.includes(candidate.image)) ||
    group.fingerprints.some(fp => similar(fp, candidate.fingerprint)));
}
export function removeProduct(job, id) {
  const index = job?.groups?.findIndex(group => group.best?.id === id) ?? -1;
  if (index < 0) return false;
  const [group] = job.groups.splice(index, 1);
  job.exclusions ||= [];
  job.exclusions.push({
    ids: [...new Set([...(group.ids || []), group.best.id].filter(Boolean))],
    images: [...new Set([group.image, group.best.image, productImage(group.best)].filter(Boolean))],
    fingerprints: [group.fingerprint, group.best.fingerprint].filter(Boolean)
  });
  job.refillRequested = true;
  job.detailDone = job.groups.filter(g => ['done', 'partial', 'error'].includes(g.best?.detailStatus)).length;
  return true;
}
export function prepareRefill(job) {
  if (!job.refillRequested) return false;
  job.scanned = 0; job.skipped = 0; job.lastSkip = ''; job.searchStatus = '';
  job.phase = 'search'; job.status = 'pending'; job.refillRequested = false;
  job.restartSearch = true;
  for (const group of job.groups) group.retained = true;
  job.note = '已删除不需要的商品，正在补齐数量';
  return true;
}
