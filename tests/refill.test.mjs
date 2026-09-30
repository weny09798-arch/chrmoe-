import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefillScheduler } from '../extension/lib/refill.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function timers() {
  const pending = new Map(); let next = 0;
  return { setTimer(fn) { pending.set(++next, fn); return next; }, clearTimer(id) { pending.delete(id); },
    fire() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()); }, get count() { return pending.size; } };
}
test('rapid deletes debounce into one refill after the active operation settles', async () => {
  const clock = timers(); let finish, starts = 0;
  const active = new Promise(resolve => { finish = resolve; });
  const scheduler = createRefillScheduler({ ...clock, settle: () => active, flush: async () => { starts++; } });
  scheduler.schedule(); scheduler.schedule(); assert.equal(clock.count, 1);
  clock.fire(); await tick(); assert.equal(starts, 0);
  finish(); await scheduler.idle(); assert.equal(starts, 1);
});
test('stop or clear cancels a refill even while awaiting an active operation', async () => {
  const clock = timers(); let finish, starts = 0;
  const scheduler = createRefillScheduler({ ...clock, settle: () => new Promise(resolve => { finish = resolve; }), flush: async () => { starts++; } });
  scheduler.schedule(); clock.fire(); await tick(); scheduler.cancel(); finish();
  await scheduler.idle(); assert.equal(starts, 0);
  scheduler.schedule(); scheduler.cancel(); clock.fire(); await scheduler.idle(); assert.equal(starts, 0);
});
test('a later delete supersedes the waiting batch without parallel refill starts', async () => {
  const clock = timers(); let finish, starts = 0;
  const active = new Promise(resolve => { finish = resolve; });
  const scheduler = createRefillScheduler({ ...clock, settle: () => active, flush: async () => { starts++; } });
  scheduler.schedule(); clock.fire(); await tick(); scheduler.schedule(); clock.fire(); finish();
  await scheduler.idle(); assert.equal(starts, 1);
});

test('a cancelled flush cannot report a late save error or change the stopped task', async () => {
  const clock = timers(); let reject, errors = 0;
  const scheduler = createRefillScheduler({ ...clock, settle: async () => {},
    flush: () => new Promise((_resolve, fail) => { reject = fail; }), onError: () => { errors++; } });
  scheduler.schedule(); clock.fire(); await tick(); scheduler.cancel(); reject(new Error('quota'));
  await scheduler.idle(); assert.equal(errors, 0);
});
