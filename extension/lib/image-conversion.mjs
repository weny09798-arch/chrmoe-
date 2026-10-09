import { outputLimit, validProductTitle } from './core.mjs';
import { LicenseAuthority, licenseError } from './licensing.mjs';

export function normalizeImageLimits(imageKinds, values = {}) {
  const limits = {};
  for (const kind of ['main','detail','sku']) {
    const value = values?.[kind];
    if (!imageKinds.includes(kind) || value === null || value === undefined || (typeof value === 'string' && !value.trim())) { limits[kind] = null; continue; }
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('图片数量必须为空（不限）或安全范围内的正整数。');
    limits[kind] = number;
  }
  return Object.freeze(limits);
}
export function imageKindCounts(entries) {
  return Object.freeze(Object.fromEntries(['main','detail','sku'].map(kind => [kind,entries.filter(entry => entry.kind === kind).length])));
}

// Match taskSheets' filter-before-limit selection. Source objects are never edited.
export function buildImageManifest(task, imageKinds = ['main','detail','sku'], imageLimits = {}) {
  if (!Array.isArray(imageKinds) || imageKinds.some(kind => !['main','detail','sku'].includes(kind))) throw new Error('图片类型无效。');
  const limits = normalizeImageLimits(imageKinds,imageLimits), counts = {main:0,detail:0,sku:0};
  const selected = new Set(imageKinds);
  const entries = [];
  for (const job of task?.jobs || []) {
    const products = (job.groups || []).map(group => group.best)
      .filter(item => item && validProductTitle(item.title, job.keyword)).slice(0, outputLimit(job));
    for (const item of products) {
      const common = { platform: item.site || job.site || 'pdd', product_id: String(item.id ?? ''), title: String(item.title || ''), product_url: String(item.url || '') };
      const append = (kind, urls, sku = '') => urls.forEach((url, index) => {
        if (selected.has(kind) && typeof url === 'string' && url.trim()) entries.push(Object.freeze({ ...common, kind, sku, order: index + 1, sku_index:null, url: url.trim() }));
      });
      append('main', Array.isArray(item.galleryImages) && item.galleryImages.some(url => typeof url === 'string' && url.trim()) ? item.galleryImages : [item.image]);
      append('detail', Array.isArray(item.detailImages) ? item.detailImages : []);
      (Array.isArray(item.skus) ? item.skus : []).forEach((sku, index) => {
        if (selected.has('sku') && typeof sku?.image === 'string' && sku.image.trim()) entries.push(Object.freeze({ ...common, kind: 'sku', sku: String(sku.id || (sku.specs || []).join(' / ') || `SKU ${index + 1}`), order: index + 1, sku_index:index, url: sku.image.trim() }));
      });
    }
  }
  return Object.freeze(entries.filter(entry => ++counts[entry.kind] <= (limits[entry.kind] ?? Infinity)));
}

export function imagePositionKey(ref) {
  if (!ref || !['main','detail','sku'].includes(ref.kind) || !Number.isInteger(ref.order) || ref.order < 1 || typeof ref.url !== 'string' || !ref.url.trim()) return null;
  const skuIndex = ref.kind === 'sku' ? ref.sku_index === undefined ? ref.order - 1 : ref.sku_index : ref.sku_index === undefined ? null : ref.sku_index;
  if (ref.kind === 'sku' ? !Number.isInteger(skuIndex) || skuIndex < 0 || skuIndex !== ref.order - 1 : skuIndex !== null) return null;
  return JSON.stringify([ref.platform,String(ref.product_id),ref.kind,ref.order,skuIndex,ref.url.trim()]);
}

export function validPublishedUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname.length > 1 && /^[a-z0-9][a-z0-9-]*\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname);
  } catch { return false; }
}

export function matchingImageReplacements(task, refs) {
  const positions = new Set(buildImageManifest(task).map(imagePositionKey)), accepted = new Map();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const key = imagePositionKey(ref);
    if (!key || !positions.has(key) || !validPublishedUrl(ref.published_url)) continue;
    if (ref.published_revision !== undefined && (!Number.isSafeInteger(ref.published_revision) || ref.published_revision < 0)) continue;
    accepted.set(key,{ ...ref, sku_index:ref.kind === 'sku' ? ref.sku_index ?? ref.order - 1 : null, url:ref.url.trim() });
  }
  return [...accepted.values()];
}

// Overlay storage is independent of the scraped product objects and local batches.
export function mergeImageReplacements(task, refs) {
  const existing = matchingImageReplacements(task,task.imageReplacements), merged = new Map(existing.map(ref => [imagePositionKey(ref),ref]));
  for (const ref of matchingImageReplacements(task,refs)) {
    const key = imagePositionKey(ref), previous = merged.get(key);
    if (previous?.job_id === ref.job_id && previous?.published_revision !== undefined && (ref.published_revision ?? -1) < previous.published_revision) continue;
    merged.set(key,ref);
  }
  const replacements = [...merged.values()];
  if (JSON.stringify(task.imageReplacements || []) === JSON.stringify(replacements)) return false;
  task.imageReplacements = replacements;
  return true;
}

export function parseConnectionCode(code) {
  const raw = String(code || '').trim();
  const match = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]+)(?:\/)?#([^\s]+)$/.exec(raw);
  const invalid = () => { throw new Error('连接码无效，请从本地工具复制完整连接码（含 #token=…）。'); };
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return invalid();
  const fragment = new URLSearchParams(match[3]);
  if ([...fragment].length !== 1 || !fragment.has('token') || !fragment.get('token')?.trim()) return invalid();
  return Object.freeze({ baseUrl: new URL(raw).origin, token: fragment.get('token') });
}

const SESSION_KEY = 'collector-image-bridge';
const OWNED_JOB_KEY = 'collector-image-owned-job';
export function conversionActionNeedsLicense(job, action, index) {
  if (action === 'redo') return true;
  if (action === 'continue') return !(job?.items || []).some(item => !['completed','failed'].includes(item.status) && ['pending','saving','aliyun-downloading','uploading','upload-failed','alias'].includes(item.phase));
  if (action !== 'retry') return false;
  const item = job?.items?.find((item,offset) => (item.index ?? offset) === index);
  const original = Number.isInteger(item?.alias_of) ? job.items[item.alias_of] : item;
  if (original !== item && original?.status === 'completed') return false;
  return !original || original.status === 'needs-review' || !['saving','pending','aliyun-downloading'].includes(original.phase);
}
export class BridgeClient {
  constructor({ extensionId, fetch = globalThis.fetch?.bind(globalThis), storage = globalThis.sessionStorage } = {}) {
    this.extensionId = extensionId; this.fetch = fetch; this.storage = storage; this.connection = null;
    try {
      const saved = JSON.parse(storage?.getItem(SESSION_KEY) || 'null');
      if (saved) this.connection = parseConnectionCode(`${saved.baseUrl}/#token=${encodeURIComponent(saved.token)}`);
    } catch { storage?.removeItem(SESSION_KEY); }
  }
  remember(connection) {
    this.connection = connection;
    this.storage?.setItem(SESSION_KEY, JSON.stringify(connection));
  }
  async request(route, { body, blob = false, connection = this.connection } = {}) {
    if (!connection || !this.extensionId) throw new Error('请先在 Chrome 扩展中连接本地图片工具。');
    const headers = { 'X-Tool-Token': connection.token, 'X-Extension-Id': this.extensionId };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetch(`${connection.baseUrl}/api/bridge/${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error', credentials: 'omit' }); }
    catch { throw new Error('无法连接本地图片工具，请确认工具仍在运行并重新复制连接码。'); }
    if (!response.ok) {
      if (response.status === 423) {
        const value = await response.json().catch(() => ({}));
        const error = licenseError(value.license); error.status = 423; throw error;
      }
      // Never surface a server URL/body that could accidentally include credentials.
      const messages = {401:'连接码已失效，请重新连接。',403:'本地工具未授权此扩展，请使用同一管理页的连接码重新连接。',409:'本地工具正在处理其他任务，或任务已失效，请先在工具中处理。',404:'本地任务或图片尚不可用。'};
      const error = new Error(messages[response.status] || `本地工具请求失败（${response.status}）。`);
      error.status = response.status; throw error;
    }
    return blob ? response.blob() : response.json();
  }
}

export class ConversionController {
  constructor({ client, onChange = () => {}, getTask, onReplacements = async () => {} }) {
    this.client = client; this.onChange = onChange; this.epoch = 0;
    this.getTask = getTask || (() => this.currentTask); this.onReplacements = onReplacements; this.publishedSignature = '';
    this.job = null; this.entries = null; this.sourceTaskId = null; this.pendingSource = null;
    this.outputDir = ''; this.working = false; this.error = '';
    this.reconnectCandidate = null;
    this.restored = false;
    this.capabilities = null; this.availableCounts = null;
    this.licenseAuthority = new LicenseAuthority({client,onChange:() => this.emit()});
    // Restore ownership synchronously: deletion/clear must work before the first GET.
    try {
      const handle = JSON.parse(client.storage?.getItem(OWNED_JOB_KEY) || 'null');
      if (handle) {
        if (!client.connection || typeof handle.job_id !== 'string' || !handle.job_id || typeof handle.source_task_id !== 'string' || !handle.source_task_id || !Array.isArray(handle.products) || !handle.products.length || handle.products.some(product => !['pdd','1688','taobao'].includes(product?.platform) || typeof product.product_id !== 'string' || !product.product_id)) throw new Error('Invalid owned handle');
        this.job = { id: handle.job_id, kind: 'collector', source_task_id: handle.source_task_id, status: 'recovering', items: [], provider:handle.provider || 'doubao', image_kinds:handle.image_kinds || ['main','detail','sku'], image_limits:normalizeImageLimits(handle.image_kinds || ['main','detail','sku'],handle.image_limits) };
        this.sourceTaskId = handle.source_task_id;
        this.availableCounts = handle.available_counts || null;
        this.entries = handle.entries?.length ? Object.freeze(handle.entries.map(ref => Object.freeze({...ref}))) : Object.freeze(handle.products.map(product => Object.freeze({ platform: product.platform, product_id: product.product_id })));
        this.restored = true;
      }
    } catch { client.storage?.removeItem(OWNED_JOB_KEY); }
  }
  persistOwnership() {
    const products = new Map();
    for (const entry of this.entries || []) products.set(JSON.stringify([entry.platform,entry.product_id]), { platform: entry.platform, product_id: entry.product_id });
    this.client.storage?.setItem(OWNED_JOB_KEY, JSON.stringify({ job_id: this.job.id, source_task_id: this.sourceTaskId, products: [...products.values()], entries:this.entries?.filter(ref => ref.kind && ref.url), available_counts:this.availableCounts, provider:this.job.provider, image_kinds:this.job.image_kinds, image_limits:this.job.image_limits }));
  }
  async restoreForTask(task) {
    if (!this.restored) return;
    this.restored = false;
    if (this.sourceTaskId !== task?.id) { await this.clear(); return; }
    this.currentTask = task;
    await this.poll();
  }
  view() { return { job: this.job, license:this.licenseAuthority.status, capabilities: this.capabilities, connected: Boolean(this.client.connection), outputDir: this.outputDir, working: this.working, error: this.error, canForget: Boolean(this.reconnectCandidate) }; }
  async requireLicense(options) {
    const epoch = this.epoch;
    try { const status = await this.licenseAuthority.require(options); return this.current(epoch) ? status : null; }
    catch (error) { if (this.current(epoch)) throw error; return null; }
  }
  checkLicense(options) { return this.licenseAuthority.check(options); }
  activateLicense(code) { return this.licenseAuthority.activate(code); }
  async readCapabilities(connection) {
    try { return await this.client.request('capabilities', { connection }); }
    catch (error) { if (error.status === 404) return { providers:['doubao'], legacy:true, aliyun_configured:false, aliyun_price_per_image:0.06 }; throw error; }
  }
  async refreshCapabilities() {
    if (this.working) throw new Error('请等待当前操作完成。');
    return this.guarded(async epoch => {
      this.capabilities = null; this.emit();
      const capabilities = await this.readCapabilities(this.client.connection);
      if (this.current(epoch)) { this.capabilities = capabilities; this.licenseAuthority.reset(capabilities); await this.checkLicense(); this.emit(); }
    });
  }
  canReconnect() { return !this.pendingSource && (!this.job || ['completed','done','paused','stopped','blocked'].includes(this.job.status) || Boolean(this.error)); }
  acceptSnapshot(snapshot, jobId) {
    if (snapshot?.id !== jobId || snapshot.kind !== 'collector' || snapshot.source_task_id !== this.sourceTaskId) throw new Error('本地任务与当前图片批次不一致，请在本地工具中检查。');
    this.job = { ...snapshot, provider: snapshot.provider || this.job?.provider || 'doubao', image_kinds: snapshot.image_kinds || this.job?.image_kinds || ['main','detail','sku'], image_limits: normalizeImageLimits(snapshot.image_kinds || this.job?.image_kinds || ['main','detail','sku'],snapshot.image_limits || this.job?.image_limits), paid_calls: snapshot.paid_calls || 0 };
    if (snapshot.license) this.licenseAuthority.accept(snapshot.license);
    if (typeof snapshot.output_dir === 'string') this.outputDir = snapshot.output_dir;
    const refs = snapshot.items?.flatMap(item => item.refs || []);
    if (refs?.length && !this.entries?.some(ref => ref.kind && ref.url)) this.entries = Object.freeze(refs.map(ref => Object.freeze({ ...ref })));
    const task = this.getTask();
    if (task?.id !== this.sourceTaskId) return;
    const owned = new Set((this.entries || []).map(imagePositionKey).filter(Boolean));
    const published = matchingImageReplacements(task,(snapshot.items || []).filter(item => item.status === 'completed')
      .flatMap(item => (item.refs || []).filter(ref => item.url === undefined || item.url === ref.url)))
      .filter(ref => owned.has(imagePositionKey(ref))).map(ref => ({ ...ref, job_id:jobId }));
    const signature = JSON.stringify(published);
    if (!published.length || signature === this.publishedSignature) return;
    const epoch = this.epoch;
    return Promise.resolve(this.onReplacements(this.sourceTaskId,published)).then(() => { if (this.current(epoch) && this.job?.id === jobId) this.publishedSignature = signature; });
  }
  forgetStale() {
    if (!this.reconnectCandidate || this.working) throw new Error('请先使用新连接码验证本地工具。');
    const connection = this.reconnectCandidate;
    ++this.epoch; this.reconnectCandidate = null;
    this.job = null; this.entries = null; this.sourceTaskId = null; this.pendingSource = null; this.restored = false;
    this.client.storage?.removeItem(OWNED_JOB_KEY); this.client.remember(connection);
    this.capabilities = null; this.outputDir = ''; this.error = ''; this.emit();
    this.licenseAuthority.reset();
  }
  emit() { this.onChange(this.view()); }
  current(epoch) { return epoch === this.epoch; }
  async guarded(operation) {
    const epoch = this.epoch;
    this.working = true; this.error = ''; this.emit();
    try { return await operation(epoch); }
    catch (error) { if (this.current(epoch)) { if (error.licenseDenied && error.license) this.licenseAuthority.accept(error.license); this.error = error.message; this.emit(); } throw error; }
    finally { if (this.current(epoch)) { this.working = false; this.emit(); } }
  }
  async connect(code) {
    if (!this.canReconnect() || this.working) throw new Error('请先处理当前图片批次，再更换连接。');
    const ownedJob = this.job && !['completed','done'].includes(this.job.status) ? this.job : null;
    this.reconnectCandidate = null;
    ++this.epoch;
    this.licenseAuthority.reset();
    if (!ownedJob && this.job) {
      this.job = null; this.entries = null; this.sourceTaskId = null;
      this.client.storage?.removeItem(OWNED_JOB_KEY);
    }
    return this.guarded(async epoch => {
      const connection = parseConnectionCode(code);
      await this.client.request('pair', { body: { extension_id: this.client.extensionId }, connection });
      if (!this.current(epoch)) return;
      if (ownedJob) {
        let snapshot;
        try { snapshot = await this.client.request(`state?job_id=${encodeURIComponent(ownedJob.id)}`, { connection }); }
        catch (error) {
          if (this.current(epoch) && [404,409].includes(error.status)) this.reconnectCandidate = connection;
          throw error;
        }
        if (!this.current(epoch)) return;
        const capabilities = await this.readCapabilities(connection);
        if (!this.current(epoch)) return;
        await this.acceptSnapshot(snapshot, ownedJob.id);
        if (!this.current(epoch)) return;
        this.capabilities = capabilities; this.client.remember(connection); this.licenseAuthority.reset(capabilities); await this.checkLicense(); this.persistOwnership(); this.restored = false; this.emit();
        return;
      }
      const capabilities = await this.readCapabilities(connection);
      if (this.current(epoch)) { this.capabilities = capabilities; this.client.remember(connection); this.licenseAuthority.reset(capabilities); await this.checkLicense(); this.outputDir = ''; this.emit(); }
    });
  }
  async chooseFolder() {
    return this.guarded(async epoch => {
      const result = await this.client.request('folder', { body: {} });
      if (this.current(epoch) && result.path) { this.outputDir = result.path; this.emit(); }
    });
  }
  async start(task, outputDir = this.outputDir, collecting = false, options = {}) {
    if (collecting || !task || !['done','stopped','error','short'].includes(task.status)) throw new Error('请先停止采集或等待采集结束，再开始图片转换。');
    if (this.working || (this.job && !['completed','done'].includes(this.job.status))) throw new Error('请先处理当前图片批次。');
    const imageKinds = Object.freeze([...new Set(options.imageKinds ?? ['main','detail','sku'])]);
    if (!imageKinds.length) throw new Error('请至少选择一种图片类型。');
    const provider = options.provider ?? 'doubao', paidConfirmed = options.paidConfirmed === true;
    if (!['doubao','aliyun'].includes(provider)) throw new Error('图片转换模式无效。');
    if (provider === 'aliyun' && !paidConfirmed) throw new Error('请确认付费后开始阿里云转换。');
    const imageLimits = normalizeImageLimits(imageKinds,options.imageLimits);
    const entries = buildImageManifest(task, imageKinds,imageLimits), availableCounts = imageKindCounts(buildImageManifest(task));
    if (!entries.length) throw new Error('当前可导出的商品没有图片。');
    const sourceTaskId = task.id, connection = this.client.connection;
    this.currentTask = task;
    this.pendingSource = { id: sourceTaskId, entries, imageKinds, imageLimits, provider, availableCounts };
    return this.guarded(async epoch => {
      let snapshot;
      try {
        await this.requireLicense({refresh:true});
        if (!this.current(epoch)) return;
        let capabilities = this.capabilities;
        if (provider === 'aliyun') {
          capabilities = await this.readCapabilities(connection);
          if (!this.current(epoch)) return;
          this.capabilities = capabilities; this.emit();
          if (!capabilities.providers?.includes('aliyun')) throw new Error('本地工具需升级到支持阿里云的版本。');
          if (capabilities.aliyun_configured !== true) throw new Error('请先在本地工具配置阿里云密钥，再刷新配置状态。');
        }
        if (Object.values(imageLimits).some(value => value !== null) && capabilities?.image_type_limits !== true) throw new Error('本地工具需升级到 1.6.4 或更新版本，才能限制图片数量。');
        if (capabilities?.image_link_replacement !== true) throw new Error('本地工具需升级到支持 OSS 图片链接自动替换的版本。');
        if (capabilities.cloud_image_storage !== true) throw new Error('本地工具需升级到 1.6.3 或更新版本，才能直接保存到 OSS。');
        if (capabilities.oss_configured !== true) throw new Error('请先在本地工具配置 OSS，再刷新配置状态。');
        if (!this.current(epoch)) return;
        snapshot = await this.client.request('jobs', { body: { source_task_id: sourceTaskId, cloud_only:true, entries, provider, image_kinds:imageKinds, image_limits:imageLimits, paid_confirmed:paidConfirmed }, connection });
      }
      finally { if (this.current(epoch)) this.pendingSource = null; }
      if (!this.current(epoch)) {
        if (snapshot?.id) await this.client.request('action', { body: { job_id: snapshot.id, source_task_id: sourceTaskId, action: 'cancel' }, connection }).catch(() => {});
        return;
      }
      if (snapshot?.kind !== 'collector' || snapshot.source_task_id !== sourceTaskId || !snapshot.id) throw new Error('本地任务与当前图片批次不一致，请在本地工具中检查。');
      this.availableCounts = availableCounts; this.entries = entries; this.sourceTaskId = sourceTaskId; this.outputDir = outputDir;
      this.publishedSignature = '';
      await this.acceptSnapshot({ ...snapshot, provider:snapshot.provider || provider, image_kinds:snapshot.image_kinds || imageKinds, image_limits:imageLimits }, snapshot.id);
      if (!this.current(epoch)) return;
      this.persistOwnership(); this.emit();
    });
  }
  async poll() {
    if (!this.job) return;
    const epoch = this.epoch, jobId = this.job.id;
    try {
      const snapshot = await this.client.request(`state?job_id=${encodeURIComponent(jobId)}`);
      if (this.current(epoch) && this.job?.id === jobId) {
        await this.acceptSnapshot(snapshot, jobId);
        if (!this.current(epoch) || this.job?.id !== jobId) return;
        this.error = ''; this.emit();
      }
    } catch (error) { if (this.current(epoch) && this.job?.id === jobId) { this.error = error.message; this.emit(); } }
  }
  async action(action, index, taskId, options = {}) {
    const job = this.job;
    if (this.working) throw new Error('请等待当前操作完成。');
    const paidRedo = job?.provider === 'aliyun' && action === 'redo';
    if (paidRedo && options.paidConfirmed !== true) throw new Error('重新生成可能再次计费，请确认付费。');
    const item = job?.items?.find((item,offset) => (item.index ?? offset) === index);
    if (job?.provider === 'aliyun' && action === 'retry' && ['uncertain','submitting','aliyun-failed'].includes(item?.phase)) throw new Error('请检查结果并使用已确认付费的重新生成。');
    return this.guarded(async epoch => {
      if (conversionActionNeedsLicense(job,action,index)) await this.requireLicense({refresh:true});
      if (!this.current(epoch)) return;
      const snapshot = await this.client.request('action', { body: { job_id: job?.id || null, source_task_id: this.sourceTaskId || taskId || null, action, ...(index === undefined ? {} : { index }), ...(paidRedo ? {paid_confirmed:true} : {}) } });
      if (this.current(epoch) && job && this.job?.id === job.id) { await this.acceptSnapshot(snapshot, job.id); if (this.current(epoch) && this.job?.id === job.id) this.emit(); }
    });
  }
  async clear() {
    const job = this.job, sourceTaskId = this.sourceTaskId, connection = this.client.connection;
    ++this.epoch;
    this.licenseAuthority.invalidate();
    this.job = null; this.entries = null; this.sourceTaskId = null; this.pendingSource = null;
    this.restored = false; this.reconnectCandidate = null; this.client.storage?.removeItem(OWNED_JOB_KEY);
    this.working = false; this.error = ''; this.emit();
    if (job) await this.client.request('action', { body: { job_id: job.id, source_task_id: sourceTaskId, action: 'cancel' }, connection }).catch(() => {});
  }
  async removeProduct(taskId, platform, productId) {
    const entries = this.pendingSource?.entries || this.entries;
    const source = this.pendingSource?.id || this.sourceTaskId;
    if (source === taskId && entries?.some(e => e.platform === platform && e.product_id === String(productId))) await this.clear();
  }
  async image(index, kind) {
    if (!this.job) return null;
    const epoch = this.epoch, jobId = this.job.id;
    const blob = await this.client.request(`images/${encodeURIComponent(jobId)}/${index}/${kind}`, { blob: true });
    return this.current(epoch) && this.job?.id === jobId ? blob : null;
  }
  async manifest() {
    if (!this.job) return null;
    const epoch = this.epoch, jobId = this.job.id;
    const blob = await this.client.request(`manifest?job_id=${encodeURIComponent(jobId)}`, { blob: true });
    return this.current(epoch) && this.job?.id === jobId ? blob : null;
  }
}
