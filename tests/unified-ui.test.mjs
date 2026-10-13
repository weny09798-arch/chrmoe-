import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createConversionPanel } from '../extension/conversion-ui.mjs';
const html=await readFile(new URL('../extension/manager.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({missing=false,foreign=false,restored=false,ensureFailureOnce=false,confirm=()=>true}={}) {
  const {document,window}=parseHTML(html),requests=[],ensures=[],saved=new Map();
  const task={id:'source-1',status:'done',jobs:[{keyword:'杯',groups:[{best:{id:'1',title:'玻璃杯',image:'https://img.pddpic.com/a.jpg'}}]}]};
  if(restored){saved.set('collector-image-bridge',JSON.stringify({baseUrl:'http://127.0.0.1:53121',token:'old'}));saved.set('collector-image-owned-job',JSON.stringify({job_id:'owned',source_task_id:task.id,products:[{platform:'pdd',product_id:'1'}]}));}
  const panel=createConversionPanel({document,extensionId:'a'.repeat(32),storage:restored?{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)}:null,getCollection:()=>({task}),confirm,setTimer:()=>1,clearTimer:()=>{},
    ensureBackend:async()=>{ensures.push(true);if(missing||(ensureFailureOnce&&ensures.length===1))throw new Error('后台未安装，请先安装后台组件。');return 'http://127.0.0.1:53121/#token=fixture';},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/capabilities')?{unified_plugin:true,automatic_backend:true,settings_in_plugin:true,providers:['doubao','aliyun'],oss_configured:true,image_link_replacement:true,cloud_image_storage:true}:url.endsWith('/current')&&foreign?{id:'foreign',kind:'collector',source_task_id:'other',status:'running'}:url.endsWith('/current')&&restored?{id:'owned',kind:'collector',source_task_id:task.id,status:'paused',items:[{status:'paused',refs:[{platform:'pdd',product_id:'1',kind:'main',order:1,sku_index:null,url:'https://img.pddpic.com/a.jpg'}]}]}:{status:'idle'}};}
  });
  return {document,window,panel,requests,ensures,task,saved,click:id=>document.getElementById(id).dispatchEvent(new window.Event('click'))};
}
test('manager recovery automatically pairs after loading collection without starting generation',async()=>{
  const f=fixture();await f.panel.recover(f.task);assert.equal(f.ensures.length,1);assert.equal(f.panel.controller.view().connected,true);assert.equal(f.document.getElementById('conversion-code'),null);
  assert.equal(f.document.getElementById('conversion-start').disabled,false);assert.equal(f.requests.some(r=>r.url.endsWith('/jobs')||r.url.endsWith('/action')||r.url.endsWith('/reset')),false);
  f.panel.dispose();assert.equal(f.requests.some(r=>r.url.endsWith('/reset')||r.url.endsWith('/action')),false);
});
test('missing backend leaves collection intact and presents installation and reconnect controls',async()=>{
  const f=fixture({missing:true}),before=structuredClone(f.task);await f.panel.recover(f.task);assert.deepEqual(f.task,before);assert.match(f.document.getElementById('conversion-connected').textContent,/未安装|失败/);assert.equal(f.document.getElementById('conversion-connect').disabled,false);assert.equal(f.document.getElementById('conversion-start').disabled,true);
});
test('saved batch retains ownership after native startup failure and user reconnect revalidates current without submission',async()=>{
  const f=fixture({restored:true,ensureFailureOnce:true}),handle=f.saved.get('collector-image-owned-job');
  await f.panel.recover(f.task);
  assert.equal(f.panel.controller.restored,true);assert.equal(f.panel.controller.job.status,'recovering');
  assert.equal(f.saved.get('collector-image-owned-job'),handle);assert.equal(f.panel.controller.client.connection.token,'old');assert.equal(f.requests.length,0);
  assert.equal(f.document.getElementById('conversion-connect').disabled,false);
  f.click('conversion-connect');await tick();
  assert.equal(f.ensures.length,2);assert.equal(f.requests.filter(r=>r.url.endsWith('/current')).length,1);
  assert.equal(f.panel.controller.job.id,'owned');assert.equal(f.panel.controller.job.status,'paused');assert.equal(f.panel.controller.restored,false);
  assert.equal(f.panel.controller.client.connection.token,'fixture');
  assert.equal(f.requests.some(r=>r.url.endsWith('/jobs')||r.url.endsWith('/reset')||r.url.endsWith('/action')),false);
});
test('foreign conversion can only be cleared after an explicit confirmation and reset is scoped',async()=>{
  let consent=false;const f=fixture({foreign:true,confirm:()=>consent});await f.panel.recover(f.task);assert.match(f.document.getElementById('conversion-status').textContent,/其他任务/);assert.equal(f.document.getElementById('conversion-start').disabled,true);assert.equal(f.document.getElementById('conversion-login').disabled,true);
  f.click('conversion-reset');await tick();assert.equal(f.requests.some(r=>r.url.endsWith('/reset')),false);
  consent=true;f.click('conversion-reset');await tick();const reset=f.requests.find(r=>r.url.endsWith('/reset'));assert.deepEqual(JSON.parse(reset.options.body),{job_id:'foreign',source_task_id:'other'});assert.equal(f.task.jobs[0].groups.length,1);
});
test('closing the manager while automatic pairing is pending prevents late ownership or saved results',async()=>{
  const f=fixture();let release;
  let first=true;f.panel.controller.client.fetch=async url=>{if(first){first=false;return new Promise(resolve=>{release=resolve;});}return {ok:true,json:async()=>url.endsWith('/capabilities')?{unified_plugin:true,automatic_backend:true,settings_in_plugin:true}:{status:'idle'}};};
  const recovery=f.panel.recover(f.task);await tick();f.panel.dispose();
  release({ok:true,json:async()=>({})});await recovery;
  assert.equal(f.panel.controller.client.connection,null);assert.equal(f.panel.controller.job,null);
});
