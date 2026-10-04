'use strict';
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('doubao-token') || '';
sessionStorage.setItem('doubao-token', token); history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
let busy = false, state = null;
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
 $('results').replaceChildren();
 for(const item of items){
  const card=node('article',undefined,'result');card.append(node('h3',`${item.index+1} · ${item.name}`));
  card.append(node('p', `${phases[item.phase]||item.phase} · ${item.status==='running'||item.phase==='pending'?state.browser_stage:''} ${item.message||''}`));
  const pair=node('div',undefined,'pair');for(const kind of ['original','result']) {if(kind==='result'&&!item.result)continue;const figure=node('figure');figure.append(node('figcaption',kind==='original'?'原图':'转换结果'));const img=node('img');img.src=imageUrl(item.index,kind);img.alt=kind==='original'?'原图':'转换结果';figure.append(img);pair.append(figure);}card.append(pair);
  if(item.result){const a=node('a','打开结果图片');a.href=imageUrl(item.index,'result');a.target='_blank';a.rel='noopener';card.append(a,node('p',item.result.output_path,'path'));}
  const redo=node('button',item.status==='completed'?'单张重做':'明确重试此图');redo.disabled=busy||terminal||running;redo.onclick=()=>act(item.status==='completed'?'redo':'retry',item.index);card.append(redo);$('results').append(card);
 }
}
async function command(fn){busy=true;$('error').textContent='';render();try{state=await fn();}catch(e){$('error').textContent=e.message;}finally{busy=false;render();}}
function act(action,index){return command(()=>api('/api/action',{action,index}));}
$('files').onchange=()=>{$('selected').replaceChildren();for(const f of $('files').files)$('selected').append(node('span',f.name,'file'));render();};
$('open').onclick=()=>act('open-browser');$('stop').onclick=()=>act('stop');$('continue').onclick=()=>act('continue');
$('start').onclick=()=>command(()=>{const form=new FormData();for(const f of $('files').files)form.append('files',f);form.append('output_dir',$('output').value);form.append('extra',$('extra').value);form.append('background',$('background').checked);form.append('typography',$('typography').checked);return api('/api/jobs',form);});
$('exit').onclick=async()=>{try{await api('/api/exit',{});$('status').textContent='工具已关闭，可以关闭此页面';document.querySelectorAll('button').forEach(b=>b.disabled=true);}catch(e){$('error').textContent=e.message;}};
async function poll(){if(!busy)try{state=await api('/api/state');render();}catch(e){$('error').textContent=e.message;}setTimeout(poll,1000);}poll();
