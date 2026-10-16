import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {BridgeClient} from '../extension/lib/image-conversion.mjs';
import {createSellingPointPanel} from '../extension/selling-point-ui.mjs';
async function fixture(confirm=true) {
 const {document,Event}=parseHTML(await readFile('extension/manager.html','utf8'));
 const calls=[]; let current={id:null,status:'idle'};
 const client=new BridgeClient({extensionId:'test',storage:null,fetch:async(url,options)=>{const route=url.split('/api/bridge/')[1];calls.push({route,...options}); if(route==='settings/bailian')return Response.json({bailian_configured:true,workspace_id:'ws'});if(route.endsWith('/jobs'))current={id:'one',status:'uploaded',draft_revision:0};if(route.endsWith('/generate'))current={...current,status:'draft',headline:'標題',points:['賣點'],draft_revision:1};if(route.endsWith('/draft'))current={...current,...JSON.parse(options.body),draft_revision:2};if(route.endsWith('/render'))current={...current,status:'paused',result_available:true,result_revision:2,phase:'upload-failed'};if(route.includes('/images/'))return new Response(new Blob(['image'],{type:'image/png'}));return Response.json(current);}});client.remember({baseUrl:'http://127.0.0.1:12',token:'secret'});
 const panel=createSellingPointPanel({document,client,confirm:()=>confirm,setTimer:()=>1,clearTimer:()=>{}}); await panel.update({connected:true,capabilities:{selling_point_images:true,bailian_configured:true}});
 const el=id=>document.getElementById('selling-'+id);const click=async id=>{el(id).dispatchEvent(new Event('click'));await panel.settled();};
 return {document,Event,el,click,calls,panel};
}
test('default hidden, capability gate and explicit enable',async()=>{const f=await fixture();assert.equal(f.el('enable').checked,undefined);assert.equal(f.el('fields').hidden,true);f.el('enable').checked=true;f.el('enable').dispatchEvent(new f.Event('change'));await f.panel.settled();assert.equal(f.el('fields').hidden,false);await f.panel.update({connected:true,capabilities:{}});assert.match(f.el('status').textContent,/升级/);f.panel.dispose();});
test('separate settings page loads config before selling is enabled and shows validation feedback there',async()=>{
 const f=await fixture();assert.equal(f.el('workspace').value,'ws');
 assert.equal(f.calls.some(c=>c.route==='selling-points/current'),false);
 f.el('key').value='bad key';await f.click('save');
 assert.match(f.el('settings-message').textContent,/有效.*API Key/);
 assert.equal(f.el('settings-message').hidden,false);
 assert.equal(f.el('message').hidden,true,'configuration errors belong to service settings');
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);f.panel.dispose();
});
test('task input failures do not appear as service configuration errors',async()=>{
 const f=await fixture();f.el('enable').checked=true;f.el('enable').dispatchEvent(new f.Event('change'));await f.panel.settled();
 await f.click('generate');assert.match(f.el('message').textContent,/请选择.*图片/);
 assert.equal(f.el('settings-message').hidden,true);f.panel.dispose();
});
test('multipart bytes and cancelled paid action; render saves revision without generate',async()=>{const f=await fixture(false);f.el('enable').checked=true;f.el('enable').dispatchEvent(new f.Event('change'));await f.panel.settled();Object.defineProperty(f.el('image'),'files',{value:[new Blob(['actual'],{type:'image/png'})]});f.el('name').value='商品';await f.click('generate');const upload=f.calls.find(c=>c.route.endsWith('/jobs'));assert.ok(upload.body instanceof FormData);assert.equal(await upload.body.get('image').text(),'actual');assert.equal(upload.headers['Content-Type'],undefined);assert.equal(f.calls.filter(c=>c.route.endsWith('/generate')).length,0);f.panel.dispose();});
test('confirmed draft editable, dirty polls survive, manual render and cached download',async()=>{const f=await fixture();f.el('enable').checked=true;f.el('enable').dispatchEvent(new f.Event('change'));await f.panel.settled();Object.defineProperty(f.el('image'),'files',{value:[new Blob(['actual'],{type:'image/png'})]});f.el('name').value='商品';await f.click('generate');assert.equal(f.el('headline').value,'標題');f.el('headline').value='修改';f.el('headline').dispatchEvent(new f.Event('input'));await f.panel.refresh();assert.equal(f.el('headline').value,'修改');await f.click('render');assert.deepEqual(f.calls.filter(c=>c.route.endsWith('/draft')).map(c=>JSON.parse(c.body).headline),['修改']);assert.equal(f.el('download').disabled,false);await f.click('retry');assert.equal(f.calls.filter(c=>c.route.endsWith('/generate')).length,1);assert.equal(f.calls.filter(c=>c.route.endsWith('/render')).length,1);f.panel.dispose();});
