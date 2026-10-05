import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createTask, addCandidate } from '../extension/lib/core.mjs';

const html = await readFile(new URL('../extension/manager.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(status = 'done', create = async () => { throw new Error('结束测试搜索'); }) {
  const { document, window } = parseHTML(html); const task = createTask(['相机']); const job = task.jobs[0];
  job.limit = 2; job.priceMin = 500; job.priceMax = 2000;
  for (const [id, color] of [['1',100],['2',250]]) addCandidate(job, {
    id, title: `相机商品${id}`, cents: 1000, image: `https://img.pddpic.com/search-${id}.jpg`,
    galleryImages: id === '1' ? ['https://img.pddpic.com/first.jpg', 'https://img.pddpic.com/second.jpg'] : [],
    detailStatus: 'done', url: `https://mobile.pinduoduo.com/goods.html?goods_id=${id}`,
    fingerprint: { bits: '0000000000000000', color: [color,100,100], spread: 50 }
  });
  task.status = status; job.status = status; job.phase = status === 'done' ? 'done' : 'search';
  job.seen = ['1','2']; job.scanned = 200;
  const saved = { keywords: ['相机'], task }; let tabCreates = 0;
  const timers = new Map(); let next = 0; const originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = fn => { timers.set(++next, fn); return next; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.document = document; globalThis.window = window;
  globalThis.chrome = { runtime: { id: 'test-extension' },
    storage: { local: { get: async () => saved, set: async values => Object.assign(saved, structuredClone(values)) } },
    tabs: { create: async () => { tabCreates++; return create(); }, remove: async () => {} }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name,_options,callback) => callback({}) } } });
  await import(`../extension/manager.mjs?preview=${Math.random()}`); await tick();
  const panel = document.getElementById('links-panel'); panel.open = true; panel.dispatchEvent(new window.Event('toggle'));
  return { document, window, saved, get tabCreates() { return tabCreates; }, get timerCount() { return timers.size; },
    click: id => document.getElementById(id).dispatchEvent(new window.Event('click')),
    remove: id => document.querySelector(`[data-remove-product="${id}"]`)?.dispatchEvent(new window.Event('click')),
    fire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); },
    cleanup: () => { globalThis.setTimeout = originalTimer; globalThis.clearTimeout = originalClear; timers.clear(); }
  };
}
test('results display first product image, fallback image and an accessible removal control', async () => {
  const f = await fixture();
  try {
    const images = f.document.querySelectorAll('#link-rows img');
    assert.equal(images.length, 2); assert.equal(images[0].getAttribute('src'), 'https://img.pddpic.com/first.jpg');
    assert.equal(images[1].getAttribute('src'), 'https://img.pddpic.com/search-2.jpg');
    assert.match(f.document.querySelector('[data-remove-product="1"]').getAttribute('aria-label'), /删除.*相机商品1/);
    images[0].dispatchEvent(new f.window.Event('error'));
    assert.match(f.document.getElementById('link-rows').textContent, /暂无图片/);
  } finally { f.cleanup(); }
});
test('multiple deletes save exclusions immediately and trigger one refill while keeping filters', async () => {
  const f = await fixture();
  try {
    f.remove('1'); f.remove('2'); await tick(); await tick();
    assert.equal(f.saved.task.jobs[0].groups.length, 0); assert.equal(f.saved.task.jobs[0].exclusions.length, 2);
    assert.equal(f.document.querySelectorAll('#link-rows [data-remove-product]').length, 0);
    assert.equal(f.tabCreates, 0); assert.equal(f.timerCount, 1);
    f.fire(); for (let i=0;i<6;i++) await tick();
    assert.equal(f.tabCreates, 1); assert.equal(f.saved.task.jobs[0].phase, 'search');
    assert.equal(f.saved.task.jobs[0].scanned, 200); assert.deepEqual(f.saved.task.jobs[0].seen, ['1','2']);
    assert.equal(f.saved.task.jobs[0].restartSearch,false);
    assert.equal(f.saved.task.jobs[0].limit, 2); assert.equal(f.saved.task.jobs[0].priceMin, 500);
    assert.equal(f.saved.task.jobs[0].exclusions.length, 2);
  } finally { f.cleanup(); }
});
test('deleting while paused prepares refill and waits for the user to continue', async () => {
  const f = await fixture('paused');
  try {
    f.remove('1'); f.fire(); for (let i=0;i<4;i++) await tick();
    assert.equal(f.tabCreates, 0); assert.equal(f.saved.task.status, 'paused');
    assert.equal(f.saved.task.jobs[0].phase, 'search'); assert.equal(f.saved.task.jobs[0].groups.length, 1);
    f.click('resume'); for (let i=0;i<5;i++) await tick(); assert.equal(f.tabCreates, 1);
  } finally { f.cleanup(); }
});

test('deleting after Stop waits for Continue without automatically restarting', async () => {
  const f = await fixture('stopped');
  try {
    f.remove('1'); f.fire(); for (let i=0;i<4;i++) await tick();
    assert.equal(f.tabCreates, 0);
    assert.equal(f.saved.task.status, 'paused');
    assert.equal(f.saved.task.jobs[0].status, 'paused');
    assert.equal(f.document.getElementById('resume').hidden, false);
    f.click('resume'); for (let i=0;i<5;i++) await tick(); assert.equal(f.tabCreates, 1);
  } finally { f.cleanup(); }
});
test('clear cancels scheduled refill and leaves no deleted results or task', async () => {
  const f = await fixture();
  try {
    f.remove('1'); f.click('clear-all'); f.fire(); for (let i=0;i<5;i++) await tick();
    assert.equal(f.saved.task, null); assert.equal(f.tabCreates, 0); assert.deepEqual(f.saved.keywords, []);
  } finally { f.cleanup(); }
});

test('refill storage failure exposes Continue and does not start another search', async () => {
  const f = await fixture();
  try {
    f.remove('1'); await tick();
    chrome.storage.local.set = async () => { throw new Error('storage quota'); };
    f.fire(); for (let i=0;i<5;i++) await tick();
    assert.equal(f.tabCreates, 0);
    assert.equal(f.document.getElementById('resume').hidden, false);
    assert.match(f.document.getElementById('notice').textContent, /补搜准备失败/);
  } finally { f.cleanup(); }
});
test('stop during an active deletion prevents automatic restart after the pending operation returns', async () => {
  let reject; const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const f = await fixture('paused', () => pending);
  try {
    f.click('resume'); await tick(); assert.equal(f.tabCreates, 1);
    f.remove('1'); f.fire(); await tick(); f.click('stop'); reject(new Error('结束正在打开的采集页'));
    for (let i=0;i<6;i++) await tick();
    assert.equal(f.tabCreates, 1); assert.equal(f.saved.task.status, 'stopped');
    assert.equal(f.saved.task.jobs[0].groups.length, 1); assert.equal(f.saved.task.jobs[0].exclusions.length, 1);
  } finally { f.cleanup(); }
});
