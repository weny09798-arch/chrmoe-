import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildImageManifest, BridgeClient, ConversionController, mergeImageReplacements } from '../extension/lib/image-conversion.mjs';
import { taskSheets, workbookBytes, workbookXlsBytes } from '../extension/lib/xlsx.mjs';

const original='https://img.example/a.jpg', published='https://bucket.oss-cn-shanghai.aliyuncs.com/converted/a.png';
const caps={providers:['doubao','aliyun'],oss_configured:true,image_link_replacement:true,aliyun_configured:true};
function fixture(){return {id:'source',status:'done',jobs:[{keyword:'杯',site:'pdd',groups:[{best:{id:'101',title:'玻璃杯',cents:1234,image:original,galleryImages:[original,'https://img.example/b.jpg'],detailImages:[original],skus:[{id:'duplicate',specs:['红'],image:original,cents:1500},{id:'duplicate',specs:['蓝'],image:original,cents:1600}]}}]},{keyword:'杯',site:'taobao',groups:[{best:{id:'101',site:'taobao',title:'保温杯',cents:2000,image:original}}]}]};}
const response=value=>({ok:true,json:async()=>value});
test('main-only replacement does not change the unselected fallback SKU image',()=>{
  const task=fixture();const item=task.jobs[0].groups[0].best;delete item.skus;
  const refs=buildImageManifest(task,['main']).map(ref=>({...ref,published_url:published}));
  mergeImageReplacements(task,refs);
  const row=taskSheets(task)[0].rows[9];
  assert.equal(row[3],`${published}，${published}`);
  assert.equal(row[18],original);
});
async function controllerFixture(task,extra={}){
  const saved=new Map(),requests=[],mappings=[];let snapshot={id:'batch',kind:'collector',source_task_id:task.id,status:'paused',items:[]};
  const client=new BridgeClient({extensionId:'extension',storage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},fetch:async(url,options)=>{requests.push({url,body:options.body&&JSON.parse(options.body)});return response(url.endsWith('/capabilities')?caps:url.endsWith('/jobs')||url.includes('/state')||url.endsWith('/action')?snapshot:{});}});
  const controller=new ConversionController({client,getTask:()=>task,onReplacements:async(source,refs)=>{mappings.push({source,refs});},...extra});
  await controller.connect('http://localhost:53121/#token=test');await controller.start(task,'D:\\图片');
  return {controller,client,requests,mappings,setSnapshot:value=>{snapshot=value;}};
}
test('SKU manifest keeps original array index even when IDs repeat or images are empty',()=>{
  const task=fixture();task.jobs[0].groups[0].best.skus.unshift({id:'empty'});
  assert.deepEqual(buildImageManifest(task).map(ref=>[ref.kind,ref.order,ref.sku_index]),[['main',1,null],['main',2,null],['detail',1,null],['sku',2,1],['sku',3,2],['main',1,null]]);
});
test('verified completed OSS refs persist only matching source slots and never edit original products',async()=>{
  const task=fixture(),before=structuredClone(task),f=await controllerFixture(task),entries=buildImageManifest(task);
  const refs=entries.map(ref=>({...ref,published_url:published,published_revision:2}));
  refs.push({...refs[0],product_id:'other'},{...refs[0],url:'https://img.example/stale.jpg'},{...refs[0],published_url:'https://example.com/no.png'},{...refs[0],sku_index:8});
  f.setSnapshot({id:'batch',kind:'collector',source_task_id:task.id,status:'completed',items:[{status:'completed',phase:'done',refs},{status:'failed',phase:'upload-failed',refs:[{...entries[1],published_url:published}]}]});
  await f.controller.poll();
  assert.equal(f.mappings.length,1);assert.equal(f.mappings[0].source,'source');assert.equal(f.mappings[0].refs.length,6);
  assert.deepEqual(task,before);
});
test('changed original URL and deleted SKU slots cannot receive a late published result',async()=>{
  const task=fixture(),f=await controllerFixture(task),refs=buildImageManifest(task,['sku']).map(ref=>({...ref,published_url:published}));
  task.jobs[0].groups[0].best.skus[0].image='https://img.example/changed.jpg';task.jobs[0].groups[0].best.skus.pop();
  f.setSnapshot({id:'batch',kind:'collector',source_task_id:task.id,status:'completed',items:[{status:'completed',refs}]});await f.controller.poll();assert.equal(f.mappings.length,0);
});
test('a published ref cannot point at a different input image item even if its position matches',async()=>{
  const task=fixture(),f=await controllerFixture(task),ref={...buildImageManifest(task)[0],published_url:published};
  f.setSnapshot({id:'batch',kind:'collector',source_task_id:task.id,status:'completed',items:[{status:'completed',url:'https://img.example/different.jpg',refs:[ref]}]});
  await f.controller.poll();assert.equal(f.mappings.length,0);
});
test('legacy SKU refs use order as index and replacement revisions cannot move backwards',()=>{
  const task=fixture(),ref={...buildImageManifest(task,['sku'])[1],published_url:published,job_id:'batch',published_revision:2};delete ref.sku_index;
  assert.equal(mergeImageReplacements(task,[ref]),true);assert.equal(task.imageReplacements[0].sku_index,1);
  mergeImageReplacements(task,[{...ref,published_revision:1,published_url:'https://bucket.oss-cn-shanghai.aliyuncs.com/older.png'}]);
  assert.equal(task.imageReplacements[0].published_url,published);
  mergeImageReplacements(task,[{...ref,job_id:'next-batch',published_revision:1,published_url:'https://bucket.oss-cn-shanghai.aliyuncs.com/new.png'}]);
  assert.equal(task.imageReplacements[0].published_url,'https://bucket.oss-cn-shanghai.aliyuncs.com/new.png');
});
test('cleared or deleted batches cannot persist a delayed published snapshot',async()=>{
  for(const deletion of [false,true]){
    const task=fixture(),f=await controllerFixture(task),ref={...buildImageManifest(task)[0],published_url:published};
    let release;f.client.fetch=async url=>url.includes('/state')?new Promise(resolve=>{release=resolve;}):response({});
    const polling=f.controller.poll();if(deletion)await f.controller.removeProduct(task.id,'pdd','101');else await f.controller.clear();
    release(response({id:'batch',kind:'collector',source_task_id:task.id,status:'completed',items:[{status:'completed',refs:[ref]}]}));await polling;assert.equal(f.mappings.length,0);
  }
});
test('partial replacement survives persistence in real XLSX and XLS without changing title price SKU or fallback URLs',()=>{
  const task=fixture(),before=structuredClone(task);
  task.imageReplacements=[
    {platform:'pdd',product_id:'101',kind:'main',order:1,sku_index:null,url:original,published_url:published},
    {platform:'pdd',product_id:'101',kind:'sku',order:2,sku_index:1,url:original,published_url:published},
    {platform:'pdd',product_id:'101',kind:'detail',order:1,sku_index:null,url:'https://img.example/stale.jpg',published_url:published}
  ];
  const restored=JSON.parse(JSON.stringify(task));
  for(const bytes of [workbookBytes(taskSheets(restored)),workbookXlsBytes(taskSheets(restored),XLSX)]){
    const sheet=XLSX.read(bytes,{type:'array'}).Sheets['模版'];
    assert.equal(sheet.D10.v,published+'，https://img.example/b.jpg');assert.equal(sheet.I10.v,original);
    assert.equal(sheet.S10.v,original);assert.equal(sheet.S11.v,published);assert.equal(sheet.D12.v,original);
    assert.equal(sheet.B10.v,'玻璃杯');assert.equal(sheet.R10.v,'15.00');assert.equal(sheet.R11.v,'16.00');assert.equal(sheet.Q11.v,'duplicate');assert.equal(sheet.O11.v,'蓝');
    assert.deepEqual(sheet['!merges'],[{s:{r:0,c:0},e:{r:7,c:11}}]);
  }
  assert.deepEqual(task.jobs,before.jobs);assert.deepEqual(taskSheets(restored)[0].imageReplacementCounts,{replaced:2,fallback:4,total:6});
});
test('integrated free conversion refuses old or unconfigured OSS tools before creating jobs',async()=>{
  for(const capabilities of [{providers:['doubao']},{...caps,oss_configured:false}]){
    const requests=[],client=new BridgeClient({extensionId:'extension',fetch:async(url,options)=>{requests.push(url);return response(url.endsWith('/capabilities')?capabilities:{});},storage:null});
    const controller=new ConversionController({client});await controller.connect('http://localhost:53121/#token=test');
    await assert.rejects(controller.start(fixture(),'D:\\图片'),capabilities.image_link_replacement?/OSS/:/升级/);assert.equal(requests.some(url=>url.endsWith('/jobs')),false);
  }
});
test('upload retry sends retry-upload while retaining the local completed image',async()=>{
  const task=fixture(),f=await controllerFixture(task);
  f.setSnapshot({id:'batch',kind:'collector',source_task_id:task.id,status:'paused',items:[{index:0,status:'failed',phase:'upload-failed',result:{output_path:'D:\\图片\\done.png'},refs:[]}]});
  await f.controller.poll();await f.controller.action('retry-upload',0);
  assert.deepEqual(f.requests.at(-1).body,{job_id:'batch',source_task_id:'source',action:'retry-upload',index:0});assert.equal(f.controller.job.items[0].result.output_path,'D:\\图片\\done.png');
});
