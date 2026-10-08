import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createTask } from '../extension/lib/core.mjs';
import { createConversionPanel } from '../extension/conversion-ui.mjs';

const html = await readFile(new URL('../extension/manager.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({configured=true,confirm=()=>true,restored=false}={}) {
  const {document,window} = parseHTML(html), task = createTask(['杯']); task.status='done'; task.jobs[0].status='done';
  task.jobs[0].groups=[{best:{id:'101',title:'玻璃杯',image:'https://img.pddpic.com/a.jpg',cents:100}}];
  const actions=[], requests=[], timers=[], saved=new Map();
  if(restored){saved.set('collector-image-bridge',JSON.stringify({baseUrl:'http://localhost:53121',token:'secret'}));saved.set('collector-image-owned-job',JSON.stringify({job_id:'job-1',source_task_id:task.id,products:[{platform:'pdd',product_id:'101'}]}));}
  let status='paused',collecting=false,itemState={status:'failed',phase:'download-failed',message:'下载失败'},fetchOverride=null,batch={};
  const snapshot=()=>{
    const entries=batch.entries||[{platform:'pdd',product_id:'101',title:'玻璃杯',kind:'main',order:1,url:'https://img.pddpic.com/a.jpg'}],groups=new Map();
    for(const entry of entries){if(!groups.has(entry.url))groups.set(entry.url,[]);groups.get(entry.url).push(entry);}
    return {id:'job-1',kind:'collector',source_task_id:task.id,status,provider:batch.provider||'doubao',image_kinds:batch.image_kinds||['main','detail','sku'],paid_calls:batch.provider==='aliyun'?1:0,estimated_cost_upper:batch.provider==='aliyun'?groups.size*0.06:0,counts:{total:entries.length,unique:groups.size,downloaded:groups.size,converted:0,failed:1},items:[...groups.values()].map((refs,index)=>({index,...itemState,input_path:'input.png',refs}))};
  };
  const panel=createConversionPanel({document,extensionId:'test-extension',storage:{getItem:key=>saved.get(key),setItem:(key,val)=>saved.set(key,val),removeItem:key=>saved.delete(key)},getCollection:()=>({task,collecting,unavailable:false}),
    fetch:async(url,options)=>{requests.push({url,options});if(fetchOverride)return fetchOverride(url,options);const body=options.body&&JSON.parse(options.body);let value={};if(url.endsWith('/capabilities'))value={providers:['doubao','aliyun'],aliyun_configured:configured,aliyun_price_per_image:0.06};if(url.endsWith('/folder'))value={path:'D:\\图片'};if(url.endsWith('/jobs'))batch=body;if(url.endsWith('/jobs')||url.includes('/state'))value=snapshot();if(url.endsWith('/action')){actions.push(body);if(body.action==='continue')status='running';if(body.action==='stop')status='paused';value=snapshot();}return {ok:true,json:async()=>value,blob:async()=>new Blob(['preview'])};},
    setTimer:callback=>{timers.push(callback);return timers.length;},clearTimer:()=>{},download:async()=>{},confirm
  });
  const click=id=>document.getElementById(id).dispatchEvent(new window.Event('click'));
  const change=(id,checked)=>{document.getElementById(id).checked=checked;document.getElementById(id).dispatchEvent(new window.Event('change'));};
  return {document,window,panel,task,actions,requests,timers,click,change,setCollecting:value=>{collecting=value;panel.refresh();},setItem:value=>{itemState=value;},setFetch:value=>{fetchOverride=value;},setConfigured:value=>{configured=value;}};
}
test('panel connects, chooses local folder and exposes counts with distinct stop/continue/retry/redo actions',async()=>{
  const f=fixture();f.document.getElementById('conversion-code').value='http://localhost:53121/#token=secret';
  f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();
  assert.equal(f.document.getElementById('conversion-output').textContent,'D:\\图片');
  f.click('conversion-start');await tick();
  assert.match(f.document.getElementById('conversion-counts').textContent,/图片位置 1.*独立图片 1.*已下载 1.*已转换 0.*失败 1/);
  assert.match(f.document.getElementById('conversion-status').textContent,/暂停/);
  assert.equal(f.document.querySelector('[data-conversion-action="retry"]').disabled,false);
  f.click('conversion-continue');await tick();f.click('conversion-stop');await tick();
  f.document.querySelector('[data-conversion-action="retry"]').dispatchEvent(new f.window.Event('click'));await tick();
  f.document.querySelector('[data-conversion-action="redo"]').dispatchEvent(new f.window.Event('click'));await tick();
  assert.deepEqual(f.actions.map(a=>a.action),['continue','stop','retry','redo']);
  assert.equal(f.actions[2].index,0);assert.equal(f.actions[3].index,0);
  assert.equal(f.document.getElementById('conversion-code').value,'');
});
test('active paid batch selection and fee remain frozen after live source updates and release for the next batch',async()=>{
  const f=fixture();await connectFolder(f);f.change('conversion-paid',true);f.click('conversion-start');await tick();
  const selection=f.document.getElementById('conversion-selection').textContent,cost=f.document.getElementById('conversion-cost').textContent;
  f.task.jobs[0].groups[0].best.detailImages=['https://img.pddpic.com/new.jpg'];f.panel.refresh();
  assert.equal(f.document.getElementById('conversion-selection').textContent,selection);assert.equal(f.document.getElementById('conversion-cost').textContent,cost);assert.equal(f.panel.selectedCount(),1);
  f.panel.controller.acceptSnapshot({...f.panel.controller.job,status:'completed'},'job-1');f.panel.refresh();
  assert.match(f.document.getElementById('conversion-selection').textContent,/已选 2.*独立 URL 2/);assert.match(f.document.getElementById('conversion-start').textContent,/0\.12/);
  f.click('conversion-start');await tick();const bodies=f.requests.filter(r=>r.url.endsWith('/jobs')).map(r=>JSON.parse(r.options.body));assert.equal(bodies[1].entries.length,2);
});
test('restored paid snapshot uses its manifest URLs and cumulative estimate including redo instead of the live source',async()=>{
  const f=fixture();await connectFolder(f);f.panel.controller.sourceTaskId=f.task.id;
  const ref={platform:'pdd',product_id:'101',kind:'main',order:1,url:'https://img.pddpic.com/old.jpg'};
  f.panel.controller.acceptSnapshot({id:'restored',kind:'collector',source_task_id:f.task.id,status:'paused',provider:'aliyun',image_kinds:['main','detail'],paid_calls:2,estimated_cost_upper:0.12,counts:{total:2,unique:1},items:[{index:0,refs:[ref,{...ref,kind:'detail'}]}]},'restored');f.panel.refresh();
  assert.match(f.document.getElementById('conversion-selection').textContent,/主图 1.*详情图 1.*已选 2.*独立 URL 1/);
  assert.match(f.document.getElementById('conversion-cost').textContent,/累计.*0\.12/);assert.doesNotMatch(f.document.getElementById('conversion-cost').textContent,/首次/);
  const before=f.document.getElementById('conversion-selection').textContent;f.task.jobs[0].groups[0].best.galleryImages=['https://img.pddpic.com/new1.jpg','https://img.pddpic.com/new2.jpg'];f.panel.refresh();
  assert.equal(f.document.getElementById('conversion-selection').textContent,before);assert.equal(f.panel.selectedCount(),2);
});
test('incomplete restored ownership handle waits for snapshot counts and never infers the batch from current source',()=>{
  const f=fixture({restored:true});
  assert.match(f.document.getElementById('conversion-selection').textContent,/恢复.*待/);assert.doesNotMatch(f.document.getElementById('conversion-selection').textContent,/已选 1|独立 URL 1/);assert.equal(f.panel.selectedCount(),null);
  f.task.jobs[0].groups[0].best.detailImages=['https://img.pddpic.com/new.jpg'];f.panel.refresh();assert.match(f.document.getElementById('conversion-selection').textContent,/恢复.*待/);
});
test('paid capability validation displays the synchronous pending manifest despite source changes',async()=>{
  const f=fixture();await connectFolder(f);f.change('conversion-paid',true);let release;
  f.setFetch(async url=>url.endsWith('/capabilities')?await new Promise(resolve=>{release=resolve;}):{ok:true,json:async()=>({})});
  f.click('conversion-start');await tick();const before=f.document.getElementById('conversion-selection').textContent,cost=f.document.getElementById('conversion-cost').textContent;
  f.task.jobs[0].groups[0].best.detailImages=['https://img.pddpic.com/late.jpg'];f.panel.refresh();
  assert.equal(f.document.getElementById('conversion-selection').textContent,before);assert.equal(f.document.getElementById('conversion-cost').textContent,cost);
  await f.panel.clear();release({ok:true,json:async()=>({providers:['doubao','aliyun'],aliyun_configured:true})});await tick();
});
async function connectFolder(f){f.document.getElementById('conversion-code').value='http://localhost:53121/#token=secret';f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();}
test('checkbox selections count all positions and unique URLs, reject empty selection and send selected types',async()=>{
  const f=fixture(),item=f.task.jobs[0].groups[0].best;item.galleryImages=[item.image,item.image];item.detailImages=[item.image,'https://img.pddpic.com/detail.jpg'];item.skus=[{id:'a',image:item.image},{id:'b',image:'https://img.pddpic.com/sku.jpg'}];
  await connectFolder(f);
  assert.match(f.document.getElementById('conversion-selection').textContent,/主图 2.*详情图 2.*SKU 图 2.*已选 6.*独立 URL 3/);
  f.change('conversion-kind-main',false);f.change('conversion-kind-detail',false);f.change('conversion-kind-sku',false);
  assert.equal(f.document.getElementById('conversion-start').disabled,true);f.click('conversion-start');await tick();assert.equal(f.requests.some(r=>r.url.endsWith('/jobs')),false);
  f.change('conversion-kind-sku',true);f.click('conversion-start');await tick();
  const body=JSON.parse(f.requests.find(r=>r.url.endsWith('/jobs')).options.body);assert.deepEqual(body.image_kinds,['sku']);assert.equal(body.entries.length,2);
  for(const id of ['conversion-kind-main','conversion-kind-detail','conversion-kind-sku','conversion-paid','conversion-folder'])assert.equal(f.document.getElementById(id).disabled,true);
});
test('paid UI exposes configured status refresh and local settings link then quotes and explicitly starts paid batch',async()=>{
  const f=fixture({configured:false});await connectFolder(f);f.change('conversion-paid',true);
  assert.equal(f.document.getElementById('conversion-login').hidden,true);assert.equal(f.document.getElementById('conversion-start').disabled,true);
  assert.match(f.document.getElementById('conversion-provider-status').textContent,/配置/);
  assert.equal(f.document.getElementById('conversion-settings').getAttribute('href'),'http://localhost:53121/#token=secret');
  f.setConfigured(true);f.click('conversion-refresh-config');await tick();assert.equal(f.document.getElementById('conversion-start').disabled,false);
  assert.match(f.document.getElementById('conversion-start').textContent,/付费.*0\.06/);assert.match(f.document.getElementById('conversion-cost').textContent,/实际.*账单/);
  f.click('conversion-start');await tick();const body=JSON.parse(f.requests.find(r=>r.url.endsWith('/jobs')).options.body);
  assert.equal(body.provider,'aliyun');assert.equal(body.paid_confirmed,true);assert.match(f.document.getElementById('conversion-status').textContent,/阿里云.*主图.*详情图.*SKU.*付费请求 1/);
});
test('paid redo requires a fresh confirmation and unsafe phases never expose ordinary retry',async()=>{
  let consent=false,questions=[];const f=fixture({confirm:text=>{questions.push(text);return consent;}});await connectFolder(f);f.change('conversion-paid',true);f.click('conversion-start');await tick();
  for(const phase of ['uncertain','submitting','aliyun-failed']){f.setItem({status:'paused',phase});await f.panel.controller.poll();assert.equal(f.document.querySelector('[data-conversion-action="retry"]').hidden,true);}
  const redo=f.document.querySelector('[data-conversion-action="redo"]');redo.dispatchEvent(new f.window.Event('click'));await tick();assert.equal(f.actions.length,0);assert.match(questions[0],/再次计费/);
  consent=true;redo.dispatchEvent(new f.window.Event('click'));await tick();assert.equal(f.actions[0].paid_confirmed,true);
  f.setItem({status:'failed',phase:'aliyun-downloading'});await f.panel.controller.poll();assert.equal(f.document.querySelector('[data-conversion-action="retry"]').hidden,false);
});
test('a changed collection after displaying a paid quote must be reviewed before submitting the new cost',async()=>{
  const f=fixture();await connectFolder(f);f.change('conversion-paid',true);
  f.task.jobs[0].groups[0].best.detailImages=['https://img.pddpic.com/new.jpg'];f.click('conversion-start');await tick();
  assert.equal(f.requests.some(r=>r.url.endsWith('/jobs')),false);assert.match(f.document.getElementById('conversion-start').textContent,/0\.12/);
  f.click('conversion-start');await tick();const body=JSON.parse(f.requests.find(r=>r.url.endsWith('/jobs')).options.body);assert.equal(body.entries.length,2);
});
test('completed batch releases type and provider preferences for the next batch',async()=>{
  const f=fixture();await connectFolder(f);f.click('conversion-start');await tick();
  f.panel.controller.acceptSnapshot({...f.panel.controller.job,status:'completed'},'job-1');f.panel.refresh();
  f.change('conversion-paid',true);f.change('conversion-kind-detail',false);
  assert.equal(f.document.getElementById('conversion-paid').checked,true);assert.equal(f.document.getElementById('conversion-kind-detail').checked,false);
  assert.match(f.document.getElementById('conversion-start').textContent,/付费/);
  f.click('conversion-start');await tick();const bodies=f.requests.filter(r=>r.url.endsWith('/jobs')).map(r=>JSON.parse(r.options.body));
  assert.equal(bodies[1].provider,'aliyun');assert.deepEqual(bodies[1].image_kinds,['main','sku']);
});
test('recovering a paid snapshot restores the actual frozen provider, types, output and request count',async()=>{
  const f=fixture();await connectFolder(f);
  f.panel.controller.sourceTaskId=f.task.id;
  f.panel.controller.acceptSnapshot({id:'restored',kind:'collector',source_task_id:f.task.id,status:'paused',provider:'aliyun',image_kinds:['sku'],paid_calls:7,output_dir:'D:\\恢复图片',items:[]},'restored');f.panel.refresh();
  assert.equal(f.document.getElementById('conversion-paid').checked,true);assert.equal(f.document.getElementById('conversion-kind-main').checked,false);assert.equal(f.document.getElementById('conversion-kind-sku').checked,true);
  assert.equal(f.document.getElementById('conversion-output').textContent,'D:\\恢复图片');assert.match(f.document.getElementById('conversion-status').textContent,/付费请求 7/);
  f.change('conversion-paid',false);assert.equal(f.document.getElementById('conversion-paid').checked,true);
});
test('completed and uncertain items offer explicit regeneration and cannot resubmit through retry',async()=>{
  const f=fixture();f.document.getElementById('conversion-code').value='http://localhost:53121/#token=secret';f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();f.click('conversion-start');await tick();
  for(const item of [{status:'completed',phase:'done'},{status:'needs-review',phase:'pending'},{status:'paused',phase:'uncertain'}]){
    f.setItem(item);await f.panel.controller.poll();
    const retry=f.document.querySelector('[data-conversion-action="retry"]'), redo=f.document.querySelector('[data-conversion-action="redo"]');
    assert.equal(retry.disabled,true);assert.equal(redo.disabled,false);assert.equal(redo.textContent,'重新生成此图');
  }
  f.setItem({status:'paused',phase:'pending'});await f.panel.controller.poll();
  assert.equal(f.document.querySelector('[data-conversion-action="retry"]').textContent,'继续获取此图');
  f.setItem({status:'paused',phase:'ready'});await f.panel.controller.poll();
  assert.equal(f.document.querySelector('[data-conversion-action="retry"]').textContent,'继续处理此图');
});
test('polling status changes preserves existing image preview DOM',async()=>{
  const f=fixture();f.document.getElementById('conversion-code').value='http://localhost:53121/#token=secret';f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();f.click('conversion-start');await tick();
  const row=f.document.querySelector('.conversion-item');
  f.setItem({status:'paused',phase:'ready',message:'另一条进度消息'});await f.panel.controller.poll();
  assert.ok(f.document.querySelector('.conversion-item')===row,'status-only poll keeps preview row');
  assert.match(row.textContent,/另一条进度消息/);
});
test('panel permits new connection code after auth failure and offers explicit forgetting when old job is absent',async()=>{
  const f=fixture();f.document.getElementById('conversion-code').value='http://localhost:53121/#token=old';f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();f.click('conversion-start');await tick();
  f.setFetch(async()=>({ok:false,status:401}));await f.panel.controller.poll();
  assert.equal(f.document.getElementById('conversion-connect').disabled,false);
  f.setFetch(async url=>url.endsWith('/pair')?{ok:true,json:async()=>({})}:{ok:false,status:409});
  f.document.getElementById('conversion-code').value='http://localhost:54121/#token=new';f.click('conversion-connect');await tick();await tick();
  assert.equal(f.document.getElementById('conversion-forget').hidden,false);
  assert.equal(f.panel.controller.client.connection.token,'old');
  const count=f.requests.length;f.click('conversion-forget');await tick();
  assert.equal(f.requests.length,count);assert.equal(f.panel.controller.client.connection.token,'new');
  assert.equal(f.panel.controller.job,null);assert.equal(f.task.jobs[0].groups.length,1);
  assert.equal(f.document.getElementById('conversion-code').value,'');
});
test('panel disables conversion while collection is active and clear removes old items and scheduled poll work',async()=>{
  const f=fixture();f.document.getElementById('conversion-code').value='http://localhost:53121/#token=secret';f.click('conversion-connect');await tick();f.click('conversion-folder');await tick();
  f.setCollecting(true);assert.equal(f.document.getElementById('conversion-start').disabled,true);
  f.setCollecting(false);f.click('conversion-start');await tick();assert.equal(f.document.querySelectorAll('.conversion-item').length,1);
  const oldTimers=[...f.timers];await f.panel.clear();const count=f.requests.length;
  for(const callback of oldTimers)callback();await tick();
  assert.equal(f.requests.length,count);assert.equal(f.document.querySelectorAll('.conversion-item').length,0);
  assert.equal(f.panel.controller.job,null);
});
