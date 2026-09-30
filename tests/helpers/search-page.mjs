import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

export async function searchPage(site,html) {
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getBoundingClientRect=()=>({width:250,height:350,top:10,bottom:360});
  let handler;
  const href=site==='pdd'?'https://mobile.pinduoduo.com/search_result.html?search_key=相机':site==='1688'?'https://s.1688.com/selloffer/offer_search.htm?keywords=相机':'https://s.taobao.com/search?q=相机';
  const file=site==='pdd'?'content.js':site==='1688'?'content-1688.js':'content-taobao.js';
  const context=vm.createContext({window,document,URL,TextDecoder,Uint8Array,location:new URL(href),setTimeout,clearTimeout,
    getComputedStyle:node=>({display:'block',visibility:'visible',overflowY:node.id==='results'?'auto':'visible'}),
    chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}}}});
  vm.runInContext(await readFile(new URL(`../../extension/${file}`,import.meta.url),'utf8'),context);
  return {document,read:()=>new Promise(resolve=>handler({type:'PDD_SNAPSHOT'},{},resolve)),send:message=>new Promise(resolve=>handler(message,{},resolve))};
}
