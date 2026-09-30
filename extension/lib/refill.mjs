// Debounce edits and serialize refill against the existing collection operation.
export function createRefillScheduler({ settle, flush, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0, timer = null, tail = Promise.resolve();
  function cancel() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    cancel();
    const version = generation;
    timer = setTimer(() => {
      timer = null;
      tail = tail.catch(() => {}).then(async () => {
        await settle();
        if (version === generation) await flush(() => version === generation);
      }).catch(error => { if (version === generation) onError(error); });
    }, 1000);
  }
  return { schedule, cancel, idle: () => tail };
}
