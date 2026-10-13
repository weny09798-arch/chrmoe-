import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, ConversionController } from '../extension/lib/image-conversion.mjs';
const capabilities={version:'1.6.6',unified_plugin:true,automatic_backend:true,settings_in_plugin:true,providers:['doubao','aliyun']};
const code='http://127.0.0.1:53121/#token=fixture';
const ref={platform:'pdd',product_id:'1',title:'杯',kind:'main',order:1,sku_index:null,url:'https://img.pddpic.com/a.jpg',published_url:'https://bucket.oss-cn-hangzhou.aliyuncs.com/a.png'};
function setup(current, overrides={}) {
  const task={id:'source-1',status:'done',jobs:[{keyword:'杯',groups:[{best:{id:'1',title:'玻璃杯',image:ref.url}}]}],imageReplacements:[ref]},requests=[],saved=new Map(),replacements=[];
  const client=new BridgeClient({extensionId:'a'.repeat(32),storage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},fetch:async(url,options)=>{
    const route=url.split('/api/bridge/')[1];requests.push({route,options});
    const value=route==='capabilities'?{...capabilities,...overrides}:route==='current'?current:route==='reset'?{status:'idle'}:{};
    return {ok:true,json:async()=>value};
  }});
  const controller=new ConversionController({client,getTask:()=>task,onReplacements:async(id,refs)=>replacements.push({id,refs})});
  return {task,client,controller,requests,saved,replacements};
}
test('automatic reconnection restores durable same-source links without a saved handle or new submission',async()=>{
  const f=setup({id:'recovered',kind:'collector',source_task_id:'source-1',status:'paused',provider:'aliyun',image_kinds:['main'],image_limits:{main:1},translate_product_text:true,items:[{status:'completed',refs:[ref]}]});
  await f.controller.connectAutomatic(code,f.task);
  assert.equal(f.controller.job.id,'recovered');assert.equal(f.controller.job.translate_product_text,true);assert.equal(f.controller.entries.length,1);
  assert.equal(f.replacements[0].refs[0].published_url,ref.published_url);assert.deepEqual(f.requests.map(r=>r.route),['pair','capabilities','current']);
});
test('foreign collector and standalone jobs are isolated until explicit scoped reset',async()=>{
  for(const current of [{id:'foreign',kind:'collector',source_task_id:'source-2',status:'running',items:[{status:'completed',refs:[ref]}]},{id:'local',kind:'local',status:'paused',items:[]}]) {
    const f=setup(current),before=structuredClone(f.task);await f.controller.connectAutomatic(code,f.task);
    assert.equal(f.controller.job,null);assert.equal(f.controller.view().conflict.id,current.id);assert.equal(f.replacements.length,0);
    await assert.rejects(f.controller.start(f.task),/其他|清空/);await assert.rejects(f.controller.action('open-browser'),/其他|清空/);
    await f.controller.resetConversion();assert.deepEqual(JSON.parse(f.requests.at(-1).options.body),{job_id:current.id,source_task_id:current.source_task_id??null});
    assert.deepEqual(f.task,before);assert.equal(f.controller.view().conflict,null);
  }
});
test('unsupported automatic backend refuses capability upgrade without storing its token',async()=>{
  const f=setup({status:'idle'},{unified_plugin:false});await assert.rejects(f.controller.connectAutomatic(code,f.task),/升级/);
  assert.equal(f.client.connection,null);assert.equal(f.saved.size,0);assert.equal(f.requests.some(r=>r.route==='current'),false);
});
test('conversion reset preserves collection and saved exported links',async()=>{
  const f=setup({id:'owned',kind:'collector',source_task_id:'source-1',status:'paused',items:[]});await f.controller.connectAutomatic(code,f.task);
  const before=structuredClone(f.task);await f.controller.resetConversion();assert.deepEqual(f.task,before);assert.equal(f.controller.job,null);assert.equal(f.saved.has('collector-image-owned-job'),false);
});
test('automatic reload revalidates a recovering session handle against the durable current task',async()=>{
  const f=setup({id:'owned',kind:'collector',source_task_id:'source-1',status:'paused',items:[{status:'completed',refs:[ref]}]});
  f.client.remember({baseUrl:'http://127.0.0.1:53121',token:'old'});
  f.saved.set('collector-image-owned-job',JSON.stringify({job_id:'owned',source_task_id:'source-1',products:[{platform:'pdd',product_id:'1'}]}));
  const restored=new ConversionController({client:f.client,getTask:()=>f.task,onReplacements:async(id,refs)=>f.replacements.push({id,refs})});
  assert.equal(restored.restored,true);await restored.connectAutomatic(code,f.task);assert.equal(restored.job.status,'paused');assert.equal(f.replacements.length,1);
});
test('malformed current task never replaces an existing connection or owned identity',async()=>{
  const f=setup({kind:'collector',status:'running'});f.client.remember({baseUrl:'http://127.0.0.1:53121',token:'old'});
  await assert.rejects(f.controller.connectAutomatic(code,f.task),/状态/);assert.equal(f.client.connection.token,'old');
});
