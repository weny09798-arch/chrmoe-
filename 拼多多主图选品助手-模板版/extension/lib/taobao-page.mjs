// Runs in the page's MAIN world. Return only the current product's public fields.
export function readLiveTaobao() {
  const id=new URL(location.href).searchParams.get('id')||'';
  if(!/^\d+$/.test(id))return null;
  const text=v=>v==null?'':typeof v==='object'?'':String(v);
  const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj?.[k]!=null&&typeof obj[k]!=='object').map(k=>[k,obj[k]]));
  const price=v=>v&&typeof v==='object'?pick(v,['priceText','value','price']):v;
  const itemId=r=>text(r?.item?.itemId||r?.item?.id||r?.itemDO?.itemId||r?.itemDO?.auctionId||r?.itemId||r?.itemNumId);
  const roots=[],seen=new Set();let count=0;
  function project(root){
    let data={...root};
    for(const stack of Array.isArray(root.apiStack)?root.apiStack:[]){
      if(typeof stack?.value!=='string'||stack.value.length>5_000_000)continue;
      try{const parsed=JSON.parse(stack.value),part=parsed.data||parsed;if(itemId(part)&&itemId(part)!==id)continue;
        for(const key of ['item','skuBase','skuCore','props','detail','descInfo','video'])if(part[key])data[key]=part[key];
      }catch{/* Ignore incomplete page initialization. */}
    }
    const item=data.item||data.itemDO||data;
    const out={item:{itemId:id,...pick(item,['title','name','description','categoryName','pcDescUrl','h5DescUrl','price'])}};
    const media=values=>(Array.isArray(values)?values:[]).slice(0,60).map(v=>typeof v==='string'?v:pick(v,['url','image','imgUrl']));
    out.item.images=media(item.images||item.pics||data.images);
    if(data.skuBase){out.skuBase={};
      if(Array.isArray(data.skuBase.props))out.skuBase.props=data.skuBase.props.slice(0,10).map(p=>({...pick(p,['pid','name']),values:(Array.isArray(p.values)?p.values:[]).slice(0,500).map(v=>pick(v,['vid','name','image','imageUrl']))}));
      if(Array.isArray(data.skuBase.skus))out.skuBase.skus=data.skuBase.skus.slice(0,1001).map(v=>pick(v,['skuId','propPath','image','weightKg','sizeCm']));
    }
    if(data.skuCore?.sku2info&&typeof data.skuCore.sku2info==='object'){
      out.skuCore={sku2info:Object.fromEntries(Object.entries(data.skuCore.sku2info).slice(0,1002).map(([key,v])=>[key,{...pick(v,['quantity','stock','image','weightKg','sizeCm','priceText']),price:price(v.price),promotionPrice:price(v.promotionPrice)}]))};
    }
    if(data.props?.groupProps)out.props={groupProps:(Array.isArray(data.props.groupProps)?data.props.groupProps:[]).slice(0,30).map(group=>Object.fromEntries(Object.entries(group).filter(([_key,v])=>Array.isArray(v)).map(([key,v])=>[key,v.slice(0,100).map(row=>pick(row,Object.keys(row||{})))])))};
    if(Array.isArray(data.attributes))out.attributes=data.attributes.slice(0,100).map(v=>pick(v,['name','key','value']));
    if(data.detail)out.detail={...pick(data.detail,['descUrl']),images:media(data.detail.images)};
    if(data.descInfo)out.descInfo=pick(data.descInfo,['pcDescUrl','h5DescUrl']);
    out.video=typeof data.video==='object'?pick(data.video,['url','videoUrl','playUrl']):text(data.video);
    Object.assign(out,pick(data,['descUrl','description','categoryName']));
    for(const key of ['detailImages','certificateImages','sizeChartImages'])out[key]=media(data[key]);
    return out;
  }
  function walk(node,depth=0){
    if(!node||typeof node!=='object'||seen.has(node)||depth>16||++count>6000)return;
    seen.add(node);
    if(Array.isArray(node)){node.slice(0,200).forEach(v=>walk(v,depth+1));return;}
    const own=itemId(node);
    if(own){if(own===id&&(node.item||node.itemDO||node.skuBase||node.skuCore||node.title))roots.push(project(node));return;}
    for(const [key,v]of Object.entries(node))if(!/recommend|related|seller|shop|user|account|history/i.test(key))walk(v,depth+1);
  }
  for(const node of [globalThis.__ICE_APP_CONTEXT__,globalThis.__INIT_DATA__,globalThis.__INIT_DATA,globalThis.__GLOBAL_DATA__,globalThis.__NEXT_DATA__,globalThis.g_config,globalThis.Hub?.config])walk(node);
  return roots.length?{roots:roots.slice(0,5)}:null;
}
