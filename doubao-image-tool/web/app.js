'use strict';
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('doubao-token') || '';
sessionStorage.setItem('doubao-token', token); history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
let busy = false, state = null, closed = false;
const cards = new Map();
let selectedUrls = [];
const statuses = {idle:'尚未开始',running:'正在处理',stopped:'已停止后续提交',paused:'等待处理',completed:'全部已保存，请逐张检查', 'storage-error':'状态保存失败，必须重新启动'};
const phases = {ready:'等待提交', submitting:'上传 / 提交',pending:'生成 / 下载',saving:'保存',done:'已保存',uncertain:'提交状态不确定'};
async function api(path, body) {
  const opts = {headers:{'X-Tool-Token':token}};
  if (body) {opts.method='POST'; if(body instanceof FormData) opts.body=body; else {opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}}
  const r = await fetch(path,opts); const data=await r.json(); if(!r.ok) throw new Error(data.error || '操作失败');return data;
}
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function imageUrl(index,kind){return `/api/images/${encodeURIComponent(state.id)}/${index}/${kind}?token=${encodeURIComponent(token)}`;}
function render(){
 const running=state?.status==='running', terminal=state?.status==='storage-error';
 document.querySelectorAll('button').forEach(b=>b.disabled=busy || terminal);
 $('start').disabled=busy||terminal||!$('files').files.length||(state?.id&&state.status!=='completed');
 $('stop').disabled=busy||terminal||!running;
 $('continue').disabled=busy||terminal||!state?.id||running||state.status==='completed'||state.items.some(i=>i.status==='needs-review'||i.phase==='uncertain');
 $('exit').disabled=busy; $('open').disabled=busy||terminal||state?.browser_busy;
 $('status').textContent= (statuses[state?.status]||'')+' · '+(state?.message||'');
 $('browser').textContent=state?.browser_message || state?.browser_stage || '';
 const items=state?.items||[]; $('progress').max=Math.max(1,items.length);$('progress').value=items.filter(i=>i.status==='completed').length;
 const keys = new Set();
 for(const item of items){
  const key = `${state.id}:${item.index}`; keys.add(key);
  let view = cards.get(key);
  if(!view){
   const card=node('article',undefined,'result'), title=node('h3'), detail=node('p'), pair=node('div',undefined,'pair');
   const original=node('img');original.alt='原图';original.src=imageUrl(item.index,'original');
   const originalFigure=node('figure');originalFigure.append(node('figcaption','原图'),original);pair.append(originalFigure);
   const link=node('a','打开结果图片');link.target='_blank';link.rel='noopener';link.hidden=true;
   const path=node('p',undefined,'path'), redo=node('button');card.append(title,detail,pair,link,path,redo);$('results').append(card);
   view={card,title,detail,pair,link,path,redo,resultImage:null,resultVersion:null};cards.set(key,view);
  }
  view.title.textContent=`${item.index+1} · ${item.name}`;
  view.detail.textContent=`${phases[item.phase]||item.phase} · ${item.status==='running'||item.phase==='pending'?state.browser_stage:''} ${item.message||''}`;
  if(item.result){
   if(!view.resultImage){const figure=node('figure');const img=node('img');img.alt='转换结果';figure.append(node('figcaption','转换结果'),img);view.pair.append(figure);view.resultImage=img;}
   if(view.resultVersion!==item.result.output_path){
    view.resultVersion=item.result.output_path;
    view.resultImage.src=imageUrl(item.index,'result')+`&version=${encodeURIComponent(item.result.output_path)}`;
    view.link.href=view.resultImage.src;
   }
   view.link.hidden=false;view.path.textContent=item.result.output_path;
  }
  view.redo.textContent=item.status==='completed'?'单张重做':'明确重试此图';view.redo.disabled=busy||terminal||running;
  view.redo.onclick=()=>act(item.status==='completed'?'redo':'retry',item.index);
 }
 for(const [key,view] of cards){if(!keys.has(key)){view.card.remove();cards.delete(key);}}

}
async function command(fn){busy=true;$('error').textContent='';render();try{state=await fn();}catch(e){$('error').textContent=e.message;}finally{busy=false;render();}}
function act(action,index){return command(()=>api('/api/action',{action,index}));}
function clearSelected(){for(const url of selectedUrls)URL.revokeObjectURL(url);selectedUrls=[];}
$('files').onchange=()=>{
 clearSelected();$('selected').replaceChildren();
 for(const f of $('files').files){const figure=node('figure',undefined,'selected-file'),img=node('img');const url=URL.createObjectURL(f);selectedUrls.push(url);img.src=url;img.alt=f.name;figure.append(img,node('figcaption',f.name));$('selected').append(figure);}
 render();
};
window.addEventListener('beforeunload',clearSelected);
$('open').onclick=()=>act('open-browser');$('stop').onclick=()=>act('stop');$('continue').onclick=()=>act('continue');
$('start').onclick=()=>command(()=>{const form=new FormData();for(const f of $('files').files)form.append('files',f);form.append('output_dir',$('output').value);form.append('extra',$('extra').value);form.append('background',$('background').checked);form.append('typography',$('typography').checked);return api('/api/jobs',form);});
$('exit').onclick=async()=>{try{await api('/api/exit',{});closed=true;clearSelected();$('error').textContent='';$('status').textContent='工具已关闭，可以关闭此页面';document.querySelectorAll('button').forEach(b=>b.disabled=true);}catch(e){$('error').textContent=e.message;}};
async function poll(){if(closed)return;if(!busy)try{const current=await api('/api/state');if(!closed){state=current;render();}}catch(e){if(!closed)$('error').textContent=e instanceof TypeError?'无法连接本机工具，请确认程序仍在运行；若已关闭，请重新启动。':e.message;}if(!closed)setTimeout(poll,1000);}poll();
