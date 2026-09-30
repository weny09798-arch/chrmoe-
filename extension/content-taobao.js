(() => {
  if (globalThis.__taobaoCollectorInstalled) return;
  globalThis.__taobaoCollectorInstalled = true;
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const selector = 'a[href*="item.taobao.com"],a[href*="detail.tmall.com"],a[href*="detail.m.tmall.com"],a[href*="h5.m.taobao.com"]';
  let pagedSnapshot = '', transition = null;
  function shown(el) {
    for (let node=el; node?.nodeType===1; node=node.parentElement) {
      const css=getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden')==='true' || css.display==='none' || css.visibility==='hidden') return false;
    }
    return true;
  }
  function productUrl(href) {
    try {
      const url=new URL(href,location.href), id=url.searchParams.get('id');
      const valid=['item.taobao.com','detail.tmall.com','detail.m.tmall.com'].includes(url.hostname) && url.pathname==='/item.htm'
        || url.hostname==='h5.m.taobao.com' && url.pathname==='/awp/core/detail.htm';
      if (url.protocol!=='https:' || !valid || !/^\d+$/.test(id||'')) return null;
      return {id,url:`https://${url.hostname.endsWith('.tmall.com')?'detail.tmall.com':'item.taobao.com'}/item.htm?id=${id}`};
    } catch { return null; }
  }
  function container(anchor) {
    let card=anchor;
    for(let i=0;i<12;i++) {
      const parent=card.parentElement;
      if (!parent || parent===document.body) break;
      const ids=new Set([...parent.querySelectorAll(selector)].map(a=>productUrl(a.getAttribute('href'))?.id).filter(Boolean));
      if(ids.size>1) break;
      card=parent;
    }
    return card;
  }
  function picture(card) {
    const choices=[];
    for(const img of card.querySelectorAll('img')) {
      if(!shown(img)) continue;
      const src=img.currentSrc||img.getAttribute('src')||'';
      const lazy=img.getAttribute('data-src')||img.getAttribute('data-lazy-src')||img.getAttribute('data-original');
      const raw=!src||/^(?:data:)|placeholder|blank|1x1|tps-/.test(src)?lazy:src;
      if(!raw) continue;
      try {
        const url=new URL(raw,location.href);
        if(url.protocol!=='https:' || !/(^|\.)alicdn\.com$/.test(url.hostname)) continue;
        if (/tps-|avatar|sprite|logo|1x1/i.test(url.pathname)) continue;
        const box=img.getBoundingClientRect?.();
        const width=box?.width||Number(img.getAttribute('width'))||img.naturalWidth||120;
        const height=box?.height||Number(img.getAttribute('height'))||img.naturalHeight||120;
        if (width<40 || height<40 || /badge|icon|logo|avatar|promotion|marketing/i.test(img.className+' '+img.getAttribute('alt'))) continue;
        choices.push({img,url:url.href,area:width*height});
      } catch { /* Ignore invalid images. */ }
    }
    return choices.sort((a,b)=>b.area-a.area)[0]||null;
  }
  function name(card,anchor,img) {
    const query=new URL(location.href).searchParams.get('q')||'';
    const letters=[...query.normalize('NFKC').toLowerCase()].filter(c=>/\p{L}/u.test(c));
    const nodes=[...card.querySelectorAll('h1,h2,h3,[class*="title"],[class*="Title"]')].filter(shown);
    const values=[...nodes.flatMap(n=>[n.getAttribute('title'),text(n)]),anchor.getAttribute('title'),img?.getAttribute('alt')];
    return values.map(v=>String(v||'').replace(/\s+/g,' ').trim()).find(v=>v.length>=2 && v.length<300 && !/[¥￥]|人付款|人收货|好评|包邮|包运费|满减|保证金|退货|官方补贴|已售|销量/.test(v) && letters.some(c=>v.normalize('NFKC').toLowerCase().includes(c)))||'';
  }
  function price(card) {
    const excluded='del,s,[class*="original"],[class*="Original"],[class*="oldPrice"],[class*="coupon"],[class*="Coupon"],[class*="discount"],[class*="Discount"],[class*="promotion"],[class*="Promotion"]';
    const nodes=[...card.querySelectorAll('[class*="price"],[class*="Price"],[data-price]')].filter(shown);
    const current=nodes.filter(n=>!n.closest(excluded));
    const marked=current.map(n=>text(n).replace(/\s+/g,'').replace(/(\d),(?=\d{3}(?:,|\.|起|补贴后|优惠后|首单价|$))/g,'$1')).filter(v=>/^(?:券后|到手价|售价)?[¥￥]?\d+(?:\.\d{1,2})?(?:起|补贴后|优惠后|首单价|券后|到手价)?$/.test(v));
    const withMark=marked.filter(v=>/[¥￥]/.test(v));
    const values=(withMark.length?withMark:marked.filter(v=>v.includes('.'))).map(v=>v.match(/\d+(?:\.\d{1,2})?/)?.[0]);
    if(!values.length) for(const n of card.querySelectorAll('*')) if(!n.children.length && shown(n) && !n.closest(excluded)) {
      const v=text(n).replace(/\s+/g,''); if(/^[¥￥]\d+(?:\.\d{1,2})?(?:起)?$/.test(v)) values.push(v.match(/\d+(?:\.\d{1,2})?/)[0]);
    }
    const unique=[...new Set(values.map(v=>Math.round(Number(v)*100)).filter(v=>v>0))];
    return unique.length===1?`¥${(unique[0]/100).toFixed(2)}`:'';
  }
  function cards() {
    const found=[],seen=new Set();
    for(const anchor of document.querySelectorAll(selector)) {
      if(!shown(anchor)) continue;
      const item=productUrl(anchor.getAttribute('href'));
      if(!item || seen.has(item.id)) continue;
      const card=container(anchor),pic=picture(card);
      seen.add(item.id);
      found.push({...item,key:item.id,image:pic?.url||'',title:name(card,anchor,pic?.img),priceText:price(card)});
    }
    return found;
  }
  function root() { return document.scrollingElement || document.documentElement; }
  function phrases() { return [...document.querySelectorAll('div,p,span,h1,h2,button')].filter(n=>!n.children.length&&shown(n)).map(text).filter(v=>v.length<150); }
  function reason(items) {
    const words=phrases();
    return words.find(v=>/请完成.*验证|拖动滑块|安全验证|访问过于频繁|操作频繁|请验证身份|验证码|访问被拒绝/.test(v))
      || (/^login\.(taobao|tmall)\.com$/.test(location.hostname) || !items.length&&words.some(v=>/请登录|登录后查看|扫码登录|密码登录|手机号登录/.test(v))?'请在采集页登录淘宝':'');
  }
  const pagerSelector='[class*="pagination"],[class*="Pagination"],[class*="pager"],[class*="Pager"],[role="navigation"][aria-label*="分页"]';
  function disabled(n) {
    for(let el=n;el?.nodeType===1;el=el.parentElement) {
      if(el.disabled||el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'||/(?:^|[\s_-])disabled(?:$|[\s_-])/i.test(el.className||''))return true;
      if(el.matches(pagerSelector))break;
    }return false;
  }
  function pageControl() {
    const query=new URL(location.href).searchParams.get('q');
    return [...document.querySelectorAll('a,button,[role="button"],div,li,span')].find(n=>{
      if(!shown(n)||n.closest(selector))return false;
      const label=n.getAttribute('aria-label')||n.getAttribute('title')||text(n);
      if(!/^(?:下一页\s*[>›»→]?|Next)$/i.test(label.trim()))return false;
      const link=n.closest('a[href]');
      if(link) {
        const href=link.getAttribute('href');
        if(href&&href!=='#') {
          try {const url=new URL(href,location.href);return url.protocol==='https:' && ['s.taobao.com','www.taobao.com','search.taobao.com'].includes(url.hostname) && /^\/search\/?$/.test(url.pathname) && url.searchParams.get('q')===query;}catch{return false;}
        }
      }
      if(!n.closest(pagerSelector))return false;
      if(n.matches(pagerSelector)&&!['BUTTON','A'].includes(n.tagName)&&n.getAttribute('role')!=='button'&&!/prevNext|(?:^|[-_\s])next/i.test(n.className))return false;
      // Click the actual control rather than a wrapper containing a button.
      return ![...n.querySelectorAll('a,button,[role="button"]')].some(v=>shown(v)&&/^(?:下一页\s*[>›»→]?|Next)$/i.test((v.getAttribute('aria-label')||text(v)).trim()));
    });
  }
  function signature(items) {return items.map(c=>c.id).join(',');}
  function noResults() {return phrases().some(v=>/没有找到相关|没有更多宝贝|没有更多商品|暂无相关商品|未找到相关宝贝/.test(v));}
  function pagination(items,empty=false) {
    if(empty)transition=null;
    if(!transition)return {paginationPending:false,paginationError:''};
    if(items.some(c=>!transition.ids.includes(c.id))) {transition=null;root().scrollTop=0;return {paginationPending:false,paginationError:''};}
    const expired=Date.now()-transition.started>=25000;
    return {paginationPending:!expired,paginationError:expired?'淘宝翻页未完成，已保留当前结果；请检查采集页后重新搜索':'',paginationToken:transition.token};
  }
  function lastPage() {
    const scroll=root();
    if(!scroll.scrollHeight || scroll.scrollTop+(scroll.clientHeight||0)<scroll.scrollHeight-20)return false;
    const control=pageControl();return Boolean(control&&disabled(control));
  }
  chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
    try {
      if(message.type==='PDD_SNAPSHOT') {
        const items=cards(),blocked=reason(items);
        const empty=noResults(),paging=pagination(items,empty);
        respond({url:location.href,cards:items,blocked:Boolean(blocked),reason:blocked,position:root().scrollTop||0,...paging,noResults:empty,end:!paging.paginationPending&&!paging.paginationError&&(lastPage()||empty)});
      } else if(message.type==='PDD_SCROLL') {
        const scroll=root();
        if(typeof message.position==='number') scroll.scrollTop=Math.max(0,message.position);
        else if(!reason(cards())&&!transition) {
          const next=scroll.scrollTop+Math.max(350,(scroll.clientHeight||600)*0.8);
          if(scroll.scrollHeight && next>=scroll.scrollHeight-scroll.clientHeight-20) {
            const items=cards(),button=pageControl(),key=location.href+'|'+signature(items);
            if(items.length&&button&&!disabled(button)&&pagedSnapshot!==key) {pagedSnapshot=key;transition={ids:items.map(c=>c.id),started:Date.now(),token:key};button.click();}
            else scroll.scrollTop=next;
          } else scroll.scrollTop=next;
        }
        respond({ok:true,...pagination(cards(),noResults())});
      } else if(message.type==='PDD_OPEN_CARD') {
        const anchor=[...document.querySelectorAll(selector)].find(n=>productUrl(n.getAttribute('href'))?.id===message.key&&shown(n));
        if(!anchor) respond({error:'商品卡片已变化，请重试'});
        else {respond({ok:true});setTimeout(()=>anchor.click(),50);}
      }
    } catch(error) {respond({error:error.message});}
    return true;
  });
})();
