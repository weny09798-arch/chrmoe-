import test from 'node:test';
import assert from 'node:assert/strict';
import {Runner} from '../extension/lib/runner.mjs';
import {enqueueKeyword,selected} from '../extension/lib/core.mjs';
import {removeProduct,prepareRefill} from '../extension/lib/products.mjs';
import {taskSheets} from '../extension/lib/xlsx.mjs';

test('Taobao collection retains Tmall source and shares the limit, exclusions and template export',async()=>{
  const task=enqueueKeyword(null,'相机','taobao',{limit:2,priceMin:500,priceMax:1500});const job=task.jobs[0];let reads=0;
  const card=(id,host='item.taobao.com')=>({id,key:id,title:'相机包',priceText:'¥8.50',image:`https://img.alicdn.com/${id}.jpg`,url:`https://${host}/item.htm?id=${id}`});
  const ports={save:async()=>{},update(){},open:async()=>{},close:async()=>{},scroll:async()=>{},wait:async()=>{},
    read:async()=>{reads++;return{cards:[card('1'),card('2','detail.tmall.com'),card('3')],end:true};},
    hash:async url=>({bits:'0000000000000000',color:[Number(url.match(/(\d+)\.jpg/)[1])*100,100,100],spread:50}),
    enrich:async item=>({descriptionText:'详情',detailStatus:'done',skus:[{id:'sku'+item.id,specs:['红'],cents:850,image:item.image,stock:'2'}]})};
  await new Runner(task,ports).run();assert.equal(reads,1);
  assert.deepEqual(selected(job).map(x=>x.platform),['淘宝','天猫']);
  assert.deepEqual(taskSheets(task)[0].rows.slice(9).map(r=>r[0]),['TB1','TM2']);
  removeProduct(job,'1');prepareRefill(job);await new Runner(task,ports).run();
  assert.deepEqual(selected(job).map(x=>x.id),['2','3']);
  assert.equal(selected(job)[0].descriptionText,'详情');
});
