import { addKeyword, enqueueKeyword, normalizeLimit, normalizePriceCents, outputLimit, retryJob, selected, recoverTask, STATUS } from './lib/core.mjs';
import { Runner } from './lib/runner.mjs';
import { browserPorts, closeTaskDetailTab } from './lib/browser.mjs';
import { taskSheets, workbookBytes } from './lib/xlsx.mjs';
import { resolveSite, sourceOrigin } from './lib/sites.mjs';
import { productImage, removeProduct, prepareRefill } from './lib/products.mjs';
import { createRefillScheduler } from './lib/refill.mjs';
import { createConversionPanel } from './conversion-ui.mjs';
import { mergeImageReplacements } from './lib/image-conversion.mjs';
import { duplicateItems, restoreDuplicate } from './lib/product-dedup.mjs';

const $ = id => document.getElementById(id);
const installed = Boolean(globalThis.chrome?.runtime?.id);
const storage = installed ? chrome.storage.local : {
  async get(keys) { return Object.fromEntries(keys.map(key => [key, JSON.parse(localStorage.getItem(`pdd-preview-${key}`) || 'null')])); },
  async set(values) { for (const [key, value] of Object.entries(values)) localStorage.setItem(`pdd-preview-${key}`, JSON.stringify(value)); }
};
let keywords = [], task = null, runner = null, busy = false, lockedOut = false, clearing = false, pendingResume = null, activeRun = null, exporting = false;
let keywordWrites = Promise.resolve(), taskWrites = Promise.resolve();
let refillAuto = false, refillWaiting = false;
let currentProductTabs = [], refreshingTabs = false;
const conversion = createConversionPanel({
  document, extensionId: globalThis.chrome?.runtime?.id,
  getCollection: () => ({ task, collecting: busy || refillWaiting || Boolean(activeRun), unavailable: lockedOut || clearing }),
  onReplacements: async (sourceTaskId, refs) => {
    if (lockedOut || clearing || task?.id !== sourceTaskId) return;
    const current=task, candidate=structuredClone(current);
    mergeImageReplacements(candidate,refs);
    await saveTask(candidate);
    if (!clearing && task===current) {
      mergeImageReplacements(current,refs);
      // A deletion or collection save may have queued an older mapping while
      // the first write was pending. Persist the current products after it.
      if (JSON.stringify(current)!==JSON.stringify(candidate)) await saveTask(current);
    }
  }
});
const refillScheduler = createRefillScheduler({
  settle: async () => { if (activeRun) await activeRun.catch(() => {}); },
  flush: async isCurrent => {
    if (!isCurrent() || clearing || lockedOut || busy || !task) return;
    const auto = refillAuto && task.status !== 'blocked';
    prepareRequestedRefills(!auto);
    if (auto) task.status = 'pending';
    await saveTask(task);
    if (!isCurrent() || clearing) return;
    refillAuto = false; refillWaiting = false; renderTask();
    if (auto && canAutoRun()) void execute();
  },
  onError: error => {
    refillAuto = false; refillWaiting = false;
    if (task && !clearing) {
      task.status = 'paused';
      for (const job of task.jobs) if (job.status === 'pending') job.status = 'paused';
    }
    notice(`补搜准备失败：${error.message}，当前结果仍可导出，请点击继续。`, 'error'); renderTask();
  }
});
function prepareRequestedRefills(hold = false) {
  for (const job of task?.jobs || []) if (prepareRefill(job) && hold) {
    job.status = task.status === 'blocked' ? 'blocked' : 'paused';
    if (task.status === 'stopped') task.status = 'paused';
  }
}
function cancelRefill() {
  refillScheduler.cancel(); refillAuto = false; refillWaiting = false;
}
function notice(message, type = '') { $('notice').textContent = message; $('notice').className = `notice ${type}`; $('notice').hidden = !message; }
function element(tag, value, className = '') { const el = document.createElement(tag); el.textContent = value; el.className = className; return el; }
function persistKeywords() {
  const snapshot = [...keywords];
  keywordWrites = keywordWrites.catch(() => {}).then(() => storage.set({ keywords: snapshot }));
  return keywordWrites;
}
function renderKeywords() {
  $('keyword-count').textContent = `${keywords.length} 个`;
  $('keyword-empty').hidden = Boolean(keywords.length);
  $('keyword-list').replaceChildren(...keywords.map((keyword, index) => {
    const li = document.createElement('li'), remove = element('button', '×');
    remove.type = 'button'; remove.title = `删除 ${keyword}`; remove.setAttribute('aria-label', `删除 ${keyword}`);
    remove.disabled = lockedOut || clearing;
    remove.addEventListener('click', async () => {
      if (lockedOut || clearing) return;
      keywords = keywords.filter(k => k !== keyword); renderKeywords(); renderTask();
      try { await persistKeywords(); } catch (error) { notice(`清单保存失败：${error.message}`, 'error'); }
    });
    li.append(element('span', String(index + 1).padStart(2, '0'), 'index'), element('span', keyword, 'keyword'), remove);
    return li;
  }));
}
function badge(status) { return element('span', STATUS[status] || status, `badge ${status}`); }
const DETAIL_LABEL = { pending: '等待', running: '采集中', done: '完整', partial: '部分', error: '失败' };
function detailCounts(items) {
  return {
    complete: items.filter(item => item.detailStatus === 'done').length,
    partial: items.filter(item => item.detailStatus === 'partial').length,
    errors: items.filter(item => item.detailStatus === 'error').length
  };
}
function scanSummary(job) {
  if (job.merged == null && !job.skipReasons) return '';
  const reasons=Object.entries(job.skipReasons || {}).map(([name,count])=>`${name} ${count}`).join('、');
  const start=job.statsStart ? `此前 ${job.statsStart} 条未记录分类；以下为恢复后的统计：` : '';
  const skips=Math.max(0,(job.skipped || 0)-(job.statsStartSkipped || 0));
  return `${start}按商品 ID 去重${job.imageDedup ? ` · 主图重复 ${duplicateItems(job).length} 条` : ''} · 识别跳过 ${skips} 条${reasons ? `（${reasons}）` : ''}${job.imageDedupFailures ? ` · 未完成主图去重 ${job.imageDedupFailures} 条` : ''}${job.excluded ? ` · 已删除商品排除 ${job.excluded} 条` : ''}`;
}
function renderTask() {
  const jobs = task?.jobs || [];
  $('current-product-refresh').disabled = !installed || lockedOut || clearing || busy || refreshingTabs;
  $('collect-current-product').disabled = !installed || lockedOut || clearing || busy || refreshingTabs || !currentProductTabs.length;
  const done = jobs.filter(j => ['done', 'short', 'error', 'stopped'].includes(j.status)).length;
  const totalLinks = jobs.reduce((sum, job) => sum + selected(job).length, 0);
  const percent = jobs.length ? Math.floor(done / jobs.length * 100) : 0;
  const active = jobs.find(j => ['running', 'blocked', 'paused'].includes(j.status));
  const resumable = task && ['paused', 'blocked'].includes(task.status) && !busy;
  $('stat-keywords').replaceChildren(String(task ? jobs.length : keywords.length), element('small', '个'));
  $('stat-done').replaceChildren(String(done), element('small', '个'));
  $('stat-links').replaceChildren(String(totalLinks), element('small', '条'));
  $('task-title').textContent = active ? (active.phase === 'detail' ? `正在补全详情 · ${active.keyword}` : `正在处理 · ${active.keyword}`) : (task ? '本次采集' : '准备开始');
  $('task-badge').textContent = task ? (task.status === 'done' && jobs.some(j => j.status === 'short') ? '已结束 · 部分数量不足' : STATUS[task.status] || task.status) : '未开始';
  $('task-badge').className = `badge ${task?.status || ''}`;
  $('progress-label').textContent = task ? `已处理 ${done} / ${jobs.length} 个商品名称` : '添加商品名称后自动搜索';
  $('progress-percent').textContent = `${percent}%`; $('progress').value = percent;
  const activeItems = active ? selected(active) : [];
  const activeDetails = detailCounts(activeItems);
  $('current-detail').textContent = runner?.cooling ? '商品已处理，等待下一件（间隔 3 秒）' : active
    ? active.phase === 'detail'
      ? `正在补全详情 ${active.detailDone || 0} / ${activeItems.length} · 完整 ${activeDetails.complete} · 部分 ${activeDetails.partial} · 失败 ${activeDetails.errors}`
      : `已扫描 ${active.scanned} / 200 条 · 保留 ${activeItems.length} / ${outputLimit(active)} 条${active.note ? ` · ${active.note}` : ''}${scanSummary(active) ? ` · ${scanSummary(active)}` : ''}`
    : (task?.status === 'error' ? '部分任务失败，已保留采集结果；请查看每行说明。' : '每个名称收集到设定数量即切换；最多扫描 200 条。');
  $('add-button').disabled = lockedOut || clearing;
  $('clear-all').disabled = lockedOut || clearing || (!keywords.length && !task);
  $('pause').disabled = !(busy || refillWaiting) || (Boolean(runner?.intent) && !refillWaiting); $('pause').hidden = Boolean(resumable);
  $('resume').hidden = !resumable;
  $('resume').disabled = lockedOut || !installed;
  $('resume').textContent = '继续';
  $('stop').disabled = lockedOut || !(busy || resumable || refillWaiting);
  $('show-tab').hidden = !Number.isInteger(task?.detailTabId) && !Number.isInteger(task?.tabId);
  $('export').disabled = lockedOut || !task || exporting;
  $('results-empty').hidden = Boolean(jobs.length); $('result-table-wrap').hidden = !jobs.length;
  $('result-rows').replaceChildren(...jobs.map((job, index) => {
    const row = document.createElement('tr'), status = document.createElement('td'); status.append(badge(job.status));
    const action = document.createElement('td');
    if (['done', 'short', 'error', 'stopped'].includes(job.status)) {
      const retry = element('button', job.sourceMode === 'current' ? '重新读取当前商品' : '重新搜索', 'text-button');
      retry.type = 'button'; retry.dataset.retryJob = String(index); retry.disabled = busy || lockedOut || clearing;
      retry.title = '替换此名称的旧结果，其他名称保留';
      retry.addEventListener('click', async () => {
        if (busy || lockedOut || clearing) return;
        retryJob(task, index); renderTask();
        try { await saveTask(task); if (job.sourceMode === 'current') await execute(task.jobs[index]); else if (canAutoRun()) await execute(); }
        catch (error) { notice(`重新搜索失败：${error.message}`, 'error'); }
      });
      action.append(retry);
    }
    const items = selected(job);
    const counts = detailCounts(items);
    const detailSummary = counts.complete || counts.partial || counts.errors
      ? `详情完整 ${counts.complete} 个 · 部分 ${counts.partial} 个 · 失败 ${counts.errors} 个`
      : '';
    const explanation = [job.note || (['done', 'short', 'error', 'stopped'].includes(job.status) ? detailSummary : ''),scanSummary(job)].filter(Boolean).join('；') || '—';
    row.append(element('td', job.keyword), status, element('td', String(job.scanned)), element('td', `${items.length}/${outputLimit(job)}`), element('td', explanation, 'note'), action);
    return row;
  }));
  $('links-panel').hidden = !totalLinks; $('links-count').textContent = `${totalLinks} 条`;
  const duplicates = jobs.reduce((sum,job) => sum + duplicateItems(job).length,0);
  $('duplicates-panel').hidden = !duplicates; $('duplicates-count').textContent = `${duplicates} 条`;
  if ($('duplicates-panel').open) renderDuplicates();
  // Avoid constructing every hyperlink on every checkpoint while collapsed.
  if ($('links-panel').open) renderLinks();
  conversion.refresh();
}
function renderDuplicates() {
  $('duplicate-items').replaceChildren(...(task?.jobs || []).flatMap(job => duplicateItems(job).map(({item,representative}) => {
    const card = element('div','','duplicate-preview');
    for (const product of [representative,item]) {
      const column = element('div'), image = document.createElement('img'), label = element('p',`${product === representative ? '已保留' : '重复项'} · ${product.title}`);
      image.src = product.originalListImage || productImage(product); image.alt = product.title || '原始主图'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      const link = element('a','打开商品 ↗');link.href = product.url;link.target = '_blank';link.rel = 'noopener noreferrer';
      column.append(image,label,element('p',Number.isSafeInteger(product.cents) && product.cents > 0 ? `¥${(product.cents/100).toFixed(2)}` : '未读取到价格'),link);
      card.append(column);
    }
    const restore = element('button','保留为独立商品','button');restore.type = 'button';restore.dataset.restoreDuplicate = item.id;
    restore.disabled = busy || lockedOut || clearing;
    restore.addEventListener('click',async () => {
      if (busy || lockedOut || clearing || !task?.jobs.includes(job) || !restoreDuplicate(job,item.id)) return;
      renderTask();
      try { await saveTask(task);notice(`已恢复「${item.title}」为独立商品，保留其自己的 SKU 和图片链接；恢复后可能超过设定数量。`,'success'); }
      catch(error) {notice(`恢复保存失败：${error.message}`,'error');}
    });
    card.append(element('p',job.keyword,'muted'),restore);return card;
  })));
}
function renderLinks() {
  $('link-rows').replaceChildren(...(task?.jobs || []).flatMap(job => selected(job).map(item => {
    const row = document.createElement('tr'), linkCell = document.createElement('td'), a = element('a', '打开商品 ↗');
    a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; linkCell.append(a);
    const status = DETAIL_LABEL[item.detailStatus] || '等待';
    const note = item.detailNote || (item.detailStatus === 'done' ? '详情字段已采集' : '—');
    const imageCell = document.createElement('td'), imageUrl = productImage(item);
    imageCell.className = 'product-preview-cell';
    const placeholder = () => imageCell.replaceChildren(element('span', '暂无图片', 'product-image-empty'));
    if (imageUrl) {
      const img = document.createElement('img');
      img.alt = item.title || '商品主图'; img.className = 'product-preview';
      img.width = 72; img.height = 72; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', placeholder, { once: true }); img.src = imageUrl; imageCell.append(img);
    } else placeholder();
    const action = document.createElement('td'), remove = element('button', '×', 'remove-product');
    remove.type = 'button'; remove.dataset.removeProduct = item.id;
    remove.title = `删除 ${item.title}，自动补齐`; remove.setAttribute('aria-label', `删除 ${item.title}`);
    remove.disabled = lockedOut || clearing;
    remove.addEventListener('click', () => {
      if (lockedOut || clearing || !task?.jobs.includes(job) || !removeProduct(job, item.id, task)) return;
      void conversion.removeProduct(task.id, item.site || job.site || 'pdd', item.id);
      const mayRestart = busy ? Boolean(runner && (!runner.intent || refillAuto)) : !['paused', 'blocked', 'stopped'].includes(task.status);
      refillAuto ||= mayRestart;
      refillWaiting = true;
      runner?.pauseForRefill();
      renderTask(); renderLinks();
      notice(refillAuto ? '已删除商品，稍后自动补齐；连续删除会合并处理。' : '已删除商品；处理当前提示后点击“继续”补齐。');
      void saveTask(task).catch(error => notice(`删除保存失败：${error.message}`, 'error'));
      refillScheduler.schedule();
    });
    action.append(remove);
    if (['partial','error'].includes(item.detailStatus)) {
      const retry = element('button', '补采未完成详情', 'text-button');
      retry.type = 'button'; retry.dataset.retryDetail = item.id; retry.disabled = busy || lockedOut || clearing;
      retry.addEventListener('click', async () => {
        if (busy || lockedOut || clearing || !task?.jobs.includes(job) || !selected(job).includes(item)) return;
        item.detailStatus = 'pending'; item.detailNote = ''; job.phase = 'detail'; job.status = 'paused';
        try { await saveTask(task); if (!clearing) await execute(job); }
        catch (error) { notice(`补采失败：${error.message}`, 'error'); }
      });
      action.append(retry);
    }
    row.append(element('td', job.keyword), imageCell, element('td', item.title), element('td', Number.isSafeInteger(item.cents) && item.cents > 0 ? `¥${(item.cents / 100).toFixed(2)}` : '未读取到价格'),
      element('td', status), element('td', note, 'note'), linkCell, action); return row;
  })));
}
function saveTask(current) {
  const snapshot = structuredClone(current);
  taskWrites = taskWrites.catch(() => {}).then(() => storage.set({ task: snapshot }));
  return taskWrites;
}
function canAutoRun() {
  return installed && !lockedOut && !clearing && !busy && !refillWaiting && task?.jobs.some(job => job.status === 'pending') && !['paused', 'blocked'].includes(task.status);
}
async function execute(onlyJob = null) {
  cancelRefill(); prepareRequestedRefills();
  busy = true;
  runner = new Runner(task, browserPorts({ save: saveTask, update: renderTask }));
  renderTask(); notice('');
  const running = runner.run(onlyJob); activeRun = running;
  try {
    await running;
    if (task.status === 'blocked') notice(task.jobs.find(j => j.status === 'blocked')?.note || '请处理页面后继续');
    else if (task.status === 'done') notice('采集已结束，可以按模板导出 Excel。数量不足的名称请在采集结果表中查看。', 'success');
    else if (task.status === 'error') notice('部分名称采集失败，已有结果仍可导出。请查看每行说明。', 'error');
  } catch (error) {
    task.status = 'paused';
    for (const job of task.jobs) if (job.status === 'running') job.status = 'paused';
    notice(`任务暂停：${error.message}。当前结果仍可导出。`, 'error');
    try { await saveTask(task); } catch { /* The in-memory result remains exportable even when storage is full. */ }
  } finally {
    if (activeRun === running) activeRun = null;
    busy = false; runner = null; renderTask();
    if (canAutoRun()) queueMicrotask(() => { if (canAutoRun()) void execute(); });
  }
}
function collectSettings() {
  const limit = normalizeLimit($('target-count').value);
  if (!limit) { notice('采集数量请填写 1 到 200 的整数。', 'error'); return null; }
  const minText = $('price-min').value.trim();
  const maxText = $('price-max').value.trim();
  const priceMin = minText ? normalizePriceCents(minText) : null;
  const priceMax = maxText ? normalizePriceCents(maxText) : null;
  if ((minText && priceMin == null) || (maxText && priceMax == null)) {
    notice('价格请填写大于 0 的数字，最多两位小数。', 'error');
    return null;
  }
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    notice('最低价不能高于最高价。', 'error');
    return null;
  }
  const interval = Number($('taobao-detail-interval').value);
  if (!Number.isInteger(interval) || interval < 10 || interval > 3600) {
    notice('淘宝访问间隔请填写 10～3600 秒之间的整数。', 'error');
    return null;
  }
  return { limit, priceMin, priceMax, imageDedup: $('image-dedup').checked, taobaoDetailIntervalMs: interval * 1000 };
}
function persistCollectSettings() {
  void storage.set({
    targetCount: $('target-count').value.trim(),
    priceMin: $('price-min').value.trim(),
    priceMax: $('price-max').value.trim()
    , imageDedup: $('image-dedup').checked, taobaoDetailInterval: $('taobao-detail-interval').value
  });
}
function currentSite() {
  const site = resolveSite($('source-url').value);
  if (!site?.supported) {
    notice('这个网址还不能采集。请填写拼多多、1688 或淘宝的网址。', 'error');
    return null;
  }
  return site;
}
$('source-url').addEventListener('change', () => {
  const site = currentSite();
  if (!site) return;
  notice(`接下来的商品名称会在${site.label}搜索。`, 'success');
  void storage.set({ sourceUrl: $('source-url').value.trim() });
});
for (const id of ['target-count', 'price-min', 'price-max', 'image-dedup', 'taobao-detail-interval']) $(id).addEventListener('change', persistCollectSettings);
$('current-product-refresh').addEventListener('click', async () => {
  if (!installed || busy || clearing || lockedOut || refreshingTabs) return;
  refreshingTabs = true; renderTask();
  try {
    currentProductTabs = await browserPorts({ save:saveTask, update:renderTask }).listCurrentTabs();
    const options = currentProductTabs.map(tab => { const option = element('option', tab.title || tab.url); option.value = String(tab.id); return option; });
    $('current-product-tab').replaceChildren(...options);
    if (options.length) options[0].selected = true;
    $('current-product-note').textContent = options.length ? `找到 ${options.length} 个商品标签页。` : '没有找到淘宝／天猫商品页，请先手动打开商品。';
  } catch (error) { currentProductTabs = []; $('current-product-note').textContent = error.message; }
  finally { refreshingTabs = false; renderTask(); }
});
$('collect-current-product').addEventListener('click', async () => {
  if (!installed || busy || clearing || lockedOut || refreshingTabs) return;
  const tab = currentProductTabs.find(tab => String(tab.id) === $('current-product-tab').value);
  if (!tab) return;
  const settings = collectSettings(); if (!settings) return;
  const keyword = `当前商品 · ${tab.title || tab.id}`;
  task = enqueueKeyword(task, keyword, 'taobao', { ...settings, limit:1, sourceMode:'current', sourceTabId:tab.id, sourceProductId:resolveSite(tab.url).productId(tab.url) });
  const job = task.jobs.at(-1); job.sourceMode = 'current'; job.sourceTabId = tab.id; job.sourceProductId = resolveSite(tab.url).productId(tab.url);
  // Explicit manual capture runs only this job; the paused search queue stays paused.
  job.manualOnly = true;
  if (!keywords.includes(keyword)) keywords.push(keyword);
  renderKeywords(); renderTask();
  try {
    await persistKeywords(); await saveTask(task);
    if (!clearing) await execute(job);
  } catch (error) { notice(`当前商品采集失败：${error.message}`, 'error'); }
});
$('add-form').addEventListener('submit', async event => {
  event.preventDefault(); if (lockedOut || clearing) return;
  const site = currentSite();
  if (!site) return;
  const settings = collectSettings();
  if (!settings) return;
  if (!addKeyword(keywords, $('keyword-input').value)) { notice('请输入新的商品名称，空白或重复名称不会添加。'); return; }
  task = enqueueKeyword(task, keywords.at(-1), site.id, { ...settings, sourceOrigin: sourceOrigin($('source-url').value) });
  persistCollectSettings();
  void storage.set({ sourceUrl: $('source-url').value.trim() });
  $('keyword-input').value = ''; $('keyword-input').focus(); renderKeywords(); renderTask();
  try {
    await persistKeywords();
    if (clearing) return;
    await saveTask(task);
    if (canAutoRun()) await execute();
    else if (['paused', 'blocked'].includes(task.status)) notice('已加入队列。当前采集已暂停，请处理提示后点击“继续”。');
    else if (busy) notice('已加入队列，当前名称完成后自动搜索。');
  } catch (error) { notice(`清单保存失败：${error.message}`, 'error'); }
});
$('clear-all').addEventListener('click', async () => {
  if (lockedOut || clearing || (!keywords.length && !task)) return;
  clearing = true;
  // Invalidate conversion callbacks synchronously, before awaiting collection cleanup.
  void conversion.clear();
  cancelRefill();
  runner?.stop();
  if (pendingResume) { pendingResume.cancelled = true; pendingResume = null; }
  notice('正在停止搜索并清空本机数据…'); renderKeywords(); renderTask();
  try {
    if (activeRun) await activeRun.catch(() => {});
    await closeTaskDetailTab(task);
    await Promise.allSettled([keywordWrites, taskWrites]);
    await storage.set({ keywords: [], task: null });
    keywords = []; task = null; busy = false; runner = null;
    $('keyword-input').value = ''; $('link-rows').replaceChildren();
    notice('已清空商品名称、搜索进度和结果。', 'success');
  } catch (error) { notice(`清空失败：${error.message}`, 'error'); }
  finally { clearing = false; renderKeywords(); renderTask(); }
});
$('pause').addEventListener('click', async () => {
  cancelRefill(); runner?.pause();
  if (!busy && task) {
    task.status = 'paused'; prepareRequestedRefills(true);
    try { await saveTask(task); } catch (error) { notice(error.message, 'error'); }
  }
  notice('正在暂停，当前页面操作完成后会保存进度。'); renderTask();
});
$('resume').addEventListener('click', async () => {
  if (!task || busy || lockedOut) return;
  const current = task, request = { cancelled: false };
  pendingResume = request; busy = true; renderTask();
  try {
    if (request.cancelled || task !== current) return;
    pendingResume = null;
    await execute();
  } catch (error) { if (!request.cancelled && task === current) notice(error.message, 'error'); }
  finally {
    if (pendingResume === request && !request.cancelled) {
      pendingResume = null; busy = false; renderTask();
    }
  }
});
$('stop').addEventListener('click', async () => {
  cancelRefill();
  if (pendingResume) {
    const request = pendingResume, current = task;
    request.cancelled = true;
    current.status = 'stopped';
    for (const job of current.jobs) if (['pending', 'paused', 'blocked', 'running'].includes(job.status)) job.status = 'stopped';
    notice('已停止，已采集结果可以导出。');
    try { await closeTaskDetailTab(current); await saveTask(current); } catch (error) { notice(error.message, 'error'); }
    finally { if (pendingResume === request) { pendingResume = null; busy = false; } }
  }
  else if (busy) { runner?.stop(); notice('正在停止，已采集结果可以导出。'); }
  else if (task) {
    task.status = 'stopped'; for (const job of task.jobs) if (['pending', 'paused', 'blocked', 'running'].includes(job.status)) job.status = 'stopped';
    try { await closeTaskDetailTab(task); await saveTask(task); } catch (error) { notice(error.message, 'error'); }
  }
  renderTask();
});
$('show-tab').addEventListener('click', async () => {
  try {
    const targetTabId = Number.isInteger(task?.detailTabId) ? task.detailTabId : task?.tabId;
    const tab = await chrome.tabs.update(targetTabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
  }
  catch { notice('采集页已经关闭。点击继续可重新打开。'); }
});
$('export').addEventListener('click', async () => {
  if (!task || exporting) return;
  exporting = true;
  const button = $('export');
  button.disabled = true;
  button.textContent = '正在生成…';
  notice('正在生成 Excel…');
  try {
    const snapshot = structuredClone(task);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sheets = taskSheets(snapshot);
    const { replaced, fallback } = sheets[0].imageReplacementCounts;
    const bytes = workbookBytes(sheets);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const filename = `拼多多商品链接_${new Date().toISOString().slice(0, 10)}.xlsx`;
    try {
      if (installed) await chrome.downloads.download({ url, filename, saveAs: false });
      else { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }
      notice(`已开始下载「${filename}」：已替换 ${replaced} 个图片位置，原图回退 ${fallback} 个。请打开浏览器右上角的下载列表。`, 'success');
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (error) { notice(`导出失败：${error.message}`, 'error'); }
  finally { exporting = false; button.textContent = '↓ 导出 Excel'; renderTask(); }
});
$('links-panel').addEventListener('toggle', () => { if ($('links-panel').open) renderLinks(); });
$('duplicates-panel').addEventListener('toggle', () => { if ($('duplicates-panel').open) renderDuplicates(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => conversion.dispose());

async function initialize() {
  const saved = await storage.get(['keywords', 'task', 'sourceUrl', 'targetCount', 'priceMin', 'priceMax', 'imageDedup', 'taobaoDetailInterval']);
  $('image-dedup').checked = saved.imageDedup !== false;
  if (Number.isInteger(Number(saved.taobaoDetailInterval)) && Number(saved.taobaoDetailInterval) >= 10 && Number(saved.taobaoDetailInterval) <= 3600) $('taobao-detail-interval').value = String(saved.taobaoDetailInterval);
  keywords = Array.isArray(saved.keywords) ? saved.keywords.filter(k => typeof k === 'string' && k.trim()) : [];
  if (typeof saved.sourceUrl === 'string' && saved.sourceUrl.trim()) $('source-url').value = saved.sourceUrl;
  if (normalizeLimit(saved.targetCount)) $('target-count').value = String(normalizeLimit(saved.targetCount));
  if (typeof saved.priceMin === 'string') $('price-min').value = saved.priceMin;
  if (typeof saved.priceMax === 'string') $('price-max').value = saved.priceMax;
  task = recoverTask(saved.task);
  if (task) await saveTask(task);
  // Match the restored owned batch to loaded collection before polling it.
  void conversion.recover(task);
  renderKeywords(); renderTask();
  if (!installed) notice('界面预览：名称可以添加和保存。实际采集需将 extension 文件夹加载为 Chrome 扩展。');
  else if (task?.status === 'paused') notice('已恢复上次保存的进度，点击“继续”恢复采集。');
}
// An origin-wide lock prevents two management tabs from processing the same queue.
navigator.locks.request('pdd-collector-manager', { ifAvailable: true }, async lock => {
  if (!lock) { lockedOut = true; renderTask(); $('add-button').disabled = true; notice('已有一个管理页打开，请回到该页面操作。', 'error'); return; }
  try { await initialize(); } catch (error) { notice(`读取本地数据失败：${error.message}`, 'error'); }
  await new Promise(() => {});
}).catch(error => notice(`无法获取任务锁：${error.message}`, 'error'));
