import { BridgeClient, ConversionController, buildImageManifest, imagePositionKey, matchingImageReplacements } from './lib/image-conversion.mjs';

const STATUS = { recovering:'正在恢复本批进度', running:'转换中', queued:'等待', pending:'等待', paused:'已暂停', stopped:'已停止', blocked:'等待处理', 'needs-review':'请检查结果', completed:'本批已结束', done:'本批已结束', failed:'失败' };
const PHASE = { downloading:'正在下载原图', ready:'原图就绪', submitting:'正在提交', pending:'等待生成结果', saving:'正在保存结果', uploading:'正在上传 OSS', 'upload-failed':'OSS 上传失败，导出保留原图', alias:'复用相同图片', done:'已完成', 'download-failed':'原图下载失败', uncertain:'请检查生成结果', 'aliyun-ready':'等待阿里云翻译', 'aliyun-downloading':'正在下载阿里云结果', 'aliyun-failed':'阿里云翻译失败，重新生成可能再次计费' };
const KIND = { main:'主图', detail:'详情图', sku:'SKU 图' };
function retryLabel(item, provider) {
  if (!item || ['completed','needs-review'].includes(item.status) || item.phase === 'uncertain') return '';
  if (provider === 'aliyun' && ['submitting','aliyun-failed'].includes(item.phase)) return '';
  if (provider === 'aliyun' && item.phase === 'aliyun-downloading') return '重试获取已有结果';
  if (item.phase === 'download-failed' || (item.status === 'failed' && !item.input_path)) return '重试下载';
  if (['pending','saving'].includes(item.phase)) return '继续获取此图';
  if (['ready','downloading','aliyun-ready'].includes(item.phase)) return '继续处理此图';
  return '';
}

export function createConversionPanel({ document, extensionId, getCollection, onReplacements = async () => {}, storage = globalThis.sessionStorage, fetch = globalThis.fetch?.bind(globalThis), setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, confirm = text => globalThis.confirm?.(text) === true } = {}) {
  const $ = id => document.getElementById(id);
  const node = (tag, text, className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
  const client = new BridgeClient({ extensionId, storage, fetch });
  const controller = new ConversionController({ client, onChange: render, getTask:() => getCollection().task, onReplacements });
  let timer = null, scheduledEpoch = null, itemSignature = '', objectUrls = [], disposed = false;
  let renderedEpoch = controller.epoch;
  let imageKinds = ['main','detail','sku'], provider = 'doubao', quoteSignature = '', batchOptionsSignature = '';
  function selection(task) {
    const entries = buildImageManifest(task, imageKinds);
    const unique = new Set(entries.map(entry => entry.url)).size;
    return { entries, count:entries.length, unique, amount:unique * 0.06, signature:JSON.stringify([task?.id,provider,imageKinds,entries]) };
  }
  function displayedSelection(task) {
    const job = controller.job, pending = controller.pendingSource;
    if (!pending && (!job || ['completed','done'].includes(job.status))) return selection(task);
    const entries = pending?.entries || controller.entries;
    const complete = Boolean(entries?.length && entries.every(entry => KIND[entry.kind] && typeof entry.url === 'string' && entry.url));
    const unique = complete ? new Set(entries.map(entry => entry.url)).size : null;
    const amount = !pending && typeof job?.estimated_cost_upper === 'number' && Number.isFinite(job.estimated_cost_upper) && job.estimated_cost_upper >= 0 ? job.estimated_cost_upper : unique === null ? null : unique * 0.06;
    return { entries:complete ? entries : null, count:complete ? entries.length : Number.isInteger(job?.counts?.total) ? job.counts.total : null, unique, amount, frozen:true };
  }
  function stopPoll() { if (timer !== null) clearTimer(timer); timer = null; scheduledEpoch = null; }
  function revokeImages() { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = []; }
  function message(text, error = false) { $('conversion-message').textContent = text; $('conversion-message').className = `notice ${error ? 'error' : ''}`; $('conversion-message').hidden = !text; }
  async function run(operation) {
    const epoch = controller.epoch;
    try { await operation(); }
    catch (error) { if (!disposed && controller.current(epoch)) message(error.message, true); }
  }
  function schedulePoll() {
    if (disposed || controller.working || controller.restored || !controller.job || timer !== null) return;
    const epoch = controller.epoch;
    scheduledEpoch = epoch;
    timer = setTimer(async () => {
      if (disposed || !controller.current(epoch) || scheduledEpoch !== epoch) return;
      timer = null; scheduledEpoch = null;
      await controller.poll();
      if (controller.current(epoch)) schedulePoll();
    }, 1800);
  }
  function renderItems(job) {
    // Status/message polls update text and buttons while keeping loaded blob previews.
    const signature = JSON.stringify([job?.id, job?.items?.map(item => [item.index,item.refs,item.input_path,item.result?.output_path,item.result_path])]);
    if (signature === itemSignature) return;
    itemSignature = signature; revokeImages();
    $('conversion-items').replaceChildren(...(job?.items || []).map((item, offset) => {
      const index = item.index ?? offset, row = node('article', '', 'conversion-item');
      const first = item.refs?.[0];
      row.dataset.index = String(index);
      row.append(node('h4', `${index + 1}. ${first?.title || item.name || '商品图片'}`), node('p', '', 'muted conversion-item-status'));
      const refs = node('details', ''), summary = node('summary', `关联 ${item.refs?.length || 1} 个图片位置`);
      refs.append(summary);
      for (const ref of item.refs || []) refs.append(node('p', `${ref.platform} · ${ref.product_id} · ${ref.title} · ${KIND[ref.kind] || ref.kind} ${ref.order}${ref.sku ? ` · ${ref.sku}` : ''}`, 'muted'));
      row.append(refs);
      const controls = node('div', '', 'actions'), previews = node('div', '', 'conversion-previews');
      for (const [kind, label, available] of [['original','预览原图',Boolean(item.input_path)], ['result','预览结果',Boolean(item.result?.public_url || item.result?.output_path || item.result_path)]]) {
        const button = node('button', label, 'button'); button.type = 'button'; button.disabled = !available;
        const figure = node('figure', ''), caption = node('figcaption', label.slice(2)); figure.hidden = true; figure.append(caption); previews.append(figure);
        button.addEventListener('click', () => void run(async () => {
          const blob = await controller.image(index, kind);
          if (!blob || !row.isConnected) return;
          const url = URL.createObjectURL(blob); objectUrls.push(url);
          const img = node('img', '', 'conversion-preview'); img.alt = `${first?.title || '商品图片'}${label.slice(2)}`; img.src = url;
          figure.replaceChildren(img, caption); figure.hidden = false;
        }));
        controls.append(button);
      }
      for (const [action, label] of [['retry','继续处理此图'], ['retry-upload','重试上传（不重新生成）'], ['redo','重新生成此图']]) {
        const button = node('button', label, 'button'); button.type = 'button'; button.dataset.conversionAction = action; button.dataset.index = String(index);
        button.disabled = controller.working || !['failed','needs-review','paused','completed'].includes(item.status) || !['paused','stopped','blocked','completed','done'].includes(job.status);
        button.addEventListener('click', () => { if (!button.disabled) void run(() => {
          const paidRedo = controller.job?.provider === 'aliyun' && action === 'redo';
          if (paidRedo && !confirm('重新生成此图会再次向阿里云提交，可能再次计费 0.06 元（关联的相同图片也会更新）。是否继续？')) return;
          return controller.action(action,index,undefined,{paidConfirmed:paidRedo});
        }); });
        controls.append(button);
      }
      row.append(controls,previews); return row;
    }));
  }
  function render() {
    if (disposed) return;
    if (renderedEpoch !== controller.epoch) { stopPoll(); renderedEpoch = controller.epoch; }
    const state = controller.view(), { task, collecting = false, unavailable = false } = getCollection();
    const job = state.job, connected = state.connected, working = state.working || unavailable;
    const frozen = Boolean(controller.pendingSource || (job && !['completed','done'].includes(job.status)));
    const batchSignature = job ? JSON.stringify([job.id,job.provider,job.image_kinds]) : '';
    if (job && !controller.pendingSource && (frozen || batchSignature !== batchOptionsSignature)) { imageKinds = [...(job.image_kinds || ['main','detail','sku'])]; provider = job.provider || 'doubao'; }
    batchOptionsSignature = batchSignature;
    for (const kind of Object.keys(KIND)) { $('conversion-kind-'+kind).checked = imageKinds.includes(kind); $('conversion-kind-'+kind).disabled = working || frozen; }
    $('conversion-paid').checked = provider === 'aliyun'; $('conversion-paid').disabled = working || frozen;
    const paid = provider === 'aliyun', capabilities = state.capabilities;
    const chosen = displayedSelection(task), allEntries = chosen.frozen ? chosen.entries : buildImageManifest(task);
    if (!chosen.frozen) quoteSignature = chosen.signature;
    $('conversion-selection').textContent = allEntries ? `${Object.entries(KIND).map(([kind,label]) => `${label} ${allEntries.filter(entry => entry.kind === kind).length}`).join(' · ')} · 已选 ${chosen.count} 个位置 · 独立 URL ${chosen.unique}` : chosen.count === null ? '本批清单正在恢复，图片数量和费用待本地快照确认。' : `本批已选 ${chosen.count} 个位置 · 独立 URL 待恢复`;
    const ossReady = capabilities?.image_link_replacement === true && capabilities.cloud_image_storage === true && capabilities.oss_configured === true;
    const ossStatus = !connected ? '连接本地工具后可查询 OSS 和阿里云配置状态。' : !capabilities ? '请刷新配置状态。' : capabilities.image_link_replacement !== true || capabilities.cloud_image_storage !== true ? '请升级本地工具到 1.6.3 或更新版本，以支持图片直接保存到 OSS。' : capabilities.oss_configured !== true ? '请在本地工具配置 OSS，返回后点击“刷新配置状态”。' : 'OSS 已配置，上传成功的图片将自动替换商品 Excel 链接。';
    $('conversion-provider-status').textContent = ossStatus + (ossReady ? !capabilities.providers?.includes('aliyun') ? ' 阿里云付费模式需要升级本地工具。' : capabilities.aliyun_configured === true ? ' 阿里云密钥已在本机配置（尚未验证云端服务）。' : ' 请在本地工具配置阿里云密钥，返回后点击“刷新配置状态”。' : '');
    $('conversion-settings').hidden = !connected;
    if (connected) $('conversion-settings').setAttribute('href',`${client.connection.baseUrl}/#token=${encodeURIComponent(client.connection.token)}`);
    else $('conversion-settings').removeAttribute('href');
    $('conversion-refresh-config').disabled = !connected || working;
    $('conversion-cost').hidden = !paid;
    const estimate = chosen.amount === null ? '本批费用上限待本地快照确认。' : chosen.frozen ? `本批累计费用上限 ¥${chosen.amount.toFixed(2)}（包含已确认的重新生成）。` : `按 ${chosen.unique} 个独立 URL × 0.06 元，本批首次提交费用上限 ¥${chosen.amount.toFixed(2)}。`;
    $('conversion-cost').textContent = `${estimate}相同内容可能去重；实际费用以阿里云账单为准。失败或不确定的请求也可能计费，重新生成可能增加费用。`;
    $('conversion-connected').textContent = connected ? '本地工具已连接' : '未连接';
    $('conversion-connect').disabled = working || !controller.canReconnect();
    $('conversion-forget').hidden = !state.canForget; $('conversion-forget').disabled = working;
    $('conversion-login').disabled = !connected || working;
    $('conversion-login').hidden = paid;
    $('conversion-start').textContent = paid ? chosen.amount === null ? '付费开始转换（费用待恢复）' : `付费开始转换（上限 ¥${chosen.amount.toFixed(2)}）` : '开始图片转换（豆包免费）';
    $('conversion-start').disabled = !extensionId || !connected || !ossReady || working || collecting || !task || !['done','stopped','error','short'].includes(task.status) || frozen || !chosen.count || (paid && (!capabilities?.providers?.includes('aliyun') || capabilities.aliyun_configured !== true));
    $('conversion-stop').disabled = working || !job || ['completed','done','paused','stopped'].includes(job.status);
    $('conversion-continue').disabled = working || !job || !['paused','stopped','blocked'].includes(job.status);
    $('conversion-status').textContent = job ? `${STATUS[job.status] || job.status} · ${job.provider === 'aliyun' ? '阿里云付费' : '豆包免费'} · ${(job.image_kinds || ['main','detail','sku']).map(kind => KIND[kind]).join('、')} · 付费请求 ${job.paid_calls || 0}${job.provider === 'aliyun' ? '（包含不确定请求，以实际账单为准）' : ''}${job.browser_message ? ` · ${job.browser_message}` : ''}` : collecting || (task && !['done','stopped','error','short'].includes(task.status)) ? '请先停止采集或等待采集结束' : connected ? '已连接，图片将保存到 OSS' : '等待连接本地工具';
    const counts = job?.counts || {};
    const replacedKeys = new Set(matchingImageReplacements(task,task?.imageReplacements).map(imagePositionKey)), exportManifest = buildImageManifest(task);
    const replaced = exportManifest.filter(ref => replacedKeys.has(imagePositionKey(ref))).length, total = exportManifest.length;
    $('conversion-counts').textContent = `图片位置 ${counts.total || 0} · 独立图片 ${counts.unique || 0} · 已下载 ${counts.downloaded || 0} · 已转换 ${counts.converted || 0} · 已上传 ${counts.uploaded || 0} · 已替换 ${replaced} · 原图回退 ${total-replaced} · 上传失败 ${counts.upload_failed || 0} · 失败 ${counts.failed || 0}`;
    const active = job?.items?.find(item => item.status === 'running') || job?.items?.find(item => ['paused','needs-review'].includes(item.status));
    $('conversion-current').textContent = active ? `当前图片 ${(active.index ?? 0) + 1}：${PHASE[active.phase] || active.phase || STATUS[active.status]}${active.message ? ` · ${active.message}` : ''}` : job ? '上传成功的图片已保存到商品任务，点击“导出 Excel”即可使用；未完成的位置保留原图。' : '本批使用与原商品 Excel 相同的标题筛选与数量限制。';
    if (state.error) message(state.error,true);
    renderItems(job);
    for (const row of $('conversion-items').querySelectorAll('.conversion-item')) {
      const item = job?.items?.find((item,offset) => (item.index ?? offset) === Number(row.dataset.index));
      row.querySelector('.conversion-item-status').textContent = `${STATUS[item?.status] || item?.status || '等待'} · ${PHASE[item?.phase] || item?.phase || ''}${item?.message ? ` · ${item.message}` : ''}`;
      const label = retryLabel(item, job?.provider);
      for (const button of row.querySelectorAll('[data-conversion-action]')) {
        const retry = button.dataset.conversionAction === 'retry';
        const uploadRetry = button.dataset.conversionAction === 'retry-upload';
        const canUploadRetry = item?.phase === 'upload-failed' && Boolean(item.result?.public_url || item.result?.output_path || item.result_path);
        if (retry) { button.textContent = label || '无需重试'; button.hidden = !label; }
        if (uploadRetry) button.hidden = !canUploadRetry;
        button.disabled = working || !['paused','stopped','blocked','completed','done'].includes(job?.status) || !['failed','needs-review','paused','completed'].includes(item?.status) || (retry && !label) || (uploadRetry && !canUploadRetry);
      }
    }
    if (!job) { stopPoll(); $('conversion-details').open = false; }
    else schedulePoll();
  }
  $('conversion-connect').addEventListener('click', () => void run(async () => {
    const connecting = controller.connect($('conversion-code').value), epoch = controller.epoch;
    await connecting;
    if (controller.current(epoch) && client.connection) { $('conversion-code').value = ''; message('已连接本地工具。'); }
  }));
  $('conversion-refresh-config').addEventListener('click', () => { if (!$('conversion-refresh-config').disabled) void run(() => controller.refreshCapabilities()); });
  for (const kind of Object.keys(KIND)) $('conversion-kind-'+kind).addEventListener('change', () => {
    if (!$('conversion-kind-'+kind).disabled) imageKinds = Object.keys(KIND).filter(kind => $('conversion-kind-'+kind).checked);
    render();
  });
  $('conversion-paid').addEventListener('change', () => { if (!$('conversion-paid').disabled) provider = $('conversion-paid').checked ? 'aliyun' : 'doubao'; render(); });
  $('conversion-forget').addEventListener('click', () => void run(() => {
    controller.forgetStale(); $('conversion-code').value = ''; message('已使用新连接，采集商品保留；需要重新转换时请手动开始。');
  }));
  $('conversion-login').addEventListener('click', () => void run(() => controller.action('open-browser', undefined, getCollection().task?.id)));
  $('conversion-start').addEventListener('click', () => void run(() => {
    if ($('conversion-start').disabled) return;
    const current = getCollection();
    if (current.unavailable) throw new Error('当前管理页不可操作。');
    if (selection(current.task).signature !== quoteSignature) { render(); throw new Error('图片清单或费用已变化，请检查新的数量和费用后再次开始。'); }
    message('本批已固定商品图片清单，后续新增商品将留到下一批。');
    return controller.start(current.task, controller.outputDir, current.collecting, {imageKinds:[...imageKinds],provider,paidConfirmed:provider === 'aliyun'});
  }));
  $('conversion-stop').addEventListener('click', () => void run(() => controller.action('stop')));
  $('conversion-continue').addEventListener('click', () => void run(() => controller.action('continue')));
  render();
  return {
    controller, refresh: render,
    recover(task) { return controller.restoreForTask(task); },
    clear() { stopPoll(); message(''); return controller.clear(); },
    removeProduct(taskId, platform, productId) { return controller.removeProduct(taskId,platform,productId); },
    dispose() { disposed = true; stopPoll(); revokeImages(); },
    selectedCount() { return displayedSelection(getCollection().task).count; }
  };
}
