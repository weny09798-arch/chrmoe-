import { addKeyword, enqueueKeyword, normalizeLimit, normalizePriceCents, outputLimit, retryJob, selected, recoverTask, STATUS } from './lib/core.mjs';
import { Runner } from './lib/runner.mjs';
import { browserPorts, closeTaskDetailTab } from './lib/browser.mjs';
import { taskSheets, workbookBytes } from './lib/xlsx.mjs';
import { resolveSite } from './lib/sites.mjs';
import { productImage, removeProduct, prepareRefill } from './lib/products.mjs';
import { createRefillScheduler } from './lib/refill.mjs';

const $ = id => document.getElementById(id);
const installed = Boolean(globalThis.chrome?.runtime?.id);
const storage = installed ? chrome.storage.local : {
  async get(keys) { return Object.fromEntries(keys.map(key => [key, JSON.parse(localStorage.getItem(`pdd-preview-${key}`) || 'null')])); },
  async set(values) { for (const [key, value] of Object.entries(values)) localStorage.setItem(`pdd-preview-${key}`, JSON.stringify(value)); }
};
let keywords = [], task = null, runner = null, busy = false, lockedOut = false, clearing = false, pendingResume = null, activeRun = null, exporting = false;
let keywordWrites = Promise.resolve(), taskWrites = Promise.resolve();
let refillAuto = false, refillWaiting = false;
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
function renderTask() {
  const jobs = task?.jobs || [];
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
  $('current-detail').textContent = active
    ? active.phase === 'detail'
      ? `正在补全详情 ${active.detailDone || 0} / ${activeItems.length} · 完整 ${activeDetails.complete} · 部分 ${activeDetails.partial} · 失败 ${activeDetails.errors}`
      : `已扫描 ${active.scanned} / 200 条 · ${active.groups.length} 组主图 · 保留 ${activeItems.length} / ${outputLimit(active)} 条${active.note ? ` · ${active.note}` : ''}`
    : (task?.status === 'error' ? '部分任务失败，已保留采集结果；请查看每行说明。' : '每个名称收集到设定数量即切换；最多扫描 200 条。');
  $('add-button').disabled = lockedOut || clearing;
  $('clear-all').disabled = lockedOut || clearing || (!keywords.length && !task);
  $('pause').disabled = !(busy || refillWaiting) || (Boolean(runner?.intent) && !refillWaiting); $('pause').hidden = Boolean(resumable);
  $('resume').hidden = !resumable;
  $('resume').disabled = lockedOut || !installed;
  $('resume').textContent = task?.permissionOrigin ? '授权图片并继续' : '继续';
  $('stop').disabled = lockedOut || !(busy || resumable || refillWaiting);
  $('show-tab').hidden = !Number.isInteger(task?.detailTabId) && !Number.isInteger(task?.tabId);
  $('export').disabled = lockedOut || !task || exporting;
  $('results-empty').hidden = Boolean(jobs.length); $('result-table-wrap').hidden = !jobs.length;
  $('result-rows').replaceChildren(...jobs.map((job, index) => {
    const row = document.createElement('tr'), status = document.createElement('td'); status.append(badge(job.status));
    const action = document.createElement('td');
    if (['done', 'short', 'error', 'stopped'].includes(job.status)) {
      const retry = element('button', '重新搜索', 'text-button');
      retry.type = 'button'; retry.dataset.retryJob = String(index); retry.disabled = busy || lockedOut || clearing;
      retry.title = '替换此名称的旧结果，其他名称保留';
      retry.addEventListener('click', async () => {
        if (busy || lockedOut || clearing) return;
        retryJob(task, index); renderTask();
        try { await saveTask(task); if (canAutoRun()) await execute(); }
        catch (error) { notice(`重新搜索失败：${error.message}`, 'error'); }
      });
      action.append(retry);
    }
    const items = selected(job);
    const counts = detailCounts(items);
    const detailSummary = counts.complete || counts.partial || counts.errors
      ? `详情完整 ${counts.complete} 个 · 部分 ${counts.partial} 个 · 失败 ${counts.errors} 个`
      : '';
    const explanation = job.note || (job.skipped ? `已跳过 ${job.skipped} 条` : (['done', 'short', 'error', 'stopped'].includes(job.status) ? detailSummary || '—' : '—'));
    row.append(element('td', job.keyword), status, element('td', String(job.scanned)), element('td', `${items.length}/${outputLimit(job)}`), element('td', explanation, 'note'), action);
    return row;
  }));
  $('links-panel').hidden = !totalLinks; $('links-count').textContent = `${totalLinks} 条`;
  // Avoid constructing every hyperlink on every checkpoint while collapsed.
  if ($('links-panel').open) renderLinks();
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
      if (lockedOut || clearing || !task?.jobs.includes(job) || !removeProduct(job, item.id)) return;
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
    row.append(element('td', job.keyword), imageCell, element('td', item.title), element('td', `¥${(item.cents / 100).toFixed(2)}`),
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
async function execute() {
  cancelRefill(); prepareRequestedRefills();
  busy = true;
  runner = new Runner(task, browserPorts({ save: saveTask, update: renderTask }));
  renderTask(); notice('');
  const running = runner.run(); activeRun = running;
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
  return { limit, priceMin, priceMax };
}
function persistCollectSettings() {
  void storage.set({
    targetCount: $('target-count').value.trim(),
    priceMin: $('price-min').value.trim(),
    priceMax: $('price-max').value.trim()
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
for (const id of ['target-count', 'price-min', 'price-max']) $(id).addEventListener('change', persistCollectSettings);
$('add-form').addEventListener('submit', async event => {
  event.preventDefault(); if (lockedOut || clearing) return;
  const site = currentSite();
  if (!site) return;
  const settings = collectSettings();
  if (!settings) return;
  if (!addKeyword(keywords, $('keyword-input').value)) { notice('请输入新的商品名称，空白或重复名称不会添加。'); return; }
  task = enqueueKeyword(task, keywords.at(-1), site.id, settings);
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
    if (current.permissionOrigin) {
      const granted = await chrome.permissions.request({ origins: [current.permissionOrigin] });
      if (request.cancelled || task !== current) return;
      if (!granted) { notice('未获得主图读取权限，任务仍保持暂停。'); return; }
      current.permissionOrigin = '';
    }
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
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sheets = taskSheets(task);
    const bytes = workbookBytes(sheets);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const filename = `拼多多商品链接_${new Date().toISOString().slice(0, 10)}.xlsx`;
    try {
      if (installed) await chrome.downloads.download({ url, filename, saveAs: false });
      else { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }
      notice(`已开始下载「${filename}」。请打开浏览器右上角的下载列表。这次固定为 .xlsx，避免旧版 .xls 把页面撑到内存不足。`, 'success');
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (error) { notice(`导出失败：${error.message}`, 'error'); }
  finally { exporting = false; button.textContent = '↓ 导出 Excel'; renderTask(); }
});
$('links-panel').addEventListener('toggle', () => { if ($('links-panel').open) renderLinks(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

async function initialize() {
  const saved = await storage.get(['keywords', 'task', 'sourceUrl', 'targetCount', 'priceMin', 'priceMax']);
  keywords = Array.isArray(saved.keywords) ? saved.keywords.filter(k => typeof k === 'string' && k.trim()) : [];
  if (typeof saved.sourceUrl === 'string' && saved.sourceUrl.trim()) $('source-url').value = saved.sourceUrl;
  if (normalizeLimit(saved.targetCount)) $('target-count').value = String(normalizeLimit(saved.targetCount));
  if (typeof saved.priceMin === 'string') $('price-min').value = saved.priceMin;
  if (typeof saved.priceMax === 'string') $('price-max').value = saved.priceMax;
  task = recoverTask(saved.task);
  if (task) await saveTask(task);
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
