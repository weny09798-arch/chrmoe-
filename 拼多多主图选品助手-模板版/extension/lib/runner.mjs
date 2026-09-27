import { addCandidate, countDetails, hasDetailData, parsePrice, selected, validProductTitle, SCAN_LIMIT } from './core.mjs';

const finished = status => ['done', 'short', 'error', 'stopped'].includes(status);
export class Runner {
  constructor(task, ports) { this.task = task; this.ports = ports; this.intent = ''; this.running = false; }
  pause() { this.intent = 'paused'; }
  stop() { this.intent = 'stopped'; }
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
    } finally { await this.ports.close?.(); this.running = false; this.ports.update(this.task); }
  }
  async collect(job) {
    let stalled = 0, noCardProgress = 0, previousSnapshot = '';
    const processedKeys = new Set(job.seen), replayedKeys = new Set();
    const noCardProgressLimit = Math.min(60, Math.max(8, job.scrolls + 8));
    while (!this.intent && job.scanned < SCAN_LIMIT && selected(job).length < 20) {
      const page = await this.ports.read(job);
      if (this.intent) return;
      if (page.blocked) throw Object.assign(new Error(page.reason || '请处理登录或验证码后继续'), { blocked: true });
      const fresh = page.cards.filter(c => !job.seen.includes(c.key));
      const snapshot = JSON.stringify([page.position ?? null, page.cards.map(c => c.key)]);
      let navigated = false;
      for (const raw of fresh) {
        if (this.intent || job.scanned >= SCAN_LIMIT || selected(job).length >= 20) break;
        let candidate, problem = '';
        try {
          if (!validProductTitle(raw.title, job.keyword)) throw new Error('商品名称与搜索名称无关联，或仅识别到平台标签');
          const cents = parsePrice(raw.priceText);
          if (cents === null) throw new Error('展示价格无法明确识别');
          const fingerprint = await this.ports.hash(raw.image);
          if (this.intent) return;
          const resolved = raw.id ? raw : await this.ports.resolve(raw, page, job);
          if (this.intent) return;
          navigated ||= Boolean(resolved.navigated);
          if (!resolved.id || !resolved.url) throw new Error('未识别到商品详情链接');
          candidate = { ...resolved, cents, fingerprint, collectedAt: new Date().toISOString() };
        } catch (error) {
          if (this.intent) return;
          if (error.blocked || error.fatal) throw error;
          problem = error.message;
        }
        if (candidate) addCandidate(job, candidate);
        else { job.skipped++; job.lastSkip = problem; }
        job.seen.push(raw.key); processedKeys.add(raw.key); job.scanned++;
        await this.checkpoint();
        // A detail-page visit replaces the DOM; reread before using other card descriptors.
        if (navigated) break;
      }
      if (this.intent) return;
      if (selected(job).length >= 20 || job.scanned >= SCAN_LIMIT || (page.end && !navigated)) break;
      if (fresh.length) { stalled = 0; noCardProgress = 0; }
      else {
        let newlyReplayed = false;
        for (const card of page.cards) {
          if (!processedKeys.has(card.key) || replayedKeys.has(card.key)) continue;
          replayedKeys.add(card.key); newlyReplayed = true;
        }
        stalled = snapshot === previousSnapshot ? stalled + 1 : 0;
        noCardProgress = newlyReplayed ? 0 : noCardProgress + 1;
        if (stalled >= 8 || noCardProgress >= noCardProgressLimit) throw new Error(job.scanned ? '列表加载停滞，未确认到达末尾；已保留当前结果' : '未识别到商品结果，请确认搜索页可用；可能需要适配当前页面');
      }
      previousSnapshot = snapshot;
      if (!navigated) { await this.ports.scroll(); job.scrolls++; }
      await this.ports.wait(1300);
    }
    if (this.intent) return;
    job.searchStatus = selected(job).length >= 20 ? 'done' : 'short';
    job.phase = 'detail';
    job.status = 'running';
    job.note = `${selected(job).length >= 20 ? '已收集20条，转到下一名称' : job.scanned >= SCAN_LIMIT ? '已扫描至200条上限' : '页面提示搜索结束'}；保留 ${selected(job).length}/20 组`;
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
        const detail = await this.ports.enrich(item);
        Object.assign(item, detail);
        item.detailStatus = hasDetailData(item) ? 'done' : 'partial';
        item.detailNote = item.detailStatus === 'partial' ? '仅采集到基础商品信息' : '';
      } catch (error) {
        if (error.blocked) {
          item.detailStatus = 'pending'; item.detailNote = '';
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
    const failures = items.filter(item => item.detailStatus === 'error').length;
    job.phase = 'done';
    job.status = job.searchStatus || (items.length >= 20 ? 'done' : 'short');
    job.note = `${job.note || `保留 ${items.length}/20 组`}；详情完成 ${items.length - failures}，失败 ${failures}`;
    await this.checkpoint();
  }
}
