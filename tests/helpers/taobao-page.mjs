import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

export async function taobaoPage(html, href='https://s.taobao.com/search?q=相机', options={}) {
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`);
  document.documentElement.scrollTop=options.scrollTop||0;
  Object.defineProperties(document.documentElement,{clientHeight:{value:600,writable:true},scrollHeight:{value:options.scrollHeight||600,writable:true}});
  let handler,now=0; const location=new URL(href);
  const context=vm.createContext({window,document,location,URL,TextDecoder,Uint8Array,console,setTimeout,
    Date:class extends Date {static now(){return now;}},
    getComputedStyle: node=>({display:node.hidden?'none':'block',visibility:'visible',overflowY:'visible'}),
    chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}}}});
  vm.runInContext(await readFile(new URL('../../extension/content-taobao.js',import.meta.url),'utf8'),context);
  return {document,location,advance:ms=>{now+=ms;},send:message=>new Promise(resolve=>handler(message,{},resolve))};
}

export const taobaoCard=(id,title='高清数码相机',host='item.taobao.com')=>`<a href="https://${host}/item.htm?id=${id}"><img src="//img.alicdn.com/item-${id}.jpg"><div class="Title--title--x">${title}</div><div class="Price--priceText--x"><span>¥</span><span>12</span><span>.80</span></div><span>2000+人付款</span><span>退货包运费</span></a>`;
