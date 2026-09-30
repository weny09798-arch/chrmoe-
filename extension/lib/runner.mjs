import { addCandidate, countDetails, hasDetailData, outputLimit, parsePrice, priceAllowed, selected, validProductTitle, SCAN_LIMIT } from './core.mjs';
import { siteForJob } from './sites.mjs';

const finished = status => ['done', 'short', 'error', 'stopped'].includes(status);
export class Runner {
  constructor(task, ports) { this.task = task; this.ports = ports; this.intent = ''; this.running = false; }
  pause() { if (this.intent !== 'stopped') this.intent = 'paused'; this.refillPause = false; }
  pauseForRefill() { if (!this.intent) { this.intent = 'paused'; this.refillPause = true; } }
  stop() { this.intent = 'stopped'; this.refillPause = false; }
  async checkpoint() {
    for (const job of this.task.jobs) job.detailDone = countDetails(job);
    await this.ports.save(this.task); this.ports.update(this.task);
  }
  async run() {
    if (this.running) return;
    this.running = true; this.intent = ''; this.task.status = 'running';
    try {
      await this.checkpoint();
      for (const job of this.task.jobs) {
        if (finished(job.status)) continue;
        if (this.intent) break;
        try {
          job.status = 'running'; if (job.phase !== 'detail') job.note = ''; await this.checkpoint();
          if (job.phase === 'detail') await this.enrich(job);
          else { await this.ports.open(job, this.task); await this.collect(job); }
        } catch (error) {
          if (error.blocked) {
            // A user stop/pause that races with a verification response wins.
            // The current detail item was already reset to pending by enrich().
            if (this.intent && !this.refillPause) break;
            this.intent = ''; this.refillPause = false;
            this.task.status = 'blocked'; job.status = 'blocked'; job.note = error.message;
            this.task.permissionOrigin = error.permissionOrigin || ''; await this.checkpoint(); return;
          }
          job.status = 'error'; job.note = error.message || '采集失败'; await this.checkpoint();
        }
        if (this.intent || this.task.status === 'blocked') break;
      }
      if (this.intent) {
        this.task.status = this.intent;
        for (const job of this.task.jobs) {
          if (!finished(job.status) && (job.status === 'running' || this.intent === 'stopped')) job.status = this.intent;
        }
      } else if (this.task.status !== 'blocked') this.task.status = this.task.jobs.some(j => j.status === 'error') ? 'error' : 'done';
      await this.checkpoint();
    } finally {
      await this.ports.close?.({ preserveBlocked: this.task.status === 'blocked' });
      this.running = false; this.ports.update(this.task);
    }
  }
  async collect(job) {
    let stalled = 0, noCardProgress = 0, previousSnapshot = '', paginationWaits = 0, extractionFailures = 0;
    const processedKeys = new Set(job.seen), replayedKeys = new Set();
    const noCardProgressLimit = Math.min(60, Math.max(8, job.scrolls + 8));
    const limit = outputLimit(job);
    let awaitingPage = Array.isArray(job.paginationFromKeys) ? job.paginationFromKeys : null;
    if (job.merged == null && !job.skipReasons) { job.statsStart = job.scanned || 0; job.statsStartSkipped = job.skipped || 0; }
    job.merged ??= 0; job.excluded ??= 0; job.skipReasons ||= {};
    while (!this.intent && job.scanned < SCAN_LIMIT && selected(job).length < limit) {
      const page = await this.ports.read(job);
      if (page.blocked && this.refillPause) throw Object.assign(new Error(page.reason || '请处理登录或验证码后继续'), { blocked: true });
      if (this.intent) return;
      if (page.blocked) throw Object.assign(new Error(page.reason || '请处理登录或验证码后继续'), { blocked: true });
      if (page.paginationError) throw new Error(page.paginationError);
      if (page.paginationPending || awaitingPage && !page.noResults && !page.cards.some(c=>!awaitingPage.includes(c.key))) {
        if (++paginationWaits > 20) throw new Error('淘宝翻页等待超时，已保留当前结果；请检查采集页后重新搜索');
        job.note = '正在翻到下一页，等待新商品加载';
        await this.checkpoint(); await this.ports.wait(1300); continue;
      }
      if (paginationWaits || awaitingPage) { stalled = 0; noCardProgress = 0; previousSnapshot = ''; job.note = ''; }
      paginationWaits = 0;
      awaitingPage = null; delete job.paginationFromKeys;
      const fresh = page.cards.filter(c => !job.seen.includes(c.key));
      const snapshot = JSON.stringify([page.url ?? '', page.position ?? null, page.cards.map(c => c.key)]);
      let navigated = false;
      for (let raw of fresh) {
        if (this.intent || job.scanned >= SCAN_LIMIT || selected(job).length >= limit) break;
        let candidate, problem = '', skipReason = '其他原因';
        try {
          if (job.site === 'taobao' && this.ports.prepareCard) {
            skipReason = '页面商品变化';
            raw = await this.ports.prepareCard(raw,job,()=>Boolean(this.intent));
            if (this.intent) return;
          }
          skipReason = '名称未识别';
          if (!validProductTitle(raw.title, job.keyword)) throw new Error('商品名称与搜索名称无关联，或仅识别到平台标签');
          skipReason = '价格未识别';
          const cents = parsePrice(raw.priceText);
          if (cents === null) throw new Error('展示价格无法明确识别');
          skipReason = '价格不在区间';
          if (!priceAllowed(cents, job)) throw new Error('展示价格不在设定区间内');
          skipReason = '主图未识别';
          if (!raw.image) throw new Error('未识别到商品主图，已跳过');
          skipReason = '主图读取失败';
          const fingerprint = await this.ports.hash(raw.image);
          if (this.intent) return;
          skipReason = '链接未识别';
          const resolved = raw.id ? raw : await this.ports.resolve(raw, page, job);
          if (this.intent) return;
          navigated ||= Boolean(resolved.navigated);
          if (!resolved.id || !resolved.url) throw new Error('未识别到商品详情链接');
          const site = siteForJob(job);
          candidate = { ...resolved, cents, fingerprint, collectedAt: new Date().toISOString(), site: site.id, platform: site.platformForUrl?.(resolved.url) || site.label };
        } catch (error) {
          if (this.intent && !this.refillPause) return;
          if (error.blocked || error.fatal) throw error;
          if (this.intent) return;
          problem = error.message;
        }
        if (candidate) {
          const count = job.groups.length;
          if (!addCandidate(job, candidate)) job.excluded = (job.excluded || 0) + 1;
          else if (job.groups.length === count) job.merged = (job.merged || 0) + 1;
        } else {
          job.skipped++; job.lastSkip = problem;
          job.skipReasons ||= {}; job.skipReasons[skipReason] = (job.skipReasons[skipReason] || 0) + 1;
        }
        job.seen.push(raw.key); processedKeys.add(raw.key); job.scanned++;
        await this.checkpoint();
        extractionFailures = !candidate && ['名称未识别','价格未识别','主图未识别','页面商品变化'].includes(skipReason) ? extractionFailures + 1 : 0;
        if (job.site === 'taobao' && extractionFailures >= 5) throw new Error('连续 5 条商品在加载重读后仍无法识别，已停止本名称并保留结果；当前淘宝页面需要进一步适配');
        // A detail-page visit replaces the DOM; reread before using other card descriptors.
        if (navigated) break;
      }
      if (this.intent) return;
      if (selected(job).length >= limit || job.scanned >= SCAN_LIMIT || (page.end && !navigated)) break;
      if (fresh.length) { stalled = 0; noCardProgress = 0; }
      else {
        let newlyReplayed = false;
        for (const card of page.cards) {
          if (!processedKeys.has(card.key) || replayedKeys.has(card.key)) continue;
          replayedKeys.add(card.key); newlyReplayed = true;
        }
        stalled = snapshot === previousSnapshot ? stalled + 1 : 0;
        noCardProgress = newlyReplayed ? 0 : noCardProgress + 1;
        if (stalled >= 8 || noCardProgress >= noCardProgressLimit) throw new Error(job.scanned || selected(job).length ? '列表加载停滞，未确认到达末尾；已保留当前结果' : '未识别到商品结果，请确认搜索页可用；可能需要适配当前页面');
      }
      previousSnapshot = snapshot;
      if (!navigated) {
        const scrolling = await this.ports.scroll(); job.scrolls++;
        if (scrolling?.paginationPending) {
          awaitingPage = page.cards.map(c=>c.key); job.paginationFromKeys = awaitingPage;
          await this.checkpoint();
        }
      }
      await this.ports.wait(1300);
    }
    if (this.intent) return;
    const full = selected(job).length >= limit;
    job.searchStatus = full ? 'done' : 'short';
    job.phase = 'detail';
    job.status = 'running';
    job.note = `${full ? `已收集${limit}条，转到下一名称` : job.scanned >= SCAN_LIMIT ? '已扫描至200条上限' : '页面提示搜索结束'}；保留 ${selected(job).length}/${limit} 组`;
    if (job.skipped) job.note += `；跳过 ${job.skipped} 条，最近原因：${job.lastSkip}`;
    await this.checkpoint();
    await this.enrich(job);
  }
  async enrich(job) {
    for (const item of selected(job)) {
      if (this.intent) return;
      if (['done', 'partial', 'error'].includes(item.detailStatus)) continue;
      item.detailStatus = 'running'; item.detailNote = '';
      await this.checkpoint();
      try {
        const detail = await this.ports.enrich(item, this.task);
        Object.assign(item, detail);
        item.detailStatus = detail.detailStatus === 'partial' || !hasDetailData(item) ? 'partial' : 'done';
        item.detailNote = detail.detailNote || (item.detailStatus === 'partial' ? '仅采集到基础商品信息' : '');
      } catch (error) {
        if (error.blocked) {
          item.detailStatus = 'pending'; item.detailNote = String(error.message || '详情页等待处理').slice(0, 500);
          await this.checkpoint();
          throw error;
        }
        item.detailStatus = 'error';
        item.detailNote = String(error.message || '详情采集失败').slice(0, 500);
      }
      await this.checkpoint();
    }
    if (this.intent) return;
    const items = selected(job);
    const complete = items.filter(item => item.detailStatus === 'done').length;
    const partial = items.filter(item => item.detailStatus === 'partial').length;
    const failures = items.filter(item => item.detailStatus === 'error').length;
    job.phase = 'done';
    const kept = outputLimit(job);
    job.status = job.searchStatus || (items.length >= kept ? 'done' : 'short');
    job.note = `${job.note || `保留 ${items.length}/${kept} 组`}；详情完整 ${complete}，部分 ${partial}，失败 ${failures}`;
    await this.checkpoint();
  }
}
