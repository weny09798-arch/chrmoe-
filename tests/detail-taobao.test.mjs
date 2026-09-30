import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {normalizeDetail} from '../extension/lib/detail.mjs';
import {taskSheets} from '../extension/lib/xlsx.mjs';
import {createTask,addCandidate} from '../extension/lib/core.mjs';

const payload={item:{itemId:'123',title:'纯棉相机收纳包',images:['//img.alicdn.com/main.jpg'],categoryName:'收纳包',description:'纯棉面料'},
  skuBase:{props:[{pid:'1',name:'颜色',values:[{vid:'10',name:'红色',image:'//img.alicdn.com/red.jpg'},{vid:'20',name:'蓝色',image:'//img.alicdn.com/blue.jpg'}]},{pid:'2',name:'尺寸',values:[{vid:'30',name:'S'},{vid:'40',name:'M'}]}],skus:[{skuId:'s1',propPath:'1:10;2:30'},{skuId:'s2',propPath:'1:20;2:40'}]},
  skuCore:{sku2info:{'0':{price:{priceText:'12.80-15.60'},quantity:100},s1:{price:{priceText:'12.80'},quantity:8,weightKg:'0.2',sizeCm:'12*8*4'},s2:{price:{priceText:'15.60'},quantity:5}}},
  props:{groupProps:[{'基本信息':[{'材质':'棉'},{'产地':'浙江'}]}]},
  detail:{descUrl:'https://desc.alicdn.com/i3/123.html',images:['//img.alicdn.com/long.jpg']},video:{url:'https://cloud.video.taobao.com/a.mp4'}};

async function snapshot(html='',pageGoods=null,href='https://item.taobao.com/item.htm?id=123'){
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`); let handler;
  window.Element.prototype.getBoundingClientRect=()=>({width:300,height:300});
  const context=vm.createContext({window,document,location:new URL(href),URL,console,
    getComputedStyle: node=>({display:node.hidden?'none':'block',visibility:'visible'}),
    chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}}}});
  vm.runInContext(await readFile(new URL('../extension/detail-taobao.js',import.meta.url),'utf8'),context);
  return new Promise(resolve=>handler({type:'PDD_DETAIL_SNAPSHOT',pageGoods},{},resolve));
}

test('matching bootstrap maps each SKU ID to its real price, stock and named specifications',async()=>{
  const data={data:payload,recommendations:{item:{itemId:'999',title:'推荐相机'},skuCore:{sku2info:{x:{price:{priceText:'1'}}}}}};
  const result=await snapshot(`<script>window.__INIT_DATA__ = ${JSON.stringify(data)};</script>`);
  assert.equal(result.goodsId,'123'); assert.equal(result.ready,true);
  assert.equal(result.detail.title,'纯棉相机收纳包');
  assert.deepEqual(Array.from(result.detail.skus,s=>[s.id,...s.specs,s.price,s.stock,s.image]),[
    ['s1','红色','S','12.80','8','https://img.alicdn.com/red.jpg'],['s2','蓝色','M','15.60','5','https://img.alicdn.com/blue.jpg']]);
  assert.deepEqual(Array.from(result.detail.attributes,a=>[a.name,a.value]),[['材质','棉'],['产地','浙江']]);
  assert.deepEqual(Array.from(result.detail.detailImages),['https://img.alicdn.com/long.jpg']);
  assert.equal(result.detail.category,'收纳包'); assert.equal(result.detail.videoUrl,'https://cloud.video.taobao.com/a.mp4');
  assert.equal(result.detail.skus[0].weightKg,'0.2');
  const item={id:'123',site:'taobao',platform:'淘宝',title:'相机包',image:'https://img.alicdn.com/search.jpg',url:'https://item.taobao.com/item.htm?id=123',cents:1280,fingerprint:{bits:'0',color:[100,100,100],spread:30},...normalizeDetail(result.detail)};
  const task=createTask(['相机']); addCandidate(task.jobs[0],item);
  const rows=taskSheets(task)[0].rows.slice(9);
  assert.equal(rows.length,2); assert.equal(rows[0][5],'淘宝');
  assert.equal(rows[0][0],'TB123');
  assert.deepEqual(rows.map(r=>[r[14],r[15],r[16],r[17]]),[['红色','S','s1','12.80'],['蓝色','M','s2','15.60']]);
});

test('apiStack contains current SKU prices without mixing another item initialization',async()=>{
  const base=structuredClone(payload); delete base.skuCore;
  base.apiStack=[{value:JSON.stringify({data:{skuCore:payload.skuCore}})}];
  const result=await snapshot('',{roots:[base,{item:{itemId:'999',title:'别的相机'},skuCore:payload.skuCore}]});
  assert.equal(result.detail.skus.length,2); assert.equal(result.detail.skus[1].price,'15.60');
});

test('unmatched product data never supplies SKU rows or title',async()=>{
  const other=structuredClone(payload); other.item.itemId='999';
  const result=await snapshot('<h1>当前相机包</h1>',{roots:[other]});
  assert.equal(result.detail.title,'当前相机包'); assert.equal(result.detail.skus.length,0);
  assert.equal(result.detail.detailStatus,'partial'); assert.equal(result.skuPending,true);
});

test('DOM sections collect lazy description images and parameters but leave unavailable SKUs partial',async()=>{
  const result=await snapshot(`<h1>相机收纳包</h1><div class="ItemGallery"><img src="//img.alicdn.com/main.jpg_60x60.jpg"></div>
    <section class="Attributes"><span>材质：棉</span><span>产地：浙江</span></section>
    <section class="ItemDetail"><img data-src="//img.alicdn.com/long.jpg" src="data:image/gif;base64,a"><p>柔软棉布</p></section>
    <section class="Recommend"><img src="//img.alicdn.com/other.jpg"></section>`);
  assert.deepEqual(Array.from(result.detail.galleryImages),['https://img.alicdn.com/main.jpg']);
  assert.deepEqual(Array.from(result.detail.detailImages),['https://img.alicdn.com/long.jpg']);
  assert.deepEqual(Array.from(result.detail.attributes,a=>[a.name,a.value]),[['材质','棉'],['产地','浙江']]);
  assert.match(result.detail.descriptionText,/柔软棉布/); assert.equal(result.detail.detailStatus,'partial');
});

test('verification blocks even when initialization data is present',async()=>{
  const result=await snapshot('<div>请完成安全验证</div>',{roots:[payload]});
  assert.equal(result.blocked,true); assert.equal(result.detail,null);
});

test('visible explicit SKU rows provide separate fields without sampling another option or cart',async()=>{
  const result=await snapshot(`<h1>相机包</h1><div class="sku-row" data-sku-id="a"><span data-spec-value>红色</span><span data-spec-value>S</span><span>¥12.50</span><span>库存8件</span><img src="//img.alicdn.com/red.jpg"></div>
    <div class="sku-row" hidden data-sku-id="other"><span data-spec-value>不可见</span><span>¥1.00</span></div>`);
  assert.equal(result.detail.skus.length,1); assert.equal(result.detail.skus[0].id,'a');
  assert.deepEqual(Array.from(result.detail.skus[0].specs),['红色','S']);
  assert.equal(result.detail.skus[0].price,'12.50'); assert.equal(result.detail.skus[0].stock,'8');
  assert.equal(result.detail.detailStatus,'partial');
});

test('visible item login overlay preserves blocked status',async()=>{
  const result=await snapshot('<div role="dialog"><span>扫码登录</span></div>',{roots:[payload]});
  assert.equal(result.blocked,true);
});

test('declared single-SKU product retains an explicit base price without inventing options',async()=>{
  const data={item:{itemId:'123',title:'相机包',images:['//img.alicdn.com/main.jpg']},skuBase:{props:[],skus:[]},skuCore:{sku2info:{'0':{price:{priceText:'8.50'},quantity:0}}}};
  const result=await snapshot('',{roots:[data]});
  assert.equal(result.skuPending,false); assert.equal(result.detail.detailStatus,'done');
  assert.equal(result.detail.price,'8.50'); assert.equal(result.detail.skus[0].stock,'0');
  assert.equal(result.detail.skus[0].specs.length,0);
});

test('SKU values follow property dimensions even when propPath order is reversed',async()=>{
  const data=structuredClone(payload);data.skuBase.skus[0].propPath='2:30;1:10';
  const result=await snapshot('',{roots:[data]});
  assert.deepEqual(Array.from(result.detail.skus[0].specs),['红色','S']);
});

test('thousands separators in a declared SKU price still produce the correct yuan value',async()=>{
  const data=structuredClone(payload);data.skuCore.sku2info.s1.price.priceText='1,299.00';
  assert.equal((await snapshot('',{roots:[data]})).detail.skus[0].price,'1299.00');
});

test('missing SKU dimension and incomplete single-SKU schema remain partial',async()=>{
  const data=structuredClone(payload);data.skuBase.skus[0].propPath='1:10';
  const result=await snapshot('',{roots:[data]});
  assert.equal(result.skuPending,true);assert.equal(result.detail.detailStatus,'partial');
  assert.equal(result.detail.skus.length,1);
  const shell=await snapshot('',{roots:[{item:payload.item,skuBase:{},skuCore:{sku2info:{'0':{price:{priceText:'8.50'},quantity:3}}}}]});
  assert.equal(shell.skuPending,true);assert.equal(shell.detail.detailStatus,'partial');
});

test('recommendation galleries, parameter blocks and SKU rows never enter DOM product fields',async()=>{
  const result=await snapshot(`<h1>相机包</h1><div class="ItemGallery"><img src="//img.alicdn.com/main.jpg"></div>
    <section class="Recommendations"><div class="ItemGallery"><img src="//img.alicdn.com/other.jpg"></div>
    <div class="sku-row" data-sku-id="other"><span data-spec-value>别的商品</span><span>¥1.00</span><span>库存999件</span></div>
    <div class="Attributes"><span>材质：塑料</span></div></section>`);
  assert.deepEqual(Array.from(result.detail.galleryImages),['https://img.alicdn.com/main.jpg']);
  assert.equal(result.detail.skus.length,0);assert.equal(result.detail.attributes.length,0);
});

test('nested recommendation attributes inside the current parameter container are excluded',async()=>{
  const result=await snapshot(`<h1>相机包</h1><section class="Attributes"><span>材质：棉</span><section class="Recommendations"><span>产地：错误推荐产地</span></section><section data-item-id="999"><span>重量：推荐商品重量</span></section></section>`);
  assert.deepEqual(Array.from(result.detail.attributes,a=>[a.name,a.value]),[['材质','棉']]);
});
