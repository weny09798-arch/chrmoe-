import { parseConnectionCode } from './image-conversion.mjs';

const INSTALL_ERROR = '后台未安装或启动失败，请按安装说明登记当前插件编号，然后重新连接。';
const UPGRADE_ERROR = '请升级后台组件到 1.6.6 或更新版本后重新连接。';
export class NativeBackendBroker {
  constructor({ runtime, setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
    this.runtime = runtime; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.port = null; this.connectionCode = null; this.pending = new Map(); this.serial = 0; this.connecting = null; this.heartbeat = null;
  }
  drop(error = new Error(INSTALL_ERROR)) {
    const port = this.port; this.port = null; this.connectionCode = null;
    if (this.heartbeat !== null) this.clearTimer(this.heartbeat);
    this.heartbeat = null;
    for (const request of this.pending.values()) { this.clearTimer(request.timer); request.reject(error); }
    this.pending.clear();
    try { port?.disconnect(); } catch {}
  }
  open() {
    if (this.port) return;
    let port;
    try { port = this.runtime.connectNative('com.productcollector.images'); } catch { throw new Error(INSTALL_ERROR); }
    this.port = port;
    port.onDisconnect.addListener(() => {
      // Reading lastError prevents Chrome's unchecked error warning; never expose it.
      void this.runtime.lastError;
      if (this.port === port) this.drop();
    });
    port.onMessage.addListener(reply => {
      if (this.port !== port) return;
      const request = this.pending.get(reply?.id);
      if (!request) return;
      let error;
      if (!reply || reply.ok !== true) error = new Error(INSTALL_ERROR);
      else if (!/^1\.(?:[7-9]|[1-9][0-9]+)\.\d+$|^1\.6\.(?:[6-9]|[1-9][0-9]+)$/.test(reply.version || '')) error = new Error(UPGRADE_ERROR);
      else if (request.action === 'connect') {
        try { parseConnectionCode(reply.connection_code); } catch { error = new Error(INSTALL_ERROR); }
      }
      if (error) { this.drop(error); return; }
      this.clearTimer(request.timer); this.pending.delete(reply.id); request.resolve(reply);
    });
  }
  request(action) {
    this.open(); const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => this.drop(), action === 'connect' ? 30000 : 10000);
      this.pending.set(id, { action, resolve, reject, timer });
      try { this.port.postMessage({ id, action }); } catch { this.drop(); }
    });
  }
  pingLater() {
    this.heartbeat = this.setTimer(() => {
      this.heartbeat = null;
      const port = this.port;
      void this.request('ping').catch(() => {});
      if (this.port === port) this.pingLater();
    }, 20000);
  }
  ensureBackend() {
    if (this.connectionCode && this.port) return Promise.resolve(this.connectionCode);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const pending = this.request('connect'), port = this.port;
      const reply = await pending;
      if (this.port !== port) throw new Error(INSTALL_ERROR);
      this.connectionCode = reply.connection_code; this.pingLater(); return this.connectionCode;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
}

export async function handleBackendMessage(message, sender, broker, runtime) {
  if (message?.type !== 'ensure-backend' || sender?.id !== runtime.id || sender?.url !== runtime.getURL('manager.html')) return { ok:false, error:'仅插件管理页可以连接后台。' };
  try { return { ok:true, connection_code:await broker.ensureBackend() }; }
  catch (error) { return { ok:false, error:error.message }; }
}
