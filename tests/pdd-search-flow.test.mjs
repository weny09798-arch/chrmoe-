import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { browserPorts, searchUrl } from '../extension/lib/browser.mjs';
import { createTask, parsePrice } from '../extension/lib/core.mjs';

async function fixture(extra = '') {
  const url = searchUrl('相机');
  const { window, document } = parseHTML(`<html><body><div role="button"><img src="https://img.pddpic.com/a.jpg"><div>数码相机</div><div>¥32</div></div>${extra}</body></html>`);
  window.Element.prototype.getBoundingClientRect = () => ({width:250,height:350,top:10,bottom:360});
  document.documentElement.scrollTop = 720;
  let handler, clicks = 0;
  window.Element.prototype.click = () => clicks++;
  const context = vm.createContext({window,document,URL,location:{href:url,pathname:'/search_result.html'},getComputedStyle:()=>({display:'block',visibility:'visible',overflowY:'visible'}),chrome:{runtime:{onMessage:{addListener:fn=>handler=fn}}}});
  vm.runInContext(await readFile(new URL('../extension/content.js',import.meta.url),'utf8'),context);
  const pageContext = vm.createContext({URL,location:{href:url},rawData:{store:{goodsList:[{goodsID:'123',goodsName:'数码相机',thumbUrl:'https://img.pddpic.com/a.jpg'}]}}});
  const calls = [];
  const chrome = {
    tabs:{get:async()=>({id:42,url,status:'complete'}),update:async()=>{throw new Error('Search navigation forbidden');},sendMessage:async(_id,message)=>{
      calls.push(message.type);return new Promise(resolve=>handler(message,{},resolve));
    }},
    scripting:{executeScript:async options=>{
      if(options.world==='MAIN'){calls.push('MAIN');return [{result:vm.runInContext(`(${options.func.toString()})()`,pageContext)}];}
    }}
  };
  return {chrome,calls,document,clicks:()=>clicks};
}

test('browser reads already-loaded search data and content resolves a unique card without navigation',async()=>{
  const prior = globalThis.chrome, page = await fixture(), task = createTask(['相机']);task.tabId=42;
  globalThis.chrome=page.chrome;
  try {
    const ports=browserPorts({save:async()=>{},update(){}});await ports.open(task.jobs[0],task);
    const result=await ports.read(task.jobs[0]);
    assert.equal(result.cards[0].id,'123');assert.equal(parsePrice(result.cards[0].priceText),3200);
    assert.equal(result.position,720);assert.equal(page.document.documentElement.scrollTop,720);assert.equal(page.clicks(),0);
    assert.deepEqual(page.calls,['PDD_SNAPSHOT','MAIN','PDD_SNAPSHOT']);
    await ports.open(task.jobs[0],task);
    assert.equal(page.document.documentElement.scrollTop,720);
    const refused=await page.chrome.tabs.sendMessage(42,{type:'PDD_OPEN_CARD',key:'123'});
    assert.match(refused.error,/不再/);assert.equal(page.clicks(),0);
  } finally {globalThis.chrome=prior;}
});

test('verification detected in the first snapshot prevents additional page-data reads',async()=>{
  const prior=globalThis.chrome,page=await fixture('<p>访问过于频繁</p>'),task=createTask(['相机']);task.tabId=42;
  globalThis.chrome=page.chrome;
  try {
    const ports=browserPorts({save:async()=>{},update(){}});await ports.open(task.jobs[0],task);
    const result=await ports.read(task.jobs[0]);
    assert.equal(result.blocked,true);assert.deepEqual(page.calls,['PDD_SNAPSHOT']);assert.equal(page.clicks(),0);
  } finally {globalThis.chrome=prior;}
});
