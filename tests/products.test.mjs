import test from 'node:test';
import assert from 'node:assert/strict';
import * as products from '../extension/lib/products.mjs';
import { createTask, addCandidate, retryJob, selected, recoverTask } from '../extension/lib/core.mjs';
import { taskSheets } from '../extension/lib/xlsx.mjs';
import { Runner } from '../extension/lib/runner.mjs';

const fp = color => ({ bits: '0000000000000000', color: [color, 100, 100], spread: 50 });
const item = (id, color = 100) => ({ id, title: '相机商品', cents: 1000,
  image: `https://img.pddpic.com/${id}.jpg`, url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`, fingerprint: fp(color) });
function fixture() {
  const task = createTask(['相机']); const job = task.jobs[0]; job.limit = 2;
  addCandidate(job, item('1')); addCandidate(job, { ...item('2'), cents: 900 });
  addCandidate(job, { ...item('3', 250), descriptionText: '保留详情', detailStatus: 'done' });
  job.seen = ['1', '2', '3']; job.scanned = 200; job.phase = 'done'; job.status = 'done'; task.status = 'done';
  return { task, job };
}
test('preview selects the first safe gallery image and falls back to the search image', () => {
  assert.equal(products.productImage({ galleryImages: ['javascript:alert(1)', 'https://img.pddpic.com/main.jpg', 'https://img.pddpic.com/second.jpg'], image: 'https://img.pddpic.com/search.jpg' }), 'https://img.pddpic.com/main.jpg');
  assert.equal(products.productImage({ image: 'https://img.pddpic.com/search.jpg' }), 'https://img.pddpic.com/search.jpg');
  assert.equal(products.productImage({ image: 'http://unsafe.example/a.jpg' }), '');
});
test('deleting a winner removes its whole image group and prevents IDs and similar art from returning', () => {
  const { task, job } = fixture();
  assert.equal(products.removeProduct(job, '2'), true);
  assert.deepEqual(selected(job).map(x => x.id), ['3']);
  assert.equal(job.groups[0].best.descriptionText, '保留详情');
  assert.equal(products.removeProduct(job, '2'), false);
  const persisted = JSON.parse(JSON.stringify(task)); const restored = persisted.jobs[0];
  assert.equal(addCandidate(restored, { ...item('1', 350), cents: 100 }), false);
  assert.equal(addCandidate(restored, { ...item('8'), cents: 100 }), false);
  assert.equal(addCandidate(restored, { ...item('9', 350), image: 'https://img.pddpic.com/1.jpg' }), false);
  assert.deepEqual(taskSheets(persisted)[0].rows.slice(9).map(row => row[6]), ['3']);
  assert.equal(restored.refillRequested, true);
});
test('refill preserves history, details, filters and target while renewing the scan budget', () => {
  const { job } = fixture(); job.priceMin = 500; job.priceMax = 5000;
  products.removeProduct(job, '2'); products.prepareRefill(job);
  assert.equal(job.scanned, 0); assert.deepEqual(job.seen, ['1', '2', '3']);
  assert.equal(job.limit, 2); assert.equal(job.priceMin, 500); assert.equal(job.priceMax, 5000);
  assert.equal(job.phase, 'search'); assert.equal(job.status, 'pending'); assert.equal(job.refillRequested, false);
  assert.equal(job.groups[0].best.detailStatus, 'done');
  addCandidate(job, { ...item('10', 250), cents: 100 });
  assert.equal(job.groups[0].best.id, '3');
  assert.equal(job.groups[0].best.descriptionText, '保留详情');
});

test('automatic refill pause preserves a verification response and manual stop stays stopped', async () => {
  for (const intent of ['automatic', 'stop']) {
    const { task, job } = fixture(); job.status = 'pending'; job.phase = 'search'; job.scanned = 0; job.limit = 3;
    let collector;
    collector = new Runner(task, {
      open: async () => {}, close: async () => {}, save: async () => {}, update() {},
      read: async () => {
        if (intent === 'stop') collector.stop();
        collector.pauseForRefill();
        return { blocked: true, reason: '请完成验证码', cards: [] };
      }
    });
    await collector.run();
    assert.equal(task.status, intent === 'automatic' ? 'blocked' : 'stopped');
    assert.equal(job.status, task.status);
  }
});
test('manual retry and recovery retain exclusions and a persisted refill request', () => {
  const { task, job } = fixture(); products.removeProduct(job, '2');
  const recovered = recoverTask(JSON.parse(JSON.stringify(task)));
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.jobs[0].phase, 'search');
  assert.equal(recovered.jobs[0].scanned, 0);
  retryJob(recovered, 0);
  assert.equal(addCandidate(recovered.jobs[0], item('2')), false);
  assert.equal(addCandidate(recovered.jobs[0], item('4')), false);
});
test('refill reaches the saved target with retained details and excludes cheap deleted lookalikes', async () => {
  const { task, job } = fixture(); products.removeProduct(job, '2'); products.prepareRefill(job);
  let reads = 0; const details = [];
  await new Runner(task, {
    open: async () => {}, close: async () => {}, save: async () => {}, update() {}, scroll: async () => {}, wait: async () => {},
    read: async () => { reads++; return { cards: ['1','2','3','4','5','6'].map(id => ({ ...item(id), key: id, priceText: '¥8.00' })), end: false }; },
    hash: async url => fp(url.endsWith('5.jpg') || url.endsWith('6.jpg') ? 400 : 100),
    enrich: async value => { details.push(value.id); return { descriptionText: '新详情' }; }
  }).run();
  assert.deepEqual(selected(job).map(x => x.id), ['3', '5']);
  assert.equal(reads, 1); assert.equal(job.scanned, 2); assert.equal(job.status, 'done');
  assert.deepEqual(details, ['5']); assert.equal(job.groups[0].best.descriptionText, '保留详情');
});
