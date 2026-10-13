import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { BridgeClient } from '../extension/lib/image-conversion.mjs';
import { createSettingsPanel } from '../extension/settings-ui.mjs';
const html=await readFile(new URL('../extension/manager.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({connected=true,confirm=()=>true}={}) {
  const {document,window}=parseHTML(html),requests=[],writes=[];let refreshed=0;
  const client=new BridgeClient({extensionId:'a'.repeat(32),storage:null,fetch:async(url,options)=>{
    requests.push({url,options});return {ok:true,json:async()=>({aliyun_configured:true,oss_configured:true,bucket:'fixture-bucket',region:'cn-hangzhou',credential_mode:'translation',access_key_secret:'MUST-NOT-DISPLAY'})};
  }});
  if(connected)client.remember({baseUrl:'http://127.0.0.1:53121',token:'fixture'});
  const panel=createSettingsPanel({document,client,getConnection:()=>Boolean(client.connection),refreshCapabilities:async()=>{refreshed++;},clipboard:{writeText:async value=>writes.push(value)},confirm});
  const click=id=>document.getElementById(id).dispatchEvent(new window.Event('click'));
  const submit=id=>document.getElementById(id).dispatchEvent(new window.Event('submit',{cancelable:true}));
  const value=(id,value)=>{const input=document.getElementById(id);if(input.tagName==='SELECT'){for(const option of input.options)option.removeAttribute('selected');input.querySelector('[value="'+value+'"]').setAttribute('selected','');}else input.value=value;};
  return {document,window,client,panel,requests,writes,click,submit,value,refreshed:()=>refreshed};
}
test('plugin installation help copies the exact extension id without exposing a connection code',async()=>{
  const f=fixture();f.click('backend-copy-id');await tick();assert.deepEqual(f.writes,['a'.repeat(32)]);
  assert.equal(f.document.getElementById('conversion-code'),null);assert.equal(f.document.querySelector('a#conversion-settings'),null);
  assert.match(f.document.getElementById('backend-install-help').textContent,/安装后台组件/);
});
test('Aliyun credentials are password inputs, saved via paired route, cleared and never read back',async()=>{
  const f=fixture();for(const id of ['settings-aliyun-id','settings-aliyun-secret'])assert.equal(f.document.getElementById(id).type,'password');
  f.value('settings-aliyun-id','fixture-id');f.value('settings-aliyun-secret','fixture-secret');f.submit('settings-aliyun-form');await tick();
  const request=f.requests.find(r=>r.options.method==='POST');assert.ok(request.url.endsWith('/settings/aliyun'));assert.deepEqual(JSON.parse(request.options.body),{access_key_id:'fixture-id',access_key_secret:'fixture-secret'});
  assert.equal(f.document.getElementById('settings-aliyun-id').value,'');assert.equal(f.document.getElementById('settings-aliyun-secret').value,'');assert.equal(f.refreshed(),1);
  await f.panel.refresh();assert.doesNotMatch(f.document.body.textContent,/MUST-NOT-DISPLAY|fixture-secret/);
});
test('invalid credentials and disconnected forms cannot dispatch settings writes',async()=>{
  for(const secret of ['', 'bad secret']){const f=fixture();f.value('settings-aliyun-id','id');f.value('settings-aliyun-secret',secret);f.submit('settings-aliyun-form');await tick();assert.equal(f.requests.length,0);assert.match(f.document.getElementById('settings-message').textContent,/密钥/);}
  const f=fixture({connected:false});f.value('settings-aliyun-id','id');f.value('settings-aliyun-secret','secret');f.submit('settings-aliyun-form');await tick();assert.equal(f.requests.length,0);assert.equal(f.document.getElementById('settings-oss-check').disabled,true);
});
test('OSS reuse sends no independent secrets; independent source requires both keys and clears them',async()=>{
  const f=fixture();f.value('settings-oss-bucket','fixture-bucket');f.value('settings-oss-region','cn-hangzhou');f.value('settings-oss-mode','translation');f.value('settings-oss-secret','discard-me');f.submit('settings-oss-form');await tick();
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{bucket:'fixture-bucket',region:'cn-hangzhou',credential_mode:'translation'});assert.equal(f.document.getElementById('settings-oss-secret').value,'');
  f.value('settings-oss-mode','independent');f.document.getElementById('settings-oss-mode').dispatchEvent(new f.window.Event('change'));f.submit('settings-oss-form');await tick();assert.equal(f.requests.length,1);
  f.value('settings-oss-id','oss-id');f.value('settings-oss-secret','oss-secret');f.submit('settings-oss-form');await tick();assert.equal(JSON.parse(f.requests[1].options.body).access_key_secret,'oss-secret');assert.equal(f.document.getElementById('settings-oss-id').value,'');
});
test('delete uses DELETE and OSS check only runs on an explicit click with adjacent cost disclosure',async()=>{
  const f=fixture();await f.panel.refresh();assert.equal(f.requests.some(r=>r.url.endsWith('/settings/oss/check')),false);
  f.click('settings-aliyun-delete');await tick();const deletion=f.requests.find(r=>r.options.method==='DELETE');assert.equal(deletion.options.body,undefined);
  f.click('settings-oss-check');await tick();const check=f.requests.find(r=>r.url.endsWith('/settings/oss/check'));assert.equal(check.options.body,'{}');assert.match(f.document.getElementById('settings-oss-check-cost').textContent,/费用/);
});
