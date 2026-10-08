import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../extension/lib/core.mjs';
import { taskSheets, workbookBytes } from '../extension/lib/xlsx.mjs';
import { buildImageManifest, parseConnectionCode, BridgeClient, ConversionController } from '../extension/lib/image-conversion.mjs';

const image = 'https://img.pddpic.com/main.jpg?size=100';
const capabilities = { providers:['doubao','aliyun'], image_kinds:['main','detail','sku'], oss_configured:true, image_link_replacement:true,cloud_image_storage:true, aliyun_configured:true, aliyun_price_per_image:0.06 };
function fixture() {
  const task = createTask(['杯']); task.status = 'done';
  task.jobs[0].limit = 1; task.jobs[0].status = 'done';
  task.jobs[0].groups = [
    { best: { id: 'excluded', title: '未发货秒退', image } },
    { best: { id: '101', title: '玻璃杯', image, url: 'https://mobile.pinduoduo.com/goods.html?goods_id=101', galleryImages: [image, image], detailImages: ['https://img.pddpic.com/detail.jpg'], skus: [{ id: 'red', specs: ['红', '大'], image }, { id: 'blue', image }] } },
    { best: { id: 'limit-excluded', title: '水杯', image } }
  ];
  task.jobs.push({ keyword: '杯', site: '1688', limit: 1, status: 'done', groups: [{ best: { id: '202', title: '陶瓷杯', image: 'https://img.alicdn.com/fallback.jpg' } }] });
  task.jobs.push({ keyword: '杯', site: 'taobao', limit: 1, status: 'done', groups: [{ best: { id: '303', title: '保温杯', galleryImages: ['https://img.alicdn.com/t.jpg'], skus: [{ specs: ['银色'], image: 'https://img.alicdn.com/s.jpg' }] } }] });
  return task;
}
test('manifest matches filtered export products and retains every duplicate main/detail/SKU position across platforms', () => {
  const entries = buildImageManifest(fixture());
  assert.deepEqual(entries.map(e => [e.platform, e.product_id, e.kind, e.order, e.sku]), [
    ['pdd','101','main',1,''], ['pdd','101','main',2,''], ['pdd','101','detail',1,''], ['pdd','101','sku',1,'red'], ['pdd','101','sku',2,'blue'],
    ['1688','202','main',1,''], ['taobao','303','main',1,''], ['taobao','303','sku',1,'银色']
  ]);
  assert.equal(entries[0].url, image); assert.equal(entries[3].product_url, 'https://mobile.pinduoduo.com/goods.html?goods_id=101');
});
test('manifest is frozen, never mutates source or original 22-column workbook and excludes subsequent products', () => {
  const task = fixture(), original = structuredClone(task), workbook = workbookBytes(taskSheets(task));
  const entries = buildImageManifest(task);
  assert.deepEqual(task, original); assert.deepEqual(workbookBytes(taskSheets(task)), workbook);
  assert.equal(taskSheets(task)[0].rows[8].length, 22);
  assert.throws(() => { entries[0].title = 'changed'; }, TypeError);
  assert.throws(() => entries.push({}), TypeError);
  task.jobs.push({ keyword:'杯', groups:[{best:{id:'later',title:'新杯子',image}}] });
  assert.equal(entries.some(entry => entry.product_id === 'later'), false);
});
test('all seven nonempty type selections filter positions without reordering galleries or SKU variants', () => {
  const task=fixture(), before=structuredClone(task);
  for(const [kinds,want] of [[['main'],4],[['detail'],1],[['sku'],3],[['main','detail'],5],[['main','sku'],7],[['detail','sku'],4],[['main','detail','sku'],8]]) {
    const entries=buildImageManifest(task,kinds);
    assert.equal(entries.length,want);assert.ok(entries.every(e=>kinds.includes(e.kind)));
    if(kinds.includes('main'))assert.deepEqual(entries.filter(e=>e.product_id==='101'&&e.kind==='main').map(e=>e.order),[1,2]);
    if(kinds.includes('sku'))assert.deepEqual(entries.filter(e=>e.product_id==='101'&&e.kind==='sku').map(e=>e.sku),['red','blue']);
  }
  assert.deepEqual(task,before);assert.deepEqual(buildImageManifest(task,[]),[]);
  assert.throws(()=>buildImageManifest(task,['oops']),/类型/);
  const shared=buildImageManifest(task,['main','sku']).filter(e=>e.url===image);
  assert.equal(shared.length,4);assert.equal(new Set(shared.map(e=>e.url)).size,1);
});
test('connection codes accept only explicit loopback HTTP ports and a single token fragment', () => {
  assert.deepEqual(parseConnectionCode('http://127.0.0.1:53121/#token=secret'), { baseUrl: 'http://127.0.0.1:53121', token: 'secret' });
  assert.equal(parseConnectionCode('http://localhost:1234#token=abc').baseUrl, 'http://localhost:1234');
  for (const code of ['https://localhost:1234/#token=x', 'http://example.com:1234/#token=x', 'http://127.0.0.2:1234/#token=x', 'http://127.1:1234/#token=x', 'http://2130706433:1234/#token=x', 'http://localhost/#token=x', 'http://u:p@localhost:1234/#token=x', 'http://localhost:1234/api#token=x', 'http://localhost:1234/?token=x#token=x', 'http://localhost:1234/#token=', 'http://localhost:1234/#token=x&token=y', 'http://localhost:0/#token=x']) assert.throws(() => parseConnectionCode(code), /连接码/);
});

const response = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(fetch) {
  const saved = new Map(), storage = { getItem:key=>saved.get(key), setItem:(key,value)=>saved.set(key,value), removeItem:key=>saved.delete(key) };
  // Legacy lifecycle fixtures use a generic response for routes they do not exercise.
  // Give their capability route the new complete tool contract; explicit capability
  // fixtures and HTTP failures remain unchanged.
  const fixtureFetch = async (url,options) => {
    const result = await fetch(url,options);
    if (!url.endsWith('/capabilities') || !result.ok) return result;
    const value = await result.json();
    return response(value.providers ? value : capabilities);
  };
  const client = new BridgeClient({ extensionId: 'test-extension', fetch:fixtureFetch, storage });
  const updates = [];
  const controller = new ConversionController({ client, onChange: state => updates.push(state) });
  return { client, controller, updates, saved };
}
function reloaded(f, fetch) {
  return new ConversionController({client:new BridgeClient({extensionId:'test-extension',fetch,storage:f.client.storage})});
}
test('reload preserves owned products so deletion and global clear cancel before any recovery poll',async()=>{
  for(const operation of ['delete','clear']) {
    const task=fixture(), actions=[];
    const fetch=async(url,options)=>{if(url.endsWith('/action'))actions.push(JSON.parse(options.body));return response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}:{});};
    const f=setup(fetch);await f.controller.connect('http://localhost:53121/#token=secret');await f.controller.start(task,'D:\\图片',false);
    const controller=reloaded(f,fetch);
    assert.equal(controller.job?.id,'job-1');assert.equal(controller.sourceTaskId,task.id);
    if(operation==='delete')await controller.removeProduct(task.id,'pdd','101');else await controller.clear();
    assert.equal(controller.job,null);
    assert.deepEqual(actions,[{job_id:'job-1',source_task_id:task.id,action:'cancel'}]);
    assert.equal(reloaded(f,fetch).job,null);
  }
});
test('owned session handle preserves unique product identities and frozen batch metadata and removes synchronously even when cancel fails',async()=>{
  const pending=deferred(), task=fixture();
  const fetch=async(url)=>url.endsWith('/action')?pending.promise:response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}:{});
  const f=setup(fetch);await f.controller.connect('http://localhost:53121/#token=secret');await f.controller.start(task,'D:\\图片',false);
  const handle=[...f.saved.values()].map(value=>JSON.parse(value)).find(value=>value.job_id);
  assert.deepEqual({job_id:handle.job_id,source_task_id:handle.source_task_id,products:handle.products},{job_id:'job-1',source_task_id:task.id,products:[{platform:'pdd',product_id:'101'},{platform:'1688',product_id:'202'},{platform:'taobao',product_id:'303'}]});
  const controller=reloaded(f,fetch), clearing=controller.clear();
  assert.equal(reloaded(f,fetch).job,null);
  pending.resolve({ok:false,status:409});await clearing;
});
test('reload validates same source and polls only existing job, restoring output previews without auto submission',async()=>{
  const task=fixture(), requests=[], snapshot={id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',output_dir:'D:\\图片',items:[{index:0,status:'paused',phase:'pending',refs:[{platform:'pdd',product_id:'101'}],input_path:'input.png'}]};
  const fetch=async(url,options)=>{requests.push(url);return response(url.endsWith('/jobs')||url.includes('/state')?snapshot:{});};
  const f=setup(fetch);await f.controller.connect('http://localhost:53121/#token=x');await f.controller.start(task,'D:\\图片',false);
  const controller=reloaded(f,fetch), count=requests.length;
  await controller.restoreForTask(task);
  assert.deepEqual(requests.slice(count),['http://localhost:53121/api/bridge/state?job_id=job-1']);
  assert.equal(controller.job.status,'paused');assert.equal(controller.job.items[0].input_path,'input.png');assert.equal(controller.outputDir,'D:\\图片');
});
test('reload with a different or cleared source cancels previous owned batch rather than starting anything',async()=>{
  for(const source of [fixture(),null]){
    const task=fixture(),requests=[];
    const fetch=async(url,options)=>{requests.push({url,body:options.body&&JSON.parse(options.body)});return response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}:{});};
    const f=setup(fetch);await f.controller.connect('http://localhost:53121/#token=x');await f.controller.start(task,'D:\\图片',false);
    const controller=reloaded(f,fetch),count=requests.length;
    await controller.restoreForTask(source);
    assert.deepEqual(requests.slice(count).map(r=>r.body),[{job_id:'job-1',source_task_id:task.id,action:'cancel'}]);
    assert.equal(controller.job,null);
  }
});
test('delete during recovery prevents a late state response from resurrecting the job or owned handle',async()=>{
  const task=fixture(),pending=deferred();
  const fetch=async url=>url.includes('/state')?pending.promise:response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}:{});
  const f=setup(fetch);await f.controller.connect('http://localhost:53121/#token=x');await f.controller.start(task,'D:\\图片',false);
  const controller=reloaded(f,fetch),restoring=controller.restoreForTask(task);
  await controller.removeProduct(task.id,'pdd','101');
  pending.resolve(response({id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}));await restoring;
  assert.equal(controller.job,null);assert.equal(reloaded(f,fetch).job,null);
});
test('recovery authentication and ownership failures never start or submit a replacement job',async()=>{
  for(const status of [403,409]){
    const task=fixture(),requests=[];
    const initial=async url=>response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]}:{});
    const f=setup(initial);await f.controller.connect('http://localhost:53121/#token=x');await f.controller.start(task,'D:\\图片',false);
    const controller=reloaded(f,async url=>{requests.push(url);return {ok:false,status};});
    await controller.restoreForTask(task);
    assert.deepEqual(requests,['http://localhost:53121/api/bridge/state?job_id=job-1']);
    assert.equal(controller.job.id,'job-1');assert.ok(controller.error);
  }
});
test('expired connection can pair a restarted tool and recover the same owned paused job without submitting',async()=>{
  const task=fixture(),requests=[],snapshot={id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',output_dir:'D:\\图片',items:[]};
  const first=setup(async url=>response(url.endsWith('/jobs')?snapshot:{}));await first.controller.connect('http://localhost:53121/#token=old');await first.controller.start(task,'D:\\图片',false);
  const controller=reloaded(first,async(url,options)=>{
    requests.push({url,headers:options.headers,body:options.body&&JSON.parse(options.body)});
    if(options.headers['X-Tool-Token']==='old')return {ok:false,status:401};
    return response(url.endsWith('/pair')?{}:snapshot);
  });
  await controller.restoreForTask(task);assert.ok(controller.error);
  const count=requests.length;await controller.connect('http://localhost:54121/#token=new');
  assert.deepEqual(requests.slice(count).map(r=>r.url),['http://localhost:54121/api/bridge/pair','http://localhost:54121/api/bridge/state?job_id=job-1','http://localhost:54121/api/bridge/capabilities']);
  assert.deepEqual(requests.slice(count).map(r=>r.headers['X-Tool-Token']),['new','new','new']);
  assert.equal(controller.job.id,'job-1');assert.equal(controller.job.status,'paused');assert.equal(controller.client.connection.token,'new');assert.equal(controller.sourceTaskId,task.id);
  assert.equal(reloaded(first,async()=>response({})).job.id,'job-1');
});
test('missing previous job requires explicit forgetting before rebinding and never cancels an unverified task with the new token',async()=>{
  const task=fixture(),requests=[],snapshot={id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',items:[]};
  const f=setup(async url=>response(url.endsWith('/jobs')?snapshot:{}));await f.controller.connect('http://localhost:53121/#token=old');await f.controller.start(task,'D:\\图片',false);
  const controller=reloaded(f,async(url,options)=>{requests.push({url,body:options.body&&JSON.parse(options.body)});return url.endsWith('/pair')?response({}):{ok:false,status:409};});
  await controller.restoreForTask(task);await assert.rejects(controller.connect('http://localhost:54121/#token=new'));
  assert.equal(controller.job.id,'job-1');assert.equal(controller.client.connection.token,'old');assert.equal(controller.view().canForget,true);
  const count=requests.length;controller.forgetStale();
  assert.equal(requests.length,count);assert.equal(controller.job,null);assert.equal(controller.client.connection.token,'new');
  assert.equal(reloaded(f,async()=>response({})).job,null);assert.equal(task.jobs[0].groups.length,3);
  assert.equal(requests.some(r=>r.body?.action||r.url.endsWith('/jobs')),false);
});
test('reconnect refuses a mismatching returned source and retains original credentials and owned identity',async()=>{
  const task=fixture(),snapshot={id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',items:[]};
  const f=setup(async url=>response(url.endsWith('/jobs')?snapshot:{}));await f.controller.connect('http://localhost:53121/#token=old');await f.controller.start(task,'D:\\图片',false);
  const controller=reloaded(f,async url=>response(url.endsWith('/pair')?{}:{...snapshot,source_task_id:'someone-else'}));
  await controller.restoreForTask(task);await assert.rejects(controller.connect('http://localhost:54121/#token=new'),/不一致/);
  assert.equal(controller.client.connection.token,'old');assert.equal(controller.sourceTaskId,task.id);assert.equal(controller.job.id,'job-1');
});
test('pairing and jobs send token and extension identity, with credentials only saved after successful pair', async () => {
  const requests = [];
  const f = setup(async (url, options) => { requests.push({url,options}); return response(url.endsWith('/pair') ? {} : {id:'job-1',kind:'collector',status:'running',source_task_id:'source-1',items:[]}); });
  await f.controller.connect('http://localhost:53121/#token=secret');
  await f.controller.start({ ...fixture(), id:'source-1' }, 'D:\\图片', false);
  assert.equal(requests.length, 3);
  for (const {options} of requests) { assert.equal(options.headers['X-Tool-Token'], 'secret'); assert.equal(options.headers['X-Extension-Id'], 'test-extension'); }
  assert.deepEqual(JSON.parse(requests[0].options.body), {extension_id:'test-extension'});
  assert.equal(JSON.parse(requests[2].options.body).entries.length, 8);
  assert.equal(f.saved.size, 2);
});
test('running, pending, paused or blocked collection cannot start conversion', async () => {
  const f = setup(async () => response({})); await f.controller.connect('http://localhost:53121/#token=x');
  for (const status of ['running','pending','paused','blocked']) { const task = fixture(); task.status = status; await assert.rejects(f.controller.start(task, 'D:\\图片', false), /停止|结束/); }
  await assert.rejects(f.controller.start(fixture(), 'D:\\图片', true), /停止|结束/);
});
test('clear invalidates an in-flight poll even when remote stop fails', async () => {
  const pending = deferred(), task = fixture(); let polling = false;
  const f = setup(async url => {
    if (url.includes('/state')) { polling = true; return pending.promise; }
    if (url.includes('/action')) throw new Error('offline');
    return response(url.endsWith('/pair') ? {} : {id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]});
  });
  await f.controller.connect('http://localhost:53121/#token=x'); await f.controller.start(task, 'D:\\图片', false);
  const old = f.controller.poll(); assert.equal(polling, true);
  await f.controller.clear(); const count = f.updates.length;
  pending.resolve(response({id:'job-1',status:'done',items:[]})); await old;
  assert.equal(f.controller.job, null); assert.equal(f.updates.length, count);
});
test('clear during job submission ignores response and stops the newly created matching job', async () => {
  const pending = deferred(), actions = [];
  const f = setup(async (url, options) => {
    if (url.endsWith('/jobs')) return pending.promise;
    if (url.endsWith('/action')) actions.push(JSON.parse(options.body));
    return response({});
  });
  await f.controller.connect('http://localhost:53121/#token=x');
  const task = fixture(), start = f.controller.start(task, 'D:\\图片', false);
  await f.controller.clear(); const count = f.updates.length;
  pending.resolve(response({id:'job-late',kind:'collector',source_task_id:task.id,status:'running',items:[]})); await start;
  assert.equal(f.controller.job, null); assert.equal(f.updates.length,count);
  assert.deepEqual(actions, [{job_id:'job-late',source_task_id:task.id,action:'cancel'}]);
});
test('deleting a participating product invalidates its batch while unrelated products retain it', async () => {
  const actions = []; const task = fixture();
  const f = setup(async (url, options) => { if (url.endsWith('/action')) actions.push(JSON.parse(options.body)); return response(url.endsWith('/jobs') ? {id:'job-1',kind:'collector',source_task_id:task.id,status:'running',items:[]} : {}); });
  await f.controller.connect('http://localhost:53121/#token=x'); await f.controller.start(task,'D:\\图片',false);
  await f.controller.removeProduct(task.id,'taobao','999'); assert.equal(f.controller.job.id,'job-1');
  await f.controller.removeProduct(task.id,'pdd','101'); assert.equal(f.controller.job,null);
  assert.deepEqual(actions,[{job_id:'job-1',source_task_id:task.id,action:'cancel'}]);
});
test('clear prevents pending connection and folder responses from restoring UI or credentials', async () => {
  const pending = deferred(); const f = setup(async () => pending.promise);
  const connecting = f.controller.connect('http://localhost:53121/#token=x');
  await f.controller.clear(); pending.resolve(response({})); await connecting;
  assert.equal(f.client.connection,null); assert.equal(f.saved.size,0);
});
test('completed conversion can reconnect after tool restart without clearing source collection',async()=>{
  const task=fixture();
  const f=setup(async url=>response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'completed',items:[]}:{}));
  await f.controller.connect('http://localhost:53121/#token=old');await f.controller.start(task,'D:\\图片',false);
  await f.controller.connect('http://localhost:54121/#token=new');
  assert.equal(f.client.connection.token,'new');assert.equal(f.controller.job,null);
  assert.equal(task.jobs[0].groups.length,3);
});
test('clear discards outstanding folder, action, image and workbook results',async()=>{
  for(const kind of ['folder','action','image','manifest']){
    const pending=deferred();let waiting=false;
    const task=fixture();
    const f=setup(async url=>{
      if(waiting && !url.endsWith('/action'))return pending.promise;
      if(waiting && kind==='action'){waiting=false;return pending.promise;}
      return response(url.endsWith('/jobs')?{id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',items:[]}:{});
    });
    await f.controller.connect('http://localhost:53121/#token=x');await f.controller.start(task,'D:\\图片',false);
    waiting=true;
    const operation=kind==='folder'?f.controller.chooseFolder():kind==='action'?f.controller.action('continue'):kind==='image'?f.controller.image(0,'original'):f.controller.manifest();
    await f.controller.clear();const count=f.updates.length;
    pending.resolve({ok:true,json:async()=>({path:'D:\\不应出现',id:'job-1',status:'running',items:[]}),blob:async()=>new Blob(['stale'])});
    const result=await operation;
    assert.equal(f.controller.job,null);assert.equal(f.updates.length,count);assert.equal(f.controller.outputDir,'D:\\图片');
    if(['image','manifest'].includes(kind))assert.equal(result,null);
  }
});
test('paid start validates capabilities and confirmation and freezes selected entries before capability refresh',async()=>{
  const task=fixture(), pending=deferred(), jobs=[];let hold=false;
  const f=setup(async(url,options)=>{
    if(url.endsWith('/capabilities'))return hold?pending.promise:response(capabilities);
    if(url.endsWith('/jobs')){const body=JSON.parse(options.body);jobs.push(body);return response({id:'paid-1',kind:'collector',source_task_id:task.id,status:'paused',provider:body.provider,image_kinds:body.image_kinds,paid_calls:1,items:[]});}
    if(url.endsWith('/action'))return response({id:'paid-1',kind:'collector',source_task_id:task.id,status:'paused',provider:'aliyun',image_kinds:['sku'],paid_calls:2,items:[]});
    return response({});
  });
  await f.controller.connect('http://localhost:53121/#token=x');assert.equal(f.controller.view().capabilities.aliyun_configured,true);
  await assert.rejects(f.controller.start(task,'D:\\图片',false,{imageKinds:[],provider:'doubao'}),/选择/);
  await assert.rejects(f.controller.start(task,'D:\\图片',false,{provider:'aliyun',paidConfirmed:false}),/付费/);
  hold=true;const kinds=['sku'], starting=f.controller.start(task,'D:\\图片',false,{imageKinds:kinds,provider:'aliyun',paidConfirmed:true});
  kinds.push('main');task.jobs[0].groups[1].best.skus.push({id:'later',image:'https://img.pddpic.com/later.jpg'});
  pending.resolve(response(capabilities));await starting;
  assert.equal(jobs.length,1);assert.deepEqual(jobs[0].image_kinds,['sku']);assert.equal(jobs[0].entries.length,3);assert.equal(jobs[0].paid_confirmed,true);assert.equal(jobs[0].provider,'aliyun');
  await assert.rejects(f.controller.action('redo',0),/付费/);
  await f.controller.action('redo',0,undefined,{paidConfirmed:true});
});
test('old tool capability 404 requires an upgrade for both integrated free and paid entries',async()=>{
  const task=fixture(),jobs=[];
  const f=setup(async(url,options)=>{if(url.endsWith('/capabilities'))return {ok:false,status:404};if(url.endsWith('/jobs')){jobs.push(JSON.parse(options.body));return response({id:'free-1',kind:'collector',source_task_id:task.id,status:'completed',items:[]});}return response({});});
  await f.controller.connect('http://localhost:53121/#token=x');
  await assert.rejects(f.controller.start(task,'D:\\图片',false,{provider:'aliyun',paidConfirmed:true}),/升级/);
  await assert.rejects(f.controller.start(task,'D:\\图片',false,{imageKinds:['detail']}),/升级/);
  assert.equal(jobs.length,0);
});
test('capability refresh rejects unconfigured paid start and late status cannot overwrite a reconnected tool',async()=>{
  const pending=deferred();let hold=false,configured=false;
  const f=setup(async(url,options)=>url.endsWith('/capabilities')?(hold?pending.promise:response({...capabilities,aliyun_configured:configured})):response({}));
  await f.controller.connect('http://localhost:53121/#token=old');
  await assert.rejects(f.controller.start(fixture(),'D:\\图片',false,{provider:'aliyun',paidConfirmed:true}),/配置/);
  hold=true;const refresh=f.controller.refreshCapabilities();await f.controller.clear();hold=false;configured=true;
  await f.controller.connect('http://localhost:54121/#token=new');pending.resolve(response({...capabilities,aliyun_configured:false}));await refresh;
  assert.equal(f.controller.view().capabilities.aliyun_configured,true);assert.equal(f.client.connection.token,'new');
});
test('invalid start/action snapshots cannot take ownership of another source and uncertain Aliyun retry is blocked locally',async()=>{
  const task=fixture();let wrong=true;
  const f=setup(async url=>response(url.endsWith('/capabilities')?capabilities:url.endsWith('/jobs')||url.endsWith('/action')?{id:'paid-1',kind:'collector',source_task_id:wrong?'other':task.id,status:'paused',provider:'aliyun',image_kinds:['sku'],paid_calls:1,items:[{index:0,status:'paused',phase:'uncertain'}]}:{}));
  await f.controller.connect('http://localhost:53121/#token=x');
  await assert.rejects(f.controller.start(task,'D:\\图片',false,{provider:'aliyun',paidConfirmed:true}),/不一致/);assert.equal(f.controller.job,null);
  wrong=false;await f.controller.start(task,'D:\\图片',false,{provider:'aliyun',paidConfirmed:true});
  await assert.rejects(f.controller.action('retry',0),/重新生成/);
  wrong=true;await assert.rejects(f.controller.action('continue'),/不一致/);assert.equal(f.controller.job.source_task_id,task.id);
});
test('clear during paid capability validation prevents any eventual paid submission',async()=>{
  const pending=deferred(),jobs=[];let hold=false;
  const f=setup(async(url,options)=>{if(url.endsWith('/capabilities'))return hold?pending.promise:response(capabilities);if(url.endsWith('/jobs'))jobs.push(JSON.parse(options.body));return response({});});
  await f.controller.connect('http://localhost:53121/#token=x');hold=true;
  const starting=f.controller.start(fixture(),'D:\\图片',false,{provider:'aliyun',paidConfirmed:true});await f.controller.clear();
  pending.resolve(response(capabilities));await starting;
  assert.equal(jobs.length,0);assert.equal(f.controller.job,null);assert.equal(f.controller.pendingSource,null);
});
test('reconnection keeps original snapshot until capabilities and owned job both validate',async()=>{
  const task=fixture(),pending=deferred();let reconnecting=false;
  const f=setup(async url=>{
    if(url.endsWith('/capabilities'))return reconnecting?pending.promise:response(capabilities);
    if(url.endsWith('/jobs')||url.includes('/state'))return response({id:'job-1',kind:'collector',source_task_id:task.id,status:'paused',provider:'aliyun',image_kinds:['main'],paid_calls:reconnecting?9:1,items:[]});
    return response({});
  });
  await f.controller.connect('http://localhost:53121/#token=old');await f.controller.start(task,'D:\\图片',false);
  reconnecting=true;const connecting=f.controller.connect('http://localhost:54121/#token=new');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.job.paid_calls,1);await f.controller.clear();pending.resolve(response(capabilities));await connecting;
  assert.equal(f.controller.job,null);assert.equal(f.client.connection.token,'old');
});

test('per-kind limits select first positions globally before URL dedup for all seven kind combinations',()=>{
 const task=fixture(), all=buildImageManifest(task), kinds=['main','detail','sku'];
 for(let mask=1;mask<8;mask++){
  const selected=kinds.filter((_,i)=>mask&(1<<i)), counts={};
  const expected=all.filter(ref=>selected.includes(ref.kind)&&(counts[ref.kind]=(counts[ref.kind]||0)+1)<=({main:2,detail:1,sku:1}[ref.kind]));
  assert.deepEqual(buildImageManifest(task,selected,{main:2,detail:1,sku:1}),expected);
 }
});
test('selected invalid limits reject while unchecked limits are ignored and blanks are unlimited',()=>{
 for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'no']) assert.throws(()=>buildImageManifest(fixture(),['main'],{main:value}),/数量/);
 assert.deepEqual(buildImageManifest(fixture(),['main'],{main:'',detail:-1}),buildImageManifest(fixture(),['main']));
});
test('limited controller submissions freeze limits and original available counts and recover ownership',async()=>{
 const task=fixture(), bodies=[], f=setup(async(url,options)=>{if(url.endsWith('/capabilities'))return response({...capabilities,image_type_limits:true});if(url.endsWith('/jobs')){bodies.push(JSON.parse(options.body));return response({id:'limited',kind:'collector',source_task_id:task.id,status:'paused',items:[]});}return response({});});
 await f.controller.connect('http://localhost:53121/#token=x');
 const limits={main:2,detail:1,sku:1};await f.controller.start(task,'',false,{imageLimits:limits});limits.main=99;
 assert.deepEqual(bodies[0].image_limits,{main:2,detail:1,sku:1});assert.equal(bodies[0].entries.length,4);
 const restored=reloaded(f,async()=>response({...f.controller.job,items:[]}));
 assert.deepEqual(restored.job.image_limits,{main:2,detail:1,sku:1});assert.deepEqual(restored.availableCounts,{main:4,detail:1,sku:3});assert.equal(restored.entries.length,4);
});
test('limits capability only gates limited new batches',async()=>{
 const task=fixture(), f=setup(async url=>response(url.endsWith('/jobs')?{id:'old',kind:'collector',source_task_id:task.id,status:'completed',items:[]}:capabilities));await f.controller.connect('http://localhost:53121/#token=x');
 await assert.rejects(f.controller.start(task,'',false,{imageLimits:{main:1}}),/1\.6\.4|升级/);
 await f.controller.start(task,'',false);assert.equal(f.controller.job.id,'old');
});

test('paid pending limit snapshot ignores option and source mutations through submission and resume',async()=>{
 const task=fixture(), pending=deferred(), bodies=[];let hold=false;
 const f=setup(async(url,options)=>{if(url.endsWith('/capabilities'))return hold?pending.promise:response({...capabilities,image_type_limits:true});if(url.endsWith('/jobs')){bodies.push(JSON.parse(options.body));return response({id:'frozen',kind:'collector',source_task_id:task.id,status:'paused',items:[]});}if(url.endsWith('/action'))return response({...f.controller.job,status:'running',items:[]});return response({});});
 await f.controller.connect('http://localhost:53121/#token=x');hold=true;
 const limits={main:2}, kinds=['main'], starting=f.controller.start(task,'',false,{imageKinds:kinds,imageLimits:limits,provider:'aliyun',paidConfirmed:true});
 assert.deepEqual(f.controller.pendingSource.availableCounts,{main:4,detail:1,sku:3});limits.main=4;kinds.push('sku');task.jobs[0].groups[1].best.galleryImages.push('https://img.pddpic.com/later.jpg');
 pending.resolve(response({...capabilities,image_type_limits:true}));await starting;
 assert.deepEqual(bodies[0].image_limits,{main:2,detail:null,sku:null});assert.equal(bodies[0].entries.length,2);assert.deepEqual(bodies[0].image_kinds,['main']);
 await f.controller.action('continue');assert.deepEqual(f.controller.job.image_limits,{main:2,detail:null,sku:null});assert.equal(f.controller.entries.length,2);
});
