import { outputLimit, validProductTitle } from './core.mjs';

// Match taskSheets' filter-before-limit selection. Source objects are never edited.
export function buildImageManifest(task, imageKinds = ['main','detail','sku']) {
  if (!Array.isArray(imageKinds) || imageKinds.some(kind => !['main','detail','sku'].includes(kind))) throw new Error('图片类型无效。');
  const selected = new Set(imageKinds);
  const entries = [];
  for (const job of task?.jobs || []) {
    const products = (job.groups || []).map(group => group.best)
      .filter(item => item && validProductTitle(item.title, job.keyword)).slice(0, outputLimit(job));
    for (const item of products) {
      const common = { platform: item.site || job.site || 'pdd', product_id: String(item.id ?? ''), title: String(item.title || ''), product_url: String(item.url || '') };
      const append = (kind, urls, sku = '') => urls.forEach((url, index) => {
        if (selected.has(kind) && typeof url === 'string' && url.trim()) entries.push(Object.freeze({ ...common, kind, sku, order: index + 1, url: url.trim() }));
      });
      append('main', Array.isArray(item.galleryImages) && item.galleryImages.some(url => typeof url === 'string' && url.trim()) ? item.galleryImages : [item.image]);
      append('detail', Array.isArray(item.detailImages) ? item.detailImages : []);
      (Array.isArray(item.skus) ? item.skus : []).forEach((sku, index) => {
        if (selected.has('sku') && typeof sku?.image === 'string' && sku.image.trim()) entries.push(Object.freeze({ ...common, kind: 'sku', sku: String(sku.id || (sku.specs || []).join(' / ') || `SKU ${index + 1}`), order: index + 1, url: sku.image.trim() }));
      });
    }
  }
  return Object.freeze(entries);
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
      // Never surface a server URL/body that could accidentally include credentials.
      const messages = {401:'连接码已失效，请重新连接。',403:'本地工具未授权此扩展，请使用同一管理页的连接码重新连接。',409:'本地工具正在处理其他任务，或任务已失效，请先在工具中处理。',404:'本地任务或图片尚不可用。'};
      const error = new Error(messages[response.status] || `本地工具请求失败（${response.status}）。`);
      error.status = response.status; throw error;
    }
    return blob ? response.blob() : response.json();
  }
}

export class ConversionController {
  constructor({ client, onChange = () => {} }) {
    this.client = client; this.onChange = onChange; this.epoch = 0;
    this.job = null; this.entries = null; this.sourceTaskId = null; this.pendingSource = null;
    this.outputDir = ''; this.working = false; this.error = '';
    this.reconnectCandidate = null;
    this.restored = false;
    this.capabilities = null;
    // Restore ownership synchronously: deletion/clear must work before the first GET.
    try {
      const handle = JSON.parse(client.storage?.getItem(OWNED_JOB_KEY) || 'null');
      if (handle) {
        if (!client.connection || typeof handle.job_id !== 'string' || !handle.job_id || typeof handle.source_task_id !== 'string' || !handle.source_task_id || !Array.isArray(handle.products) || !handle.products.length || handle.products.some(product => !['pdd','1688','taobao'].includes(product?.platform) || typeof product.product_id !== 'string' || !product.product_id)) throw new Error('Invalid owned handle');
        this.job = { id: handle.job_id, kind: 'collector', source_task_id: handle.source_task_id, status: 'recovering', items: [] };
        this.sourceTaskId = handle.source_task_id;
        this.entries = Object.freeze(handle.products.map(product => Object.freeze({ platform: product.platform, product_id: product.product_id })));
        this.restored = true;
      }
    } catch { client.storage?.removeItem(OWNED_JOB_KEY); }
  }
  persistOwnership() {
    const products = new Map();
    for (const entry of this.entries || []) products.set(JSON.stringify([entry.platform,entry.product_id]), { platform: entry.platform, product_id: entry.product_id });
    this.client.storage?.setItem(OWNED_JOB_KEY, JSON.stringify({ job_id: this.job.id, source_task_id: this.sourceTaskId, products: [...products.values()] }));
  }
  async restoreForTask(task) {
    if (!this.restored) return;
    this.restored = false;
    if (this.sourceTaskId !== task?.id) { await this.clear(); return; }
    await this.poll();
  }
  view() { return { job: this.job, capabilities: this.capabilities, connected: Boolean(this.client.connection), outputDir: this.outputDir, working: this.working, error: this.error, canForget: Boolean(this.reconnectCandidate) }; }
  async readCapabilities(connection) {
    try { return await this.client.request('capabilities', { connection }); }
    catch (error) { if (error.status === 404) return { providers:['doubao'], legacy:true, aliyun_configured:false, aliyun_price_per_image:0.06 }; throw error; }
  }
  async refreshCapabilities() {
    if (this.working) throw new Error('请等待当前操作完成。');
    return this.guarded(async epoch => {
      this.capabilities = null; this.emit();
      const capabilities = await this.readCapabilities(this.client.connection);
      if (this.current(epoch)) { this.capabilities = capabilities; this.emit(); }
    });
  }
  canReconnect() { return !this.pendingSource && (!this.job || ['completed','done','paused','stopped','blocked'].includes(this.job.status) || Boolean(this.error)); }
  acceptSnapshot(snapshot, jobId) {
    if (snapshot?.id !== jobId || snapshot.kind !== 'collector' || snapshot.source_task_id !== this.sourceTaskId) throw new Error('本地任务与当前图片批次不一致，请在本地工具中检查。');
    this.job = { ...snapshot, provider: snapshot.provider || 'doubao', image_kinds: snapshot.image_kinds || ['main','detail','sku'], paid_calls: snapshot.paid_calls || 0 };
    if (typeof snapshot.output_dir === 'string') this.outputDir = snapshot.output_dir;
    const refs = snapshot.items?.flatMap(item => item.refs || []);
    if (refs?.length) this.entries = Object.freeze(refs.map(ref => Object.freeze({ ...ref })));
  }
  forgetStale() {
    if (!this.reconnectCandidate || this.working) throw new Error('请先使用新连接码验证本地工具。');
    const connection = this.reconnectCandidate;
    ++this.epoch; this.reconnectCandidate = null;
    this.job = null; this.entries = null; this.sourceTaskId = null; this.pendingSource = null; this.restored = false;
    this.client.storage?.removeItem(OWNED_JOB_KEY); this.client.remember(connection);
    this.capabilities = null; this.outputDir = ''; this.error = ''; this.emit();
  }
  emit() { this.onChange(this.view()); }
  current(epoch) { return epoch === this.epoch; }
  async guarded(operation) {
    const epoch = this.epoch;
    this.working = true; this.error = ''; this.emit();
    try { return await operation(epoch); }
    catch (error) { if (this.current(epoch)) { this.error = error.message; this.emit(); } throw error; }
    finally { if (this.current(epoch)) { this.working = false; this.emit(); } }
  }
  async connect(code) {
    if (!this.canReconnect() || this.working) throw new Error('请先处理当前图片批次，再更换连接。');
    const ownedJob = this.job && !['completed','done'].includes(this.job.status) ? this.job : null;
    this.reconnectCandidate = null;
    ++this.epoch;
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
        this.acceptSnapshot(snapshot, ownedJob.id);
        this.capabilities = capabilities; this.client.remember(connection); this.persistOwnership(); this.restored = false; this.emit();
        return;
      }
      const capabilities = await this.readCapabilities(connection);
      if (this.current(epoch)) { this.capabilities = capabilities; this.client.remember(connection); this.outputDir = ''; this.emit(); }
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
    if (!outputDir) throw new Error('请先选择本地保存文件夹。');
    const imageKinds = Object.freeze([...new Set(options.imageKinds ?? ['main','detail','sku'])]);
    if (!imageKinds.length) throw new Error('请至少选择一种图片类型。');
    const provider = options.provider ?? 'doubao', paidConfirmed = options.paidConfirmed === true;
    if (!['doubao','aliyun'].includes(provider)) throw new Error('图片转换模式无效。');
    if (provider === 'aliyun' && !paidConfirmed) throw new Error('请确认付费后开始阿里云转换。');
    const entries = buildImageManifest(task, imageKinds);
    if (!entries.length) throw new Error('当前可导出的商品没有图片。');
    const sourceTaskId = task.id, connection = this.client.connection;
    this.pendingSource = { id: sourceTaskId, entries };
    return this.guarded(async epoch => {
      let snapshot;
      try {
        if (provider === 'aliyun') {
          const capabilities = await this.readCapabilities(connection);
          if (!this.current(epoch)) return;
          this.capabilities = capabilities; this.emit();
          if (!capabilities.providers?.includes('aliyun')) throw new Error('本地工具需升级到支持阿里云的版本。');
          if (capabilities.aliyun_configured !== true) throw new Error('请先在本地工具配置阿里云密钥，再刷新配置状态。');
        }
        if (!this.current(epoch)) return;
        snapshot = await this.client.request('jobs', { body: { source_task_id: sourceTaskId, output_dir: outputDir, entries, provider, image_kinds:imageKinds, paid_confirmed:paidConfirmed }, connection });
      }
      finally { if (this.current(epoch)) this.pendingSource = null; }
      if (!this.current(epoch)) {
        if (snapshot?.id) await this.client.request('action', { body: { job_id: snapshot.id, source_task_id: sourceTaskId, action: 'cancel' }, connection }).catch(() => {});
        return;
      }
      if (snapshot?.kind !== 'collector' || snapshot.source_task_id !== sourceTaskId || !snapshot.id) throw new Error('本地任务与当前图片批次不一致，请在本地工具中检查。');
      this.entries = entries; this.sourceTaskId = sourceTaskId; this.outputDir = outputDir;
      this.acceptSnapshot({ ...snapshot, provider:snapshot.provider || provider, image_kinds:snapshot.image_kinds || imageKinds }, snapshot.id);
      this.persistOwnership(); this.emit();
    });
  }
  async poll() {
    if (!this.job) return;
    const epoch = this.epoch, jobId = this.job.id;
    try {
      const snapshot = await this.client.request(`state?job_id=${encodeURIComponent(jobId)}`);
      if (this.current(epoch) && this.job?.id === jobId) {
        this.acceptSnapshot(snapshot, jobId);
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
      const snapshot = await this.client.request('action', { body: { job_id: job?.id || null, source_task_id: this.sourceTaskId || taskId || null, action, ...(index === undefined ? {} : { index }), ...(paidRedo ? {paid_confirmed:true} : {}) } });
      if (this.current(epoch) && job && this.job?.id === job.id) { this.acceptSnapshot(snapshot, job.id); this.emit(); }
    });
  }
  async clear() {
    const job = this.job, sourceTaskId = this.sourceTaskId, connection = this.client.connection;
    ++this.epoch;
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
