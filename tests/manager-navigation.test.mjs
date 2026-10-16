import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

const html = await readFile(new URL('../extension/manager.html', import.meta.url), 'utf8');
async function fixture(initial, broken = false) {
  const {document,window} = parseHTML(html);
  assert.ok(document.querySelector('#nav-collection'), 'left navigation must exist');
  const values = new Map(initial ? [['collector-manager-view', initial]] : []);
  const storage = {getItem(key) {if(broken)throw Error('blocked');return values.get(key);},setItem(key,value){if(broken)throw Error('quota');values.set(key,value);}};
  const {createManagerNavigation} = await import('../extension/manager-navigation.mjs');
  const nav = createManagerNavigation({document,storage});
  const click = selector => document.querySelector(selector).dispatchEvent(new window.Event('click',{bubbles:true}));
  return {document,window,nav,values,click};
}
function visible(document) {return [...document.querySelectorAll('[data-workspace-view]')].filter(el=>!el.hidden).map(el=>el.dataset.workspaceView);}

test('collection is the default and every business control has a single permanent home',async()=>{
  const {document}=await fixture();
  assert.deepEqual(visible(document),['collection']);
  const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);
  assert.equal(new Set(ids).size,ids.length,'moving configuration must not duplicate IDs');
  for(const [id,view] of [['keyword-input','collection'],['conversion-start','conversion'],['selling-generate','selling'],['settings-oss-bucket','settings'],['selling-key','settings'],['conversion-connect','settings']])
    assert.equal(document.getElementById(id).closest('[data-workspace-view]').dataset.workspaceView,view,id);
  assert.equal(document.getElementById('export').closest('[data-workspace-view]'),null,'one common export remains available in all views');
});
test('navigation retains inputs, result nodes and running status without unload or pagehide',async()=>{
  const f=await fixture();const input=f.document.getElementById('keyword-input'),row=f.document.createElement('div');input.value='相机';
  const progress=f.document.getElementById('conversion-status');progress.textContent='转换中';
  f.document.getElementById('conversion-items').append(row);let unloads=0;
  for(const type of ['pagehide','beforeunload'])f.window.addEventListener(type,()=>unloads++);
  for(const view of ['conversion','selling','settings','collection']){
    f.click('#nav-'+view);assert.deepEqual(visible(f.document),[view]);
    assert.equal(f.document.getElementById('nav-'+view).getAttribute('aria-current'),'page');
  }
  assert.equal(input.value,'相机');assert.equal(f.document.getElementById('conversion-items').firstElementChild,row);
  assert.equal(progress.textContent,'转换中');assert.equal(unloads,0);assert.equal(f.values.get('collector-manager-view'),'collection');
});
test('saved view restores while invalid values and unavailable storage fall back safely',async()=>{
  assert.deepEqual(visible((await fixture('conversion')).document),['conversion']);
  assert.deepEqual(visible((await fixture('<script>')).document),['collection']);
  const f=await fixture(null,true);f.click('#nav-settings');assert.deepEqual(visible(f.document),['settings']);
});
test('menu can collapse, settings shortcuts expand their destination and narrow navigation closes on selection',async()=>{
  const f=await fixture();f.click('#navigation-group-toggle');
  assert.equal(f.document.getElementById('navigation-group').hidden,true);
  assert.equal(f.document.getElementById('navigation-group-toggle').getAttribute('aria-expanded'),'false');
  f.click('#navigation-group-toggle');f.click('#sidebar-toggle');
  assert.equal(f.document.querySelector('.app').classList.contains('navigation-open'),true);
  f.click('[data-settings-target="settings-oss-form"]');assert.deepEqual(visible(f.document),['settings']);
  assert.equal(f.document.getElementById('conversion-settings').open,true);
  assert.equal(f.document.querySelector('.app').classList.contains('navigation-open'),false);
  assert.equal(f.document.getElementById('sidebar-toggle').getAttribute('aria-expanded'),'false');
});
test('mobile menu focuses navigation, makes covered workspace inert and restores focus on Escape',async()=>{
  const f=await fixture();let focused='';
  for(const el of f.document.querySelectorAll('#app-sidebar button, #sidebar-toggle'))el.focus=()=>{focused=el.id;};
  f.click('#sidebar-toggle');assert.equal(focused,'nav-collection');
  assert.equal(f.document.querySelector('.app-content').inert,true);
  const escape=new f.window.Event('keydown',{bubbles:true});Object.defineProperty(escape,'key',{value:'Escape'});f.document.dispatchEvent(escape);
  assert.equal(focused,'sidebar-toggle');assert.equal(f.document.querySelector('.app-content').inert,false);
  f.click('#navigation-group-toggle');f.click('#sidebar-toggle');assert.equal(focused,'navigation-group-toggle');
  f.click('#navigation-backdrop');assert.equal(focused,'sidebar-toggle');assert.equal(f.document.querySelector('.app-content').inert,false);
});
