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
const productId = value => value == null ? '' : String(value).trim();
const source = job => job.site || 'pdd';
export function candidateExcluded(job, candidate, task) {
  const id = productId(candidate.id);
  return Boolean(id && (
    (job.exclusions || []).some(group => group.ids?.some(value => productId(value) === id)) ||
    (task?.exclusions || []).some(group => group.site === source(job) && group.ids?.some(value => productId(value) === id))
  ));
}
export function removeProduct(job, id, task) {
  id = productId(id);
  const index = job?.groups?.findIndex(group => productId(group.best?.id) === id) ?? -1;
  if (index < 0) return false;
  if (task) {
    task.exclusions ||= [];
    if (!task.exclusions.some(group => group.site === source(job) && group.ids?.some(value => productId(value) === id))) task.exclusions.push({ site: source(job), ids: [id] });
  }
  // Deleting an item in any keyword removes the same source item everywhere.
  for (const current of task?.jobs || [job]) {
    if (source(current) !== source(job)) continue;
    const before = current.groups.length;
    current.groups = current.groups.filter(group => productId(group.best?.id) !== id);
    current.exclusions ||= [];
    if (!current.exclusions.some(group => group.ids?.some(value => productId(value) === id))) current.exclusions.push({ ids: [id] });
    if (before === current.groups.length) continue;
    current.refillRequested = true;
    current.detailDone = current.groups.filter(g => ['done', 'partial', 'error'].includes(g.best?.detailStatus)).length;
  }
  return true;
}
export function prepareRefill(job) {
  if (!job.refillRequested) return false;
  const preserveSearch = source(job) === 'pdd';
  if (!preserveSearch) {
    job.scanned = 0; job.skipped = 0; job.lastSkip = '';
    job.merged = 0; job.excluded = 0; job.skipReasons = {};
    job.statsStart = 0; job.statsStartSkipped = 0;
  }
  job.searchStatus = '';
  delete job.paginationFromKeys;
  job.phase = 'search'; job.status = 'pending'; job.refillRequested = false;
  job.restartSearch = !preserveSearch;
  for (const group of job.groups) group.retained = true;
  job.note = '已删除不需要的商品，正在补齐数量';
  return true;
}
