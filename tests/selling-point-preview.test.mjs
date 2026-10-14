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
