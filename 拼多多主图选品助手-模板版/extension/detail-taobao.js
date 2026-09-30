(() => {
  if (globalThis.__taobaoDetailInstalled) return;
  globalThis.__taobaoDetailInstalled=true;
  const value=v=>v==null?'':typeof v==='object'?'':String(v).trim();
  const words=n=>value(n?.innerText||n?.textContent);
  function productNode(n) {
    const id=new URL(location.href).searchParams.get('id');
    for(let el=n;el?.nodeType===1;el=el.parentElement){
      if(/recommend|related|guessYouLike|suggest|review|feedback|comment|猜你喜欢|看了又看|店铺推荐/i.test(el.id+' '+el.className))return false;
      const other=el.getAttribute('data-item-id')||el.getAttribute('data-product-id');
      if(other&&other!==id)return false;
    }return true;
  }
  function present(n) {
    for(let el=n;el?.nodeType===1;el=el.parentElement) {
      const css=getComputedStyle(el);
      if(el.hidden||el.getAttribute('aria-hidden')==='true'||css.display==='none'||css.visibility==='hidden')return false;
    }
    return true;
  }
  function https(input) {
    const raw=value(input); if(!raw)return '';
    try {const url=new URL(raw,location.href);if(url.protocol==='http:'&&/(^|\.)(alicdn|taobao|tmall)\.com$/.test(url.hostname))url.protocol='https:';return url.protocol==='https:'?url.href:'';}catch{return '';}
  }
  function image(input) {
    const raw=https(input);if(!raw)return '';
    const url=new URL(raw);
    if(!/(^|\.)alicdn\.com$/.test(url.hostname)||/tps-|avatar|sprite|logo|1x1/i.test(url.pathname))return '';
    url.pathname=url.pathname.replace(/(\.(?:jpg|jpeg|png|webp))(?:_[^/]*)?$/i,'$1');
    if(/x-oss-process|resize/i.test(url.search))url.search='';
    return url.href;
  }
  function images(values) {
    if(!Array.isArray(values))values=values?[values]:[];
    return [...new Set(values.map(v=>image(typeof v==='object'?v?.url||v?.image||v?.imgUrl:v)).filter(Boolean))].slice(0,60);
  }
  function price(input) {
    if(input&&typeof input==='object')input=input.priceText??input.value??input.price;
    let raw=value(input).replace(/^[¥￥]\s*/, '');
    if(/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw))raw=raw.replace(/,/g,'');
    return /^\d+(?:\.\d{1,2})?$/.test(raw)&&Number(raw)>0?raw:'';
  }
  function idOf(root){return value(root?.item?.itemId||root?.item?.id||root?.itemDO?.itemId||root?.itemDO?.auctionId||root?.itemId||root?.itemNumId);}
  function jsonAt(text,start){
    let depth=0,quoted=false,escape=false;
    for(let i=start;i<text.length;i++){
      const c=text[i];
      if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return text.slice(start,i+1);
    }return '';
  }
  function initialRoots(){
    const values=[];
    for(const script of document.querySelectorAll('script')){
      const text=script.textContent||'';if(text.length>5_000_000)continue;
      if(/json/i.test(script.getAttribute('type')||'')){try{values.push(JSON.parse(text));}catch{/* Ignore invalid JSON. */}}
      for(const match of text.matchAll(/(?:__INIT_DATA__?|__ICE_APP_CONTEXT__|__GLOBAL_DATA__|g_config)\s*=\s*/g)){
        const start=text.indexOf('{',match.index+match[0].length);if(start<0)continue;
        try{values.push(JSON.parse(jsonAt(text,start)));}catch{/* Never evaluate executable page source. */}
      }
    }return values;
  }
  function matchedRoots(inputs,id){
    const found=[],seen=new Set();let visits=0;
    function walk(node,depth=0){
      if(!node||typeof node!=='object'||seen.has(node)||depth>16||++visits>6000)return;
      seen.add(node);
      if(Array.isArray(node)){node.slice(0,200).forEach(v=>walk(v,depth+1));return;}
      const own=idOf(node);
      if(own){if(own===id&&(node.item||node.itemDO||node.skuBase||node.skuCore))found.push(node);return;}
      for(const [key,v]of Object.entries(node))if(!/recommend|related|seller|shop|user|account|history/i.test(key))walk(v,depth+1);
    }
    inputs.forEach(v=>walk(v));return found;
  }
  function mergedRoot(root,id){
    const result={...root};
    for(const stack of Array.isArray(root.apiStack)?root.apiStack:[]){
      if(typeof stack?.value!=='string'||stack.value.length>5_000_000)continue;
      try{
        const parsed=JSON.parse(stack.value);const part=parsed.data||parsed;
        if(idOf(part)&&idOf(part)!==id)continue;
        for(const key of ['item','skuBase','skuCore','props','detail','descInfo','video'])if(part[key])result[key]=part[key];
      }catch{/* The page may still be loading API-stack text. */}
    }return result;
  }
  function documentUrl(input){
    const url=https(input);if(!url)return '';
    const parsed=new URL(url);
    return /(^|\.)(alicdn|taobao|tmall)\.com$/.test(parsed.hostname)&&!/^\/item\.htm$/.test(parsed.pathname)&&! /\.(jpg|jpeg|png|webp)(?:$)/i.test(parsed.pathname)?url:'';
  }
  function attributes(root){
    const found=[];
    function push(name,v){name=value(name);v=Array.isArray(v)?v.map(value).filter(Boolean).join('、'):value(v);if(name&&v&&name!==v)found.push({name,value:v});}
    for(const a of root.attributes||[])push(a.name||a.key,a.value);
    for(const group of root.props?.groupProps||[])for(const list of Object.values(group))if(Array.isArray(list))for(const a of list)for(const [k,v]of Object.entries(a||{}))push(k,v);
    for(const n of document.querySelectorAll('[class*="Attribute"],[class*="attribute"],[class*="Params"],[class*="params"],#J_AttrUL li'))if(present(n)&&productNode(n)){
      const texts=n.children.length?[...n.querySelectorAll('li,p,span,div')].filter(v=>!v.children.length&&present(v)&&productNode(v)).map(words):[words(n)];
      for(const raw of texts){const m=raw.match(/^([^:：]{1,40})[:：]\s*(.{1,300})$/);if(m)push(m[1],m[2]);}
    }
    return [...new Map(found.map(a=>[a.name+'\u001f'+a.value,a])).values()].slice(0,100);
  }
  function skuRows(root){
    const base=root.skuBase,info=root.skuCore?.sku2info;
    const props=Array.isArray(base?.props)?base.props:[],definitions=new Map();
    for(const p of props)for(const v of p.values||[])definitions.set(value(p.pid)+':'+value(v.vid),{name:value(v.name),image:image(v.image||v.imageUrl)});
    const result=[];let complete=Boolean(base&&Array.isArray(base.props)&&Array.isArray(base.skus)&&info&&typeof info==='object');
    const declared=Array.isArray(base?.skus)?base.skus:[];
    for(const row of declared.slice(0,1000)){
      const id=value(row.skuId),data=info?.[id];
      const amount=price(data?.price||data?.promotionPrice||data?.priceText);
      const keys=value(row.propPath).split(';').filter(Boolean);
      const ordered=props.map(p=>keys.filter(k=>k.split(':')[0]===value(p.pid)));
      const options=ordered.map(matches=>matches.length===1?definitions.get(matches[0]):null);
      if(!amount||keys.length!==props.length||options.some(o=>!o?.name)){complete=false;continue;}
      result.push({id,specs:options.map(o=>o.name),price:amount,image:image(row.image||data.image)||options.find(o=>o?.image)?.image||'',stock:value(data.quantity??data.stock),weightKg:value(data.weightKg??row.weightKg),sizeCm:value(data.sizeCm??row.sizeCm)});
    }
    const zero=info?.['0'],single=complete&&!props.length&&!declared.length&&Object.keys(info).every(k=>k==='0');
    if(single&&price(zero?.price))result.push({id:'',specs:[],price:price(zero.price),image:'',stock:value(zero.quantity??zero.stock),weightKg:value(zero.weightKg),sizeCm:value(zero.sizeCm)});
    if(single&&!result.length)complete=false;
    if(props.length&&!declared.length)complete=false;
    if(declared.length>1000)complete=false;
    return {rows:result,complete:complete&&result.length>0,names:props.map(p=>value(p.name)).filter(Boolean)};
  }
  function domImages(selector){
    const result=[];
    for(const section of document.querySelectorAll(selector))if(present(section)&&productNode(section))for(const img of section.querySelectorAll('img'))if(present(img)&&productNode(img)){
      const src=img.currentSrc||img.getAttribute('src');
      const lazy=img.getAttribute('data-src')||img.getAttribute('data-ks-lazyload')||img.getAttribute('data-lazyload')||img.getAttribute('data-lazy-src');
      result.push(lazy||src);
    }return images(result);
  }
  function domSkus(){
    const result=[];
    for(const row of document.querySelectorAll('[data-sku-id],.sku-row,[class*="SkuRow"],[class*="skuRow"]')){
      if(!present(row)||!productNode(row))continue;
      const raw=words(row),amounts=[...raw.matchAll(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/g)].map(m=>m[1]);
      const specs=[...row.querySelectorAll('[data-spec-value],[class*="skuName"],[class*="SkuName"]')].filter(present).map(words).filter(Boolean);
      if(amounts.length!==1||!specs.length)continue;
      const pic=row.querySelector('img');
      result.push({id:value(row.getAttribute('data-sku-id')),specs,price:price(amounts[0]),image:image(pic?.getAttribute('data-src')||pic?.getAttribute('src')),
        stock:raw.match(/库存\s*[:：]?\s*(\d+)/)?.[1]||'',weightKg:'',sizeCm:''});
    }return result.slice(0,1000);
  }
  const gallerySelector='#J_UlThumb,#J_ImgBooth,[class*="ItemGallery"],[class*="PicGallery"],[class*="MainPic"],[class*="mainPic"],[class*="gallery"]';
  const detailSelector='#description,#J_DivItemDesc,[class*="ItemDetail"],[class*="Description"],[class*="description"],[class*="detailContent"]';
  const detailLabel=n=>/^(?:图文详情|宝贝详情|商品详情)$/.test(words(n).replace(/\s+/g,''));
  function descriptionPicture(n){
    const lazy=n.getAttribute('data-src')||n.getAttribute('data-ks-lazyload')||n.getAttribute('data-lazyload')||n.getAttribute('data-lazy-src')||n.getAttribute('data-original');
    const set=n.getAttribute('data-srcset')||n.getAttribute('srcset')||'';
    const choices=set.split(',').map(part=>{const bits=part.trim().split(/\s+/);return {url:image(bits[0]),size:parseFloat(bits[1])||0};}).filter(v=>v.url).sort((a,b)=>b.size-a.size);
    return image(lazy)||choices[0]?.url||image(n.currentSrc)||image(n.getAttribute('src'));
  }
  let detailPasses=0,detailSignature='',detailStable=0,openedDetail=false;
  function descriptionArea(){
    const labels=[...document.querySelectorAll('h1,h2,h3,h4,button,a,span,div,[role="tab"]')].filter(n=>present(n)&&productNode(n)&&detailLabel(n));
    if(!openedDetail){
      const tab=labels.find(n=>n.matches('button,a,[role="tab"]'))||labels.find(n=>!n.children.length);
      if(tab){const clickable=tab.closest('a,button,[role="tab"]')||tab;const href=clickable.getAttribute('href')||'';
        if(!href||href.startsWith('#')){openedDetail=true;try{clickable.click();}catch{/* Static pages have nothing to open. */}}
      }
    }
    const headings=[...document.querySelectorAll('h1,h2,h3,h4,div,span')].filter(n=>present(n)&&productNode(n)&&detailLabel(n));
    const heading=headings.find(n=>/^H[1-4]$/.test(n.tagName))||headings.filter(n=>!n.closest('nav,a,button,[role="tab"],[role="navigation"]')).at(-1);
    const pageFields='h1,[data-sku-id],.sku-row,[class*="ItemGallery"],[class*="PicGallery"],[class*="MainPic"]';
    const sections=[...document.querySelectorAll(detailSelector)].filter(n=>present(n)&&productNode(n)&&(n.matches('#description,#J_DivItemDesc')||!n.querySelector(pageFields)));
    const frames=[...document.querySelectorAll('iframe')].filter(n=>present(n)&&productNode(n)&&/desc|detail/i.test(n.id+' '+n.className+' '+(n.getAttribute('src')||n.getAttribute('data-src')||n.getAttribute('data-lazy-src')||'')));
    const nodes=new Set();
    let stop;
    for(const section of sections)for(const n of section.querySelectorAll('*'))if(present(n)&&productNode(n))nodes.add(n);
    if(heading){
      stop=[...document.querySelectorAll('h1,h2,h3,h4,div,span')].find(n=>present(n)&&words(n).length<16&&/^(?:本店推荐|看了又看|店铺推荐|热门推荐|猜你喜欢|用户评价)$/.test(words(n).replace(/\s+/g,''))&&(heading.compareDocumentPosition(n)&4));
      for(const n of document.querySelectorAll('img,p,span,div'))if((heading.compareDocumentPosition(n)&4)&&(!stop||(!(stop.compareDocumentPosition(n)&4)&&!stop.contains(n)))&&present(n)&&productNode(n))nodes.add(n);
    }
    for(const frame of frames)try{for(const n of frame.contentDocument?.querySelectorAll('img,p,span,div')||[])if(present(n)&&productNode(n))nodes.add(n);}catch{/* Cross-origin frames are read through declared description URLs. */}
    const active=Boolean(heading||sections.length||frames.length||labels.length);
    let scrollPending=false;
    if(active){
      detailPasses++;
      const anchor=heading||sections[0]||frames[0];
      try{if(anchor){
        const offset=window.scrollY||0,top=anchor.getBoundingClientRect().top+offset;
        const bounds=[...sections];
        for(let scope=heading?.parentElement;scope&&scope!==document.body&&scope!==document.documentElement;scope=scope.parentElement){
          if(scope.querySelector(pageFields))break;
          if(scope.querySelector('img,iframe'))bounds.push(scope);
        }
        const ends=bounds.map(n=>n.getBoundingClientRect()).filter(b=>Number.isFinite(b.top)&&b.height>0).map(b=>b.top+b.height+offset).filter(n=>n>top);
        const pageEnd=Math.max(document.documentElement?.scrollHeight||0,document.body?.scrollHeight||0);
        let end=ends.length?Math.max(...ends):pageEnd>top?pageEnd:NaN;
        if(stop){const b=stop.getBoundingClientRect();const boundary=b.top+offset;if(Number.isFinite(boundary)&&boundary>top)end=Number.isFinite(end)?Math.min(end,boundary):boundary;}
        const last=Number.isFinite(end)?Math.max(top,end-(window.innerHeight||700)):NaN;
        const target=Number.isFinite(last)?Math.min(top+(detailPasses-1)*700,last):top+(detailPasses-1)*700;
        scrollPending=Number.isFinite(last)&&target<last;
        window.scrollTo(0,target);
      }}catch{/* No layout in background samples. */}
    }
    return {active,scrollPending,nodes:[...nodes],frames};
  }
  function snapshot(pageGoods){
    const goodsId=new URL(location.href).searchParams.get('id')||'';
    const phrases=[...document.querySelectorAll('div,p,span,h1,h2,button')].filter(n=>!n.children.length&&present(n)).map(words).filter(v=>v.length<150);
    const reason=phrases.find(v=>/请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|验证码|访问被拒绝/.test(v))
      || (/^login\.(taobao|tmall)\.com$/.test(location.hostname)||phrases.some(v=>/^(?:扫码登录|密码登录|请登录后|登录后查看)/.test(v))?'请在采集页登录淘宝':'');
    if(reason)return {url:location.href,goodsId,blocked:true,reason,ready:false,detail:null};
    const area=descriptionArea();
    const candidates=matchedRoots([...(pageGoods?.roots||[]),...initialRoots()],goodsId).map(r=>mergedRoot(r,goodsId));
    const root=candidates.reduce((best,r)=>((r.skuBase?.skus?.length||0)+(r.skuCore?10:0)>(best.skuBase?.skus?.length||0)+(best.skuCore?10:0)?r:best),candidates[0]||{});
    const item=root.item||root.itemDO||{};
    const domTitle=[...document.querySelectorAll('h1,[class*="ItemHeader"] [class*="title"],#J_Title h3')].filter(n=>present(n)&&productNode(n)).map(words).find(v=>v.length>1&&!/登录|验证|人付款|优惠券/.test(v))||'';
    const title=value(item.title||item.name||root.title)||domTitle;
    const sku=skuRows(root);
    if(!sku.rows.length)sku.rows=domSkus();
    const galleryImages=images(item.images||item.pics||root.images);
    if(!galleryImages.length)galleryImages.push(...domImages(gallerySelector));
    const detailImages=[...new Set([...images(root.detail?.images||root.detailImages),...images(area.nodes.filter(n=>n.tagName==='IMG').map(descriptionPicture))])];
    const descriptionUrls=[...new Set([root.detail?.descUrl,root.descInfo?.pcDescUrl,root.descInfo?.h5DescUrl,item.pcDescUrl,item.h5DescUrl,root.descUrl,
      ...area.frames.map(n=>n.getAttribute('src')||n.getAttribute('data-src')||n.getAttribute('data-lazy-src'))].map(documentUrl).filter(Boolean))];
    const params=attributes(root);
    const video=typeof root.video==='object'?root.video?.url||root.video?.videoUrl||root.video?.playUrl:root.video;
    const videoUrl=https(video)||[...document.querySelectorAll('video,video source')].filter(n=>present(n)&&productNode(n)).map(n=>https(n.currentSrc||n.getAttribute('src'))).find(Boolean)||'';
    const signature=JSON.stringify(detailImages);
    detailStable=signature===detailSignature?detailStable+1:1;detailSignature=signature;
    const detailLoading=area.active&&(detailPasses<7||detailStable<3||area.scrollPending);
    const detailPending=!detailImages.length||detailLoading;
    const detail={title,price:price(root.skuCore?.sku2info?.['0']?.price||item.price),galleryImages,detailImages,
      descriptionText:'',category:value(item.categoryName||root.categoryName),attributes:params,
      videoUrl,certificateImages:images(root.certificateImages),sizeChartImages:images(root.sizeChartImages),specNames:sku.names,skus:sku.rows,
      detailStatus:sku.complete&&!detailPending?'done':'partial',detailNote:!detailImages.length?'未读到图文详情图片，链接及其他已采集字段已保留':sku.complete&&!detailPending?'':'部分字段尚未提供或未加载完成；未虚构 SKU、库存或规格'};
    return {url:location.href,goodsId,blocked:false,reason:'',ready:Boolean(title&&(galleryImages.length||params.length||sku.rows.length||detailImages.length)),
      detailPending,detailLoading,skuPending:!sku.complete,descriptionUrls,source:candidates.length?'json':'dom',detail};
  }
  chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
    if(message.type!=='PDD_DETAIL_SNAPSHOT')return;
    try{respond(snapshot(message.pageGoods));}catch(error){respond({error:error.message});}
  });
})();
