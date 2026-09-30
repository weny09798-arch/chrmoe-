(() => {
  if (globalThis.__taobaoCollectorInstalled) return;
  globalThis.__taobaoCollectorInstalled = true;
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const selector = 'a[href*="item.taobao.com"],a[href*="detail.tmall.com"],a[href*="detail.m.tmall.com"],a[href*="h5.m.taobao.com"]';
  let pagedSnapshot = '';
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
        if ((Number(img.getAttribute('width'))||120)<40 || (Number(img.getAttribute('height'))||120)<40) continue;
        return {img,url:url.href};
      } catch { /* Ignore invalid images. */ }
    }
    return null;
  }
  function name(card,anchor,img) {
    const query=new URL(location.href).searchParams.get('q')||'';
    const letters=[...query.normalize('NFKC').toLowerCase()].filter(c=>/\p{L}/u.test(c));
    const nodes=[...card.querySelectorAll('h1,h2,h3,[class*="title"],[class*="Title"]')].filter(shown);
    const values=[...nodes.flatMap(n=>[n.getAttribute('title'),text(n)]),anchor.getAttribute('title'),img.getAttribute('alt')];
    return values.map(v=>String(v||'').replace(/\s+/g,' ').trim()).find(v=>v.length>=2 && v.length<300 && !/[¥￥]|人付款|人收货|好评|包邮|包运费|满减|保证金|退货|官方补贴|已售|销量/.test(v) && letters.some(c=>v.normalize('NFKC').toLowerCase().includes(c)))||'';
  }
  function price(card) {
    const nodes=[...card.querySelectorAll('[class*="price"],[class*="Price"],[data-price]')].filter(shown);
    const current=nodes.filter(n=>!n.closest('del,s,[class*="original"],[class*="Original"],[class*="oldPrice"]'));
    const marked=current.map(n=>text(n).replace(/\s+/g,'').replace(/(\d),(?=\d{3}(?:,|\.|起|$))/g,'$1')).filter(v=>/^(?:券后|到手价|售价)?[¥￥]?\d+(?:\.\d{1,2})?(?:起)?$/.test(v));
    const withMark=marked.filter(v=>/[¥￥]/.test(v));
    const values=(withMark.length?withMark:marked.filter(v=>v.includes('.'))).map(v=>v.match(/\d+(?:\.\d{1,2})?/)?.[0]);
    if(!values.length) for(const n of card.querySelectorAll('*')) if(!n.children.length && shown(n) && !n.closest('del,s')) {
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
      if(!pic) continue;
      seen.add(item.id);
      found.push({...item,key:item.id,image:pic.url,title:name(card,anchor,pic.img),priceText:price(card)});
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
  function nextPage() {
    const query=new URL(location.href).searchParams.get('q');
    return [...document.querySelectorAll('a,button')].find(n=>{
      if(!shown(n)||n.disabled||n.getAttribute('aria-disabled')==='true'||/disabled/i.test(n.className||'')) return false;
      const label=n.getAttribute('aria-label')||n.getAttribute('title')||text(n);
      if(!/^(?:下一页|下一页\s*[>›»]?|Next)$/i.test(label)) return false;
      if(n.tagName==='BUTTON') return Boolean(n.closest('[class*="pagination"],[class*="Pagination"],[class*="pager"],[class*="Pager"]'));
      try {const url=new URL(n.getAttribute('href'),location.href);return url.protocol==='https:' && ['s.taobao.com','www.taobao.com','search.taobao.com'].includes(url.hostname) && /^\/search\/?$/.test(url.pathname) && url.searchParams.get('q')===query;} catch{return false;}
    });
  }
  function lastPage() {
    const scroll=root();
    if(!scroll.scrollHeight || scroll.scrollTop+(scroll.clientHeight||0)<scroll.scrollHeight-20)return false;
    return [...document.querySelectorAll('a,button,span')].some(n=>{
      if(!shown(n)||!n.closest('[class*="pagination"],[class*="Pagination"],[class*="pager"],[class*="Pager"]'))return false;
      const label=n.getAttribute('aria-label')||n.getAttribute('title')||text(n);
      return /^(?:下一页|下一页\s*[>›»]?|Next)$/i.test(label)&&(n.disabled||n.getAttribute('aria-disabled')==='true'||/disabled/i.test(n.className||''));
    });
  }
  chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
    try {
      if(message.type==='PDD_SNAPSHOT') {
        const items=cards(),blocked=reason(items);
        respond({url:location.href,cards:items,blocked:Boolean(blocked),reason:blocked,position:root().scrollTop||0,end:lastPage()||phrases().some(v=>/没有找到相关|没有更多宝贝|没有更多商品|暂无相关商品|未找到相关宝贝/.test(v))});
      } else if(message.type==='PDD_SCROLL') {
        const scroll=root();
        if(typeof message.position==='number') scroll.scrollTop=Math.max(0,message.position);
        else if(!reason(cards())) {
          const next=scroll.scrollTop+Math.max(350,(scroll.clientHeight||600)*0.8);
          if(scroll.scrollHeight && next>=scroll.scrollHeight-scroll.clientHeight-20) {
            const button=nextPage(),key=location.href+'|'+cards().map(c=>c.id).join(',');
            if(button&&pagedSnapshot!==key) {pagedSnapshot=key;button.click();}
            else scroll.scrollTop=next;
          } else scroll.scrollTop=next;
        }
        respond({ok:true});
      } else if(message.type==='PDD_OPEN_CARD') {
        const anchor=[...document.querySelectorAll(selector)].find(n=>productUrl(n.getAttribute('href'))?.id===message.key&&shown(n));
        if(!anchor) respond({error:'商品卡片已变化，请重试'});
        else {respond({ok:true});setTimeout(()=>anchor.click(),50);}
      }
    } catch(error) {respond({error:error.message});}
    return true;
  });
})();
