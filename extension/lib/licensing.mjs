// Permission always comes from the paired local tool; dates here are display only.
export function licenseError(license, fallback = '授权不可用，请连接本地工具并激活或刷新授权。') {
  const error = new Error(typeof license?.message === 'string' && license.message.trim() ? license.message : fallback);
  error.licenseDenied = true; error.license = license; return error;
}

export class LicenseAuthority {
  constructor({ client, onChange = () => {} }) {
    this.client = client; this.onChange = onChange; this.status = null; this.capabilities = null; this.revision = 0; this.listeners = new Set();
    client.subscribeDenial(status => this.accept(status));
  }
  reset(capabilities = null) { this.invalidate(); this.capabilities = capabilities; this.accept({allowed:false,status:'unavailable',message:'本地工具授权状态待检查，请检查授权后手动继续采集。'}); }
  invalidate() { ++this.revision; this.client.invalidateRequests(); }
  subscribe(listener) { this.listeners.add(listener); if (this.status) listener(this.status); return () => this.listeners.delete(listener); }
  accept(status) {
    this.status = status && typeof status === 'object' ? status : {allowed:false,status:'unavailable'};
    // A newer denial also supersedes HTTP 200 snapshots already in flight.
    // Keep error request generations separate so the current denial is displayed.
    if (this.status.allowed !== true) this.client.invalidateSnapshotResponses?.();
    for (const listener of this.listeners) listener(this.status);
    this.onChange(); return this.status;
  }
  async check({ refresh = false, code } = {}) {
    const revision = this.revision, connection = this.client.connection;
    try {
      if (!connection) throw licenseError(null,'请先复制本地工具的连接码并连接，再激活月度授权。');
      if (!this.capabilities) this.capabilities = await this.client.request('capabilities', {connection});
      if (this.capabilities?.licensing !== true) throw licenseError(null,'请升级本地工具到支持月度授权的版本，再重新连接。');
      const route = code === undefined ? refresh ? 'refresh' : 'status' : 'activate';
      const status = await this.client.request(`license/${route}`, {connection,...(route === 'status' ? {} : {body:route === 'activate' ? {code} : {}})});
      if (revision !== this.revision || connection !== this.client.connection) throw licenseError(null,'本地工具连接已变化，请重新检查授权。');
      return this.accept(status);
    } catch (error) {
      const denied = error.licenseDenied ? error : licenseError(null,error.status === 404 ? '请升级本地工具到支持月度授权的版本，再重新连接。' : error.message);
      if (revision === this.revision) this.accept({allowed:false,status:'unavailable',message:denied.message});
      throw denied;
    }
  }
  async require(options) { const status = await this.check(options); if (status.allowed !== true) throw licenseError(status); return status; }
  activate(code) {
    const value = String(code || '').trim();
    if (!value) throw licenseError(null,'请输入月度授权码；授权码与本地工具连接码不同。');
    return this.check({code:value});
  }
}
