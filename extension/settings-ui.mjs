const SECRET_FIELDS = ['settings-aliyun-id','settings-aliyun-secret','settings-oss-id','settings-oss-secret'];
function validKey(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\s/.test(value); }

export function createSettingsPanel({ document, client, getConnection = () => Boolean(client.connection), unavailable = () => false, refreshCapabilities = async () => {}, clipboard = globalThis.navigator?.clipboard, confirm = text => globalThis.confirm?.(text) === true } = {}) {
  const $ = id => document.getElementById(id);
  let working = false, epoch = 0, disposed = false, aliyun = null, oss = null;
  const inputs = [...document.querySelectorAll('#conversion-settings input, #conversion-settings select, #conversion-settings button')];
  function message(text, error = false) { if (disposed) return; $('settings-message').textContent = text; $('settings-message').hidden = !text; $('settings-message').className = `notice ${error ? 'error' : ''}`; }
  function clearSecrets() { for (const id of SECRET_FIELDS) $(id).value = ''; }
  function render() {
    if (disposed) return;
    const connected = getConnection(), disabled = !connected || working || unavailable();
    for (const input of inputs) input.disabled = disabled;
    const independent = $('settings-oss-mode').value === 'independent';
    for (const id of ['settings-oss-id','settings-oss-secret']) $(id).disabled = disabled || !independent;
    $('settings-aliyun-status').textContent = !connected ? '连接后台后查询配置' : !aliyun ? '配置状态待查询' : aliyun.aliyun_configured === true ? '密钥已加密保存（尚未验证云端服务）' : '尚未配置阿里云密钥';
    $('settings-oss-status').textContent = !connected ? '连接后台后查询配置' : !oss ? '配置状态待查询' : oss.oss_configured === true ? `已配置：${typeof oss.bucket === 'string' ? oss.bucket : ''} · ${typeof oss.region === 'string' ? oss.region : ''} · ${oss.credential_mode === 'independent' ? '独立 OSS 密钥' : '复用阿里云翻译密钥'}` : '尚未配置 OSS';
  }
  async function run(operation) {
    if (disposed || working) return;
    if (!getConnection() || unavailable()) { message('请先连接后台，再修改图片服务设置。',true); return; }
    const current = ++epoch, connection = client.connection;
    working = true; message(''); render();
    try { await operation(connection,current); }
    catch { if (current === epoch) message('设置操作失败，请检查密钥、Bucket、地域和后台连接后重试。',true); }
    finally { if (current === epoch) { working = false; render(); } }
  }
  function active(current, connection) { return !disposed && current === epoch && connection === client.connection; }
  async function refresh() {
    return run(async (connection,current) => {
      const states = await Promise.all([client.request('settings/aliyun',{connection}),client.request('settings/oss',{connection})]);
      if (active(current,connection)) { [aliyun,oss] = states; render(); }
    });
  }
  $('backend-extension-id').textContent = client.extensionId || '请先将本文件夹加载为 Chrome 插件';
  $('backend-copy-id').disabled = !client.extensionId;
  $('backend-copy-id').addEventListener('click', async () => {
    if (!client.extensionId) return;
    try { await clipboard.writeText(client.extensionId); $('backend-copy-status').textContent = '插件编号已复制，请粘贴到安装后台组件窗口。'; }
    catch { $('backend-copy-status').textContent = '复制失败，请手动选择并复制上面的插件编号。'; }
  });
  $('settings-aliyun-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async (connection,current) => {
      const body = {access_key_id:$('settings-aliyun-id').value,access_key_secret:$('settings-aliyun-secret').value};
      if (!Object.values(body).every(validKey)) { message('请填写有效的阿里云密钥，两项均不能为空或含空白。',true); return; }
      const state = await client.request('settings/aliyun',{body,connection});
      if (!active(current,connection)) return;
      aliyun = state; clearSecrets(); message('阿里云密钥已加密保存。'); await refreshCapabilities();
    });
  });
  $('settings-oss-mode').addEventListener('change', () => { $('settings-oss-id').value = ''; $('settings-oss-secret').value = ''; render(); });
  $('settings-oss-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async (connection,current) => {
      const body = {bucket:$('settings-oss-bucket').value.trim(),region:$('settings-oss-region').value.trim(),credential_mode:$('settings-oss-mode').value};
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(body.bucket) || !/^(?:cn|ap|eu|us|me|sa|af)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.region) || !['translation','independent'].includes(body.credential_mode)) { message('请填写有效的 OSS Bucket、地域和凭证来源。',true); return; }
      if (body.credential_mode === 'independent') {
        body.access_key_id = $('settings-oss-id').value; body.access_key_secret = $('settings-oss-secret').value;
        if (![body.access_key_id,body.access_key_secret].every(validKey)) { message('请填写有效的独立 OSS 密钥，两项均不能为空或含空白。',true); return; }
      }
      const state = await client.request('settings/oss',{body,connection});
      if (!active(current,connection)) return;
      oss = state; clearSecrets(); message('OSS 配置已加密保存。'); await refreshCapabilities();
    });
  });
  for (const kind of ['aliyun','oss']) $(`settings-${kind}-delete`).addEventListener('click', () => {
    if ($(`settings-${kind}-delete`).disabled) return;
    void run(async (connection,current) => {
      const state = await client.request(`settings/${kind}`,{method:'DELETE',connection});
      if (!active(current,connection)) return;
      if (kind === 'aliyun') aliyun = state; else oss = state;
      clearSecrets(); message('配置已删除。'); await refreshCapabilities();
    });
  });
  $('settings-oss-check').addEventListener('click', () => {
    if ($('settings-oss-check').disabled) return;
    void run(async (connection,current) => { await client.request('settings/oss/check',{body:{},connection}); if (active(current,connection)) message('OSS 上传和公开读取检查通过。'); });
  });
  render();
  return { refresh, render, dispose() { disposed = true; ++epoch; clearSecrets(); } };
}
