import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {BridgeClient} from '../extension/lib/image-conversion.mjs';
import {createSellingPointPanel} from '../extension/selling-point-ui.mjs';

const html=await readFile('extension/manager.html','utf8');
const originalRoute='selling-points/uploaded-job/images/original';

async function fixture(status='uploaded') {
 const {document,window}=parseHTML(html);
 const job={id:'uploaded-job',status,phase:status,source_filename:'cup.png',product_name:'Cup',facts:'250 ml',headline:status==='draft'?'Cup':'',points:status==='draft'?['250 ml']:[],draft_revision:status==='draft'?1:0,result_revision:null,result_available:false,paid_calls:status==='draft'?1:0,public_url:''};
 const requests=[],revoked=[];let attempts=0;
 const client=new BridgeClient({extensionId:'a'.repeat(32),storage:null,fetch:async(url,options)=>{
  const route=url.split('/api/bridge/')[1];requests.push({route,options});
  if(route==='settings/bailian')return Response.json({bailian_configured:true,workspace_id:'space123'});
  if(route==='selling-points/current')return Response.json(job);
  if(route===originalRoute){attempts++;return attempts===1?new Response('private backend URL: http://secret.invalid', {status:503}):new Response(new Blob(['original image bytes'],{type:'image/png'}));}
  throw new Error(`Unexpected route: ${route}`);
 }});
 client.remember({baseUrl:'http://127.0.0.1:51000',token:'fixture-token'});
 const panel=createSellingPointPanel({document,client,setTimer:()=>1,clearTimer:()=>{},urlAPI:{createObjectURL:()=>`blob:preview-${attempts}`,revokeObjectURL:url=>revoked.push(url)}});
 const el=id=>document.getElementById(`selling-${id}`);
 await panel.update({connected:true,capabilities:{selling_point_images:true,bailian_configured:true}});
 el('enable').checked=true;el('enable').dispatchEvent(new window.Event('change'));await panel.settled();
 return {document,window,panel,requests,revoked,el};
}

function assertSafePreview(f){
 const imageCalls=f.requests.filter(r=>r.route===originalRoute);
 assert.equal(imageCalls.length,2);
 for(const {options} of imageCalls){assert.equal(options.headers['X-Tool-Token'],'fixture-token');assert.equal(options.headers['X-Extension-Id'],'a'.repeat(32));}
 assert.equal(f.el('original').getAttribute('src'),'blob:preview-2');
 assert.equal(f.el('result').hasAttribute('src'),false);
 assert.equal(f.el('download').disabled,true);
 assert.equal(f.requests.some(r=>r.route.endsWith('/generate')||r.route.endsWith('/render')||r.route==='selling-points/jobs'),false);
 assert.doesNotMatch(f.el('panel').textContent,/secret\.invalid|private backend URL|fixture-token/);
 f.panel.dispose();assert.deepEqual(f.revoked,['blob:preview-2']);
}

test('a failed uploaded original preview retries on refresh before a result exists',async()=>{
 const f=await fixture();
 assert.equal(f.el('original').hasAttribute('src'),false);
 await f.panel.refresh();
 assertSafePreview(f);
});

test('a draft without a result can manually retry its failed original preview',async()=>{
 const f=await fixture('draft');
 assert.equal(f.el('original').hasAttribute('src'),false);
 assert.equal(f.el('preview').disabled,false);
 f.el('preview').dispatchEvent(new f.window.Event('click'));await f.panel.settled();
 assertSafePreview(f);
});

async function retryFixture({status='paused',result_available=true}={}){
 const {document,window}=parseHTML(html);
 const id='a'.repeat(32);
 const job={id,status,phase:'interrupted',source_filename:'cup.png',product_name:'Cup',facts:'250 ml',headline:'Cup',points:['250 ml'],draft_revision:1,result_revision:1,result_available,paid_calls:1,public_url:'',message:'上次操作被中斷，本機草稿及可用圖片已保留。',error_code:'interrupted',request_id:'',usage:{}};
 const requests=[];
 const client=new BridgeClient({extensionId:'b'.repeat(32),storage:null,fetch:async(url,options)=>{
  const route=url.split('/api/bridge/')[1];requests.push({route,options});
  if(route==='settings/bailian')return Response.json({bailian_configured:true,workspace_id:'space123'});
  if(route==='selling-points/current')return Response.json(job);
  if(route===`selling-points/${id}/images/original`||route===`selling-points/${id}/images/result`)return new Response(new Blob(['cached image'],{type:'image/png'}));
  if(route===`selling-points/${id}/retry-upload`)return Response.json({...job,status:'uploading',phase:'uploading'});
  throw new Error(`Unexpected route: ${route}`);
 }});
 client.remember({baseUrl:'http://127.0.0.1:51000',token:'fixture-token'});
 let serial=0;
 const panel=createSellingPointPanel({document,client,setTimer:()=>1,clearTimer:()=>{},urlAPI:{createObjectURL:()=>`blob:cached-${++serial}`,revokeObjectURL:()=>{}}});
 const el=name=>document.getElementById(`selling-${name}`);
 await panel.update({connected:true,capabilities:{selling_point_images:true,bailian_configured:true}});
 el('enable').checked=true;el('enable').dispatchEvent(new window.Event('change'));await panel.settled();
 return {window,panel,el,requests,id};
}

test('restored interrupted upload retries cached PNG only when current and inactive',async()=>{
 const cached=await retryFixture();
 assert.equal(cached.el('download').disabled,false);
 assert.equal(cached.el('result').getAttribute('src'),'blob:cached-2');
 assert.equal(cached.el('retry').disabled,false);
 cached.el('retry').dispatchEvent(new cached.window.Event('click'));await cached.panel.settled();
 const actions=cached.requests.filter(({route})=>route.endsWith('/retry-upload')||route.endsWith('/generate')||route.endsWith('/render'));
 assert.deepEqual(actions.map(({route})=>route),[`selling-points/${cached.id}/retry-upload`]);
 assert.equal(actions[0].options.headers['X-Tool-Token'],'fixture-token');
 assert.equal(actions[0].options.body,'{}');
 assert.equal(cached.el('retry').disabled,true);
 cached.panel.dispose();

 const missing=await retryFixture({result_available:false});
 assert.equal(missing.el('retry').disabled,true);
 assert.equal(missing.el('download').disabled,true);
 missing.el('retry').dispatchEvent(new missing.window.Event('click'));await missing.panel.settled();
 assert.equal(missing.requests.some(({route})=>route.endsWith('/retry-upload')),false);
 missing.panel.dispose();

 const active=await retryFixture({status:'uploading'});
 assert.equal(active.el('retry').disabled,true);
 active.el('retry').dispatchEvent(new active.window.Event('click'));await active.panel.settled();
 assert.equal(active.requests.some(({route})=>route.endsWith('/retry-upload')),false);
 active.panel.dispose();
});
