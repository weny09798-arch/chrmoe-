import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {BridgeClient} from '../extension/lib/image-conversion.mjs';
import {createSellingPointPanel} from '../extension/selling-point-ui.mjs';

const html=await readFile('extension/manager.html','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const saved={id:'saved',status:'draft',phase:'draft',source_filename:'商品.png',product_name:'陶瓷杯',facts:'容量250ml',headline:'商品展示',points:['杯身外觀'],draft_revision:1,result_revision:null,paid_calls:1,message:'草稿已儲存',public_url:'',result_available:false};
async function fixture({job=saved,configured=true,confirm=true,capabilities={selling_point_images:true,bailian_configured:true}}={}) {
 const {document,window}=parseHTML(html);let state=structuredClone(job),config=configured;
 const requests=[],revoked=[],downloads=[];let serial=0;
 const client=new BridgeClient({extensionId:'a'.repeat(32),storage:null,fetch:async(url,options)=>{
  const route=url.split('/api/bridge/')[1];requests.push({route,...options});
  if(route==='settings/bailian') {
   if(options.method==='POST')config=true;
   if(options.method==='DELETE')config=false;
   return Response.json({bailian_configured:config,workspace_id:'space123'});
  }
  if(route.includes('/images/'))return new Response(new Blob(['preserved-original'],{type:'image/png'}));
  if(route==='selling-points/jobs')state={...saved,id:'new-upload',status:'uploaded',phase:'uploaded',product_name:options.body.get('product_name'),facts:options.body.get('facts'),paid_calls:0,headline:'',points:[],draft_revision:0};
  if(route.endsWith('/generate'))state={...state,status:'draft',phase:'draft',paid_calls:state.paid_calls+1,headline:'新標題',points:['新賣點'],draft_revision:state.draft_revision+1};
  if(route.endsWith('/draft'))state={...state,...JSON.parse(options.body),status:'draft',draft_revision:state.draft_revision+1};
  if(route.endsWith('/render'))state={...state,status:'paused',phase:'upload-failed',message:'OSS 上傳失敗；已有圖片保留',result_revision:state.draft_revision,result_available:true};
  if(route.endsWith('/clear'))state={id:null,status:'idle'};
  return Response.json(state);
 }});
 client.remember({baseUrl:'http://127.0.0.1:51000',token:'fixture-token'});
 const originalCreate=document.createElement.bind(document);
 document.createElement=name=>{const node=originalCreate(name);if(name==='a')node.click=()=>downloads.push({name:node.download,url:node.href});return node;};
 const panel=createSellingPointPanel({document,client,confirm:()=>confirm,setTimer:()=>1,clearTimer:()=>{},urlAPI:{createObjectURL:()=>`blob:fixture-${++serial}`,revokeObjectURL:url=>revoked.push(url)}});
 await panel.update({connected:true,capabilities});
 const el=id=>document.getElementById('selling-'+id);
 const change=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new window.Event('input'));};
 const click=async id=>{el(id).dispatchEvent(new window.Event('click'));await panel.settled();};
 const enable=async()=>{el('enable').checked=true;el('enable').dispatchEvent(new window.Event('change'));await panel.settled();};
 const files=file=>{Object.defineProperty(el('image'),'files',{configurable:true,value:file?[file]:[]});el('image').dispatchEvent(new window.Event('change'));};
 return {document,window,panel,client,requests,revoked,downloads,el,click,enable,change,files,setState:value=>state=value};
}

test('refresh restores product facts alongside editable saved selling points',async()=>{
 const f=await fixture();await f.enable();
 assert.equal(f.el('name').value,'陶瓷杯');assert.equal(f.el('facts').value,'容量250ml');
 assert.equal(f.el('headline').value,'商品展示');assert.equal(f.requests.filter(r=>r.route.endsWith('/generate')).length,0);f.panel.dispose();
});
test('paused diagnostics and billed uncertainty are visible without a valid draft',async()=>{
 const f=await fixture({job:{...saved,status:'paused',phase:'request-uncertain',headline:'',points:[],message:'請補充真實商品資料；再次生成可能計費',error_code:'request-uncertain',request_id:'req-safe-1'}});await f.enable();
 assert.match(f.el('panel').textContent,/請補充真實商品資料/);assert.match(f.el('panel').textContent,/req-safe-1/);assert.match(f.el('panel').textContent,/付费请求\s*1/);f.panel.dispose();
});
test('insufficient model facts leave an editable draft that can be completed without AI',async()=>{
 const f=await fixture({job:{...saved,headline:'',points:[],phase:'needs-information',message:'請補充規格'}});await f.enable();
 assert.equal(f.el('draft').hidden,false);f.change('headline','杯身展示');f.change('points','白色杯身\n圖片展示外觀');
 assert.equal(f.el('render').disabled,false);await f.click('render');
 assert.equal(f.requests.filter(r=>r.route.endsWith('/generate')).length,0);assert.equal(f.requests.filter(r=>r.route.endsWith('/render')).length,1);f.panel.dispose();
});
test('editing restored facts reuses authenticated original bytes when browser file selection is gone',async()=>{
 const f=await fixture();await f.enable();f.change('facts','已確認容量250ml，白色');await f.click('generate');
 const upload=f.requests.find(r=>r.route==='selling-points/jobs');assert.ok(upload,'restored original should support supplemented facts');
 assert.equal(upload.body.get('facts'),'已確認容量250ml，白色');assert.equal(await upload.body.get('image').text(),'preserved-original');
 assert.equal(f.requests.filter(r=>r.route.endsWith('/generate')).length,1);f.panel.dispose();
});
test('deleted configuration stays deleted despite a render with cached capability flags',async()=>{
 const f=await fixture();await f.enable();await f.click('delete');await f.panel.update({connected:true,capabilities:{selling_point_images:true,bailian_configured:true}});
 assert.equal(f.el('generate').disabled,true);assert.match(f.el('config-status').textContent,/请先配置/);f.panel.dispose();
});
test('invalid workspace is explained locally and cannot save a configuration',async()=>{
 const f=await fixture();await f.enable();f.el('key').value='fixture-not-real-key';f.el('workspace').value='https://outside.example';await f.click('save');
 assert.equal(f.requests.filter(r=>r.route==='settings/bailian'&&r.method==='POST').length,0);assert.match(f.el('message').textContent,/业务空间/);f.panel.dispose();
});
test('upload failure keeps PNG download and retry performs no extra model or render request',async()=>{
 const f=await fixture();await f.enable();await f.click('render');const generated=f.requests.filter(r=>r.route.endsWith('/generate')).length;
 await f.click('download');assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].name,'selling-points.png');
 await f.click('retry');assert.equal(f.requests.filter(r=>r.route.endsWith('/retry-upload')).length,1);assert.equal(f.requests.filter(r=>r.route.endsWith('/render')).length,1);
 assert.equal(f.requests.filter(r=>r.route.endsWith('/generate')).length,generated);f.panel.dispose();assert.ok(f.revoked.length>0);
});
test('long copy is rejected before saving or rendering, and unsaved edits survive polls',async()=>{
 const f=await fixture();await f.enable();f.change('points','長'.repeat(61));await f.panel.refresh();assert.equal(f.el('points').value,'長'.repeat(61));
 await f.click('render');assert.equal(f.requests.filter(r=>r.route.endsWith('/draft')).length,0);assert.match(f.el('message').textContent,/60/);f.panel.dispose();
});
test('a late refresh after disconnect cannot restore the draft or the secret input',async()=>{
 const f=await fixture();await f.enable();let resolve;
 f.client.fetch=async()=>new Promise(r=>resolve=r);const pending=f.panel.refresh();await tick();
 const disconnected=f.panel.update({connected:false,capabilities:{}});f.el('key').value='temporary';f.panel.dispose();resolve(Response.json(saved));await pending;await disconnected;
 assert.equal(f.el('key').value,'');assert.equal(f.el('original').hasAttribute('src'),false);
});
test('old backend and missing credentials cannot dispatch paid generation',async()=>{
 const old=await fixture({capabilities:{providers:['doubao','aliyun']}});await old.enable();await old.click('generate');
 assert.equal(old.requests.length,0);assert.equal(old.el('generate').disabled,true);assert.match(old.el('status').textContent,/升级/);old.panel.dispose();
 const missing=await fixture({configured:false});await missing.enable();await missing.click('generate');
 assert.equal(missing.requests.filter(r=>r.route.endsWith('/generate')).length,0);assert.equal(missing.el('generate').disabled,true);missing.panel.dispose();
});
test('oversized upload and blank product name are rejected before uploads or paid calls',async()=>{
 const f=await fixture({job:{id:null,status:'idle'}});await f.enable();const image=new Blob(['image'],{type:'image/png'});f.files(image);await f.click('generate');
 assert.match(f.el('message').textContent,/商品名称/);f.change('name','商品');
 Object.defineProperty(image,'size',{value:10*1024*1024+1});await f.click('generate');assert.match(f.el('message').textContent,/10 MiB/);
 assert.equal(f.requests.filter(r=>r.route==='selling-points/jobs'||r.route.endsWith('/generate')).length,0);f.panel.dispose();
});
test('explicit repeated generation confirms each paid call without switching providers',async()=>{
 const f=await fixture();await f.enable();await f.click('generate');await f.click('generate');
 const calls=f.requests.filter(r=>r.route.endsWith('/generate'));assert.equal(calls.length,2);assert.ok(calls.every(r=>JSON.parse(r.body).paid_confirmed===true));
 assert.equal(f.requests.some(r=>r.route==='jobs'),false);f.panel.dispose();
});
test('configuration save clears the password and dispose revokes authenticated previews',async()=>{
 const f=await fixture();await f.enable();f.el('key').value='fixture-not-real-key';f.el('workspace').value='space123';await f.click('save');
 const write=f.requests.find(r=>r.route==='settings/bailian'&&r.method==='POST');assert.equal(JSON.parse(write.body).api_key,'fixture-not-real-key');assert.equal(f.el('key').value,'');
 f.panel.dispose();assert.ok(f.revoked.length>0);assert.equal(f.el('original').hasAttribute('src'),false);
});
