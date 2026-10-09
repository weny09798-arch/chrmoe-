import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, ConversionController } from '../extension/lib/image-conversion.mjs';
import { Runner } from '../extension/lib/runner.mjs';
import { createTask, selected } from '../extension/lib/core.mjs';

const allowed = {allowed:true,status:'active',expires_at:2000000000,lease_until:1900000000,offline:false,message:'授权有效',remaining_days:30,checked_at:1800000000};
function fixture({license=allowed,licensing=true,offline=false,capability404=false}={}) {
  const requests=[],saved=new Map();
  const client=new BridgeClient({extensionId:'license-test',storage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},fetch:async(url,options)=>{
    requests.push([url.split('/api/bridge/')[1],options.body && JSON.parse(options.body)]);
    if(offline)throw new Error('closed');
    if(capability404 && url.endsWith('/capabilities'))return {ok:false,status:404,json:async()=>({})};
    const value=url.endsWith('/capabilities')?{licensing,providers:['doubao'],image_link_replacement:true,cloud_image_storage:true,oss_configured:true}:url.includes('/license/')?license:{};
    return {ok:true,json:async()=>value};
  }});
  const controller=new ConversionController({client});
  return {client,controller,requests,setLicense:value=>{license=value;}};
}
test('paired local authority fails closed when disconnected, old, closed, expired or validation is pending',async()=>{
  for(const [options,connect,reason] of [[{},false,/连接/],[{licensing:false},true,/升级/],[{capability404:true},true,/升级/],[{offline:true},true,/连接/],[{license:{allowed:false,status:'expired',message:'授权已到期'}},true,/到期/],[{license:{status:'validation_in_progress',message:'正在校验授权'}},true,/校验/]]){
    const f=fixture(options);if(connect)f.client.remember({baseUrl:'http://localhost:53121',token:'pair'});
    await assert.rejects(async()=>f.controller.requireLicense(),reason);
    assert.equal(f.requests.some(([route])=>route==='jobs'),false);
  }
});
test('start authorization refreshes native authority and activation never starts or resumes a task',async()=>{
  const f=fixture();await f.controller.connect('http://localhost:53121/#token=pair');
  await f.controller.requireLicense({refresh:true});
  await f.controller.activateLicense(' monthly-code ');
  assert.deepEqual(f.requests.filter(([route])=>route.startsWith('license/')), [['license/status',undefined],['license/refresh',{}],['license/activate',{code:'monthly-code'}]]);
  assert.equal(f.controller.view().license.allowed,true);
  assert.equal(f.requests.some(([route])=>['jobs','action'].includes(route)),false);
});
test('423 denial preserves pairing and exposes only the safe public license reason',async()=>{
  const client=new BridgeClient({extensionId:'test',storage:null,fetch:async()=>({ok:false,status:423,json:async()=>({error:'unsafe secret',license:{allowed:false,status:'expired',message:'授权已到期'}})})});
  client.remember({baseUrl:'http://localhost:53121',token:'pair'});
  await assert.rejects(client.request('jobs',{body:{}}),error=>error.status===423 && error.licenseDenied===true && error.message.includes('到期') && !error.message.includes('unsafe'));
  assert.equal(client.connection.token,'pair');
});
test('conversion start and new generation deny expired license while upload retry and saved reads remain accessible',async()=>{
  const f=fixture();await f.controller.connect('http://localhost:53121/#token=pair');
  const task=createTask(['相机']);task.status='done';task.jobs[0].status='done';task.jobs[0].groups=[{best:{id:'1',title:'相机',image:'https://img.pddpic.com/1.jpg'}}];
  f.setLicense({allowed:false,status:'expired',message:'授权已到期'});
  await assert.rejects(f.controller.start(task),/到期/);assert.equal(f.requests.some(([route])=>route==='jobs'),false);
  f.controller.job={id:'job',kind:'collector',source_task_id:task.id,status:'paused',items:[]};f.controller.sourceTaskId=task.id;
  await assert.rejects(f.controller.action('redo',0),/到期/);await assert.rejects(f.controller.action('continue'),/到期/);
  const native=f.client.fetch;f.client.fetch=async(url,options)=>url.endsWith('/action')?{ok:true,json:async()=>f.controller.job}:native(url,options);
  await f.controller.action('retry-upload',0);await f.controller.clear();assert.equal(f.controller.job,null);
});
test('clearing conversion while authorization is pending suppresses stale license UI and job submission',async()=>{
  const f=fixture();await f.controller.connect('http://localhost:53121/#token=pair');
  let release;const pending=new Promise(resolve=>{release=resolve;});const native=f.client.fetch,updates=[];
  f.controller.onChange=state=>updates.push(state);
  f.client.fetch=async(url,options)=>url.endsWith('/license/refresh')?pending:native(url,options);
  const task=createTask(['相机']);task.status='done';task.jobs[0].groups=[{best:{id:'1',title:'相机',image:'https://img.pddpic.com/1.jpg'}}];
  const start=f.controller.start(task);await f.controller.clear();const count=updates.length;
  release({ok:true,json:async()=>allowed});await start;
  assert.equal(f.requests.some(([route])=>route==='jobs'),false);assert.equal(updates.length,count);
});
test('native 423 and paused snapshots update the public license while preserving the paired connection',async()=>{
  const f=fixture();await f.controller.connect('http://localhost:53121/#token=pair');
  const task=createTask(['相机']);task.status='done';task.jobs[0].groups=[{best:{id:'1',title:'相机',image:'https://img.pddpic.com/1.jpg'}}];
  const native=f.client.fetch;f.client.fetch=async(url,options)=>url.endsWith('/jobs')?{ok:false,status:423,json:async()=>({license:{allowed:false,status:'expired',message:'授权到期'}})}:native(url,options);
  await assert.rejects(f.controller.start(task),/到期/);assert.equal(f.controller.view().license.allowed,false);assert.equal(f.client.connection.token,'pair');
  f.controller.sourceTaskId=task.id;f.controller.job={id:'job'};
  await f.controller.acceptSnapshot({id:'job',kind:'collector',source_task_id:task.id,status:'paused',items:[],license:{allowed:false,status:'disabled',message:'授权禁用'}},'job');
  assert.equal(f.controller.view().license.status,'disabled');
});
test('expired submitted-result retrieval can continue or retry while new generation remains denied',async()=>{
  for(const [action,phase] of [['continue','pending'],['continue','uploading'],['retry','saving'],['retry','pending'],['retry','aliyun-downloading'],['retry','alias']]){
    const f=fixture();await f.controller.connect('http://localhost:53121/#token=pair');
    const denied={allowed:false,status:'expired',message:'授权到期'};f.setLicense(denied);await f.controller.checkLicense();
    f.controller.sourceTaskId='source';f.controller.job={id:'job',kind:'collector',source_task_id:'source',status:'paused',items:[{index:0,status:'paused',phase,...(phase==='alias'?{alias_of:1}:{})},{index:1,status:'completed',phase:'done'}]};
    const native=f.client.fetch;let actions=0;f.client.fetch=async(url,options)=>{if(url.endsWith('/action')){actions++;return {ok:true,json:async()=>({...f.controller.job,status:'completed',license:denied})};}return native(url,options);};
    await f.controller.action(action,action==='retry'?0:undefined);
    assert.equal(f.controller.view().job.status,'completed',phase);assert.equal(f.controller.view().license.allowed,false);assert.equal(actions,1);
    await assert.rejects(f.controller.action('redo',0),/到期/);assert.equal(actions,1);
  }
});
const card=id=>({id,key:id,title:'相机',url:`https://detail.1688.com/offer/${id}.html`,priceText:'¥10'});
function ports(overrides={}){return {authorize:async()=>allowed,save:async()=>{},update(){},open:async()=>{},read:async()=>({cards:[card('1'),card('2')],end:true}),enrich:async()=>({descriptionText:'详情'}),close:async()=>{},wait:async()=>{},...overrides};}
test('Runner missing production authority pauses without opening a search or marking work done',async()=>{
  const task=createTask(['相机']);let opened=0;const p=ports({open:async()=>opened++});delete p.authorize;
  await new Runner(task,p).run();assert.equal(opened,0);assert.equal(task.status,'paused');assert.equal(task.jobs[0].status,'paused');
});
test('Runner checks search, read, prepare, resolve, enrich and scroll boundaries',async()=>{
  for(const denied of ['search','read','prepareCard','resolve','enrich','scroll']){
    const task=createTask(['相机']);task.jobs[0].site='taobao';const operations=[];
    const p=ports({authorize:async boundary=>({allowed:boundary!==denied,message:'授权已到期'}),open:async()=>operations.push('search'),read:async()=>{operations.push('read');return {cards:[{...card('1'),id:''}],end:false};},prepareCard:async c=>{operations.push('prepareCard');return c;},resolve:async c=>{operations.push('resolve');return {...c,id:'1'};},enrich:async()=>{operations.push('enrich');return {descriptionText:'详情'};},scroll:async()=>operations.push('scroll')});
    if(denied==='enrich')p.read=async()=>({cards:[card('1')],end:true});
    await new Runner(task,p).run();assert.equal(task.status,'paused',denied);assert.equal(operations.includes(denied),false,denied);assert.equal(task.jobs[0].skipped,0,denied);
  }
});
test('periodic denial wins over an older allowed boundary response still in flight',async()=>{
  const task=createTask(['相机']);let poll,release,announce;const entered=new Promise(r=>{announce=r;}),pending=new Promise(r=>{release=r;});let reads=0;
  const runner=new Runner(task,ports({setTimer:fn=>{poll=fn;return 1;},clearTimer:()=>{},authorize:async boundary=>{if(boundary==='read'){announce();return pending;}return boundary==='poll'?{allowed:false,message:'授权禁用'}:allowed;},read:async()=>{reads++;return {cards:[],end:true};}}));
  const running=runner.run();await entered;await poll();release(allowed);await running;
  assert.equal(reads,0);assert.equal(task.status,'paused');
});
test('revocation during a list read pauses before consuming even an invalid next product',async()=>{
  const task=createTask(['相机']);let poll,license=allowed;
  await new Runner(task,ports({setTimer:fn=>{poll=fn;return 1;},clearTimer:()=>{},authorize:async()=>license,read:async()=>{license={allowed:false,message:'授权禁用'};await poll();return {cards:[{...card('1'),title:''}],end:true};}})).run();
  assert.equal(task.jobs[0].scanned,0);assert.equal(task.jobs[0].skipped,0);assert.equal(task.jobs[0].status,'paused');
});
test('periodic revocation preserves the current resolved product and pauses before the next product',async()=>{
  const task=createTask(['相机']);task.jobs[0].site='1688';let poll,license=allowed,resolved=0;const delays=[];
  const runner=new Runner(task,ports({setTimer:(fn,ms)=>{poll=fn;delays.push(ms);return 1;},clearTimer:()=>{},authorize:async()=>license,read:async()=>({cards:[{...card('1'),id:''},{...card('2'),id:''}],end:true}),resolve:async c=>{resolved++;license={allowed:false,message:'授权已禁用'};await poll();return {...c,id:c.key};}}));
  await runner.run();assert.deepEqual(delays,[300000]);assert.deepEqual(selected(task.jobs[0]).map(x=>x.id),['1']);assert.equal(resolved,1);assert.equal(task.status,'paused');assert.equal(task.jobs[0].scanned,1);
});
test('periodic denial keeps completed in-flight detail and renewal requires manual run',async()=>{
  const task=createTask(['相机']);task.jobs[0].site='1688';let poll,license=allowed,calls=0;
  const p=ports({setTimer:fn=>{poll=fn;return 1;},clearTimer:()=>{},authorize:async()=>license,enrich:async()=>{calls++;license={allowed:false,message:'到期'};await poll();return {descriptionText:'已保存详情'};}});
  await new Runner(task,p).run();assert.equal(selected(task.jobs[0])[0].descriptionText,'已保存详情');assert.equal(calls,1);assert.equal(task.status,'paused');
  assert.equal(task.jobs[0].status,'paused');
  license=allowed;await Promise.resolve();assert.equal(calls,1);
  p.enrich=async()=>{calls++;return {descriptionText:'续费后详情'};};await new Runner(task,p).run();assert.equal(calls,2);assert.equal(task.status,'done');
});
test('denial during the final in-flight detail saves it once and leaves the job paused',async()=>{
  const task=createTask(['相机','书包']);task.jobs.forEach(j=>j.site='1688');task.jobs[0].limit=1;let poll,license=allowed;const savedDetails=[],searches=[];
  await new Runner(task,ports({setTimer:fn=>{poll=fn;return 1;},clearTimer:()=>{},authorize:async()=>license,open:async j=>searches.push(j.keyword),save:async current=>{const item=selected(current.jobs[0])[0];if(item?.descriptionText)savedDetails.push(item.descriptionText);},enrich:async()=>{license={allowed:false,message:'授权到期'};await poll();return {descriptionText:'最终详情'};}})).run();
  assert.equal(selected(task.jobs[0])[0].descriptionText,'最终详情');assert.equal(task.jobs[0].status,'paused');assert.deepEqual(searches,['相机']);assert.equal(task.jobs[1].status,'pending');
  assert.equal(task.jobs[0].scanned,1);assert.ok(savedDetails.length>0);
});
