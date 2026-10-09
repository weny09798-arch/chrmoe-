'use strict';
const suppliedCode = document.getElementById('connection-code').value;
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('doubao-token') || (suppliedCode ? new URLSearchParams(new URL(suppliedCode).hash.slice(1)).get('token') : '') || '';
sessionStorage.setItem('doubao-token', token); history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
$('connection-code').value = `${location.origin}${location.pathname}#token=${encodeURIComponent(token)}`;
$('copy-code').onclick = async () => {
 try {
  if(navigator.clipboard?.writeText) await navigator.clipboard.writeText($('connection-code').value);
  else { $('connection-code').select(); if(!document.execCommand('copy')) throw new Error('复制失败'); }
  $('connection-message').textContent='已复制，请粘贴到采集插件';
 } catch(e) { $('connection-message').textContent='请选中连接码，按 Ctrl+C 复制'; }
};
let busy = false, state = null, closed = false;
let aliyunConfigured = false, ossConfigured = false;
let licenseStatus = {allowed:false,message:'正在读取授权状态'};
const existingResult = item => ['pending','saving','aliyun-downloading','uploading','upload-failed','alias'].includes(item.phase);
function licensed(){return (state?.license || licenseStatus).allowed===true;}
const cards = new Map();
let selectedUrls = [];
const statuses = {idle:'尚未开始',running:'正在处理',stopped:'已停止后续提交',paused:'等待处理',completed:'全部已保存，请逐张检查', 'storage-error':'状态保存失败，必须重新启动'};
const phases = {uploading:'上传 OSS / 验证图片链接', 'upload-failed':'OSS 上传失败（已有本地结果）',downloading:'下载原图', 'download-failed':'原图下载失败', alias:'等待复用结果',ready:'等待提交', 'aliyun-ready':'等待阿里云付费提交', 'aliyun-downloading':'下载已有阿里云结果', 'aliyun-failed':'阿里云图片失败', submitting:'上传 / 提交',pending:'生成 / 下载',saving:'保存',done:'已保存',uncertain:'提交状态不确定'};
async function api(path, body, method) {
  const opts = {headers:{'X-Tool-Token':token}};
  if (body) {opts.method='POST'; if(body instanceof FormData) opts.body=body; else {opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}}
  if(method)opts.method=method;
  const r = await fetch(path,opts); const data=await r.json(); if(!r.ok) throw new Error(data.error || '操作失败');return data;
}
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function imageUrl(index,kind){return `/api/images/${encodeURIComponent(state.id)}/${index}/${kind}?token=${encodeURIComponent(token)}`;}
function render(){
 const license=state?.license || licenseStatus;
 $('license-status').textContent=(license.message||'授权不可用')+(license.expires_at?` · 到期：${new Date(license.expires_at*1000).toLocaleString()}`:'')+(license.remaining_days!==null&&license.remaining_days!==undefined?` · 剩余 ${license.remaining_days} 天`:'')+(license.offline?' · 离线授权':'');
 const running=state?.status==='running', terminal=state?.status==='storage-error';
 document.querySelectorAll('button').forEach(b=>b.disabled=busy || terminal);
 $('start').disabled=!licensed()||busy||terminal||!$('files').files.length||(state?.id&&state.status!=='completed')||($('provider').value==='aliyun'&&!aliyunConfigured);
 $('stop').disabled=busy||terminal||!running;
 $('continue').disabled=busy||terminal||!state?.id||running||state.status==='completed'||state.items.some(i=>i.status==='needs-review'||i.phase==='uncertain');
 $('continue').disabled=$('continue').disabled||(!licensed()&&!state?.items.some(i=>i.status!=='completed'&&existingResult(i)));
 $('license-activate').disabled=busy; $('license-refresh').disabled=busy;
 $('exit').disabled=busy; $('open').disabled=busy||terminal||state?.browser_busy;
 $('reset').disabled=busy||!state?.id;
 const fixedTarget=state?.upload_enabled&&state?.id&&state.status!=='completed';
 $('oss-bucket').disabled=busy||fixedTarget;$('oss-region').disabled=busy||fixedTarget;
 $('oss-delete').disabled=busy||fixedTarget;$('oss-save').disabled=busy||running;
 $('oss-check').disabled=busy||running||!ossConfigured;
 $('oss-key-id').disabled=busy||$('oss-mode').value==='translation';$('oss-key-secret').disabled=busy||$('oss-mode').value==='translation';
 $('status').textContent= (statuses[state?.status]||'')+' · '+(state?.message||'')+(state?.provider==='aliyun'?` · 付费调用尝试 ${state.paid_calls||0} 次（含不确定请求），预计费用上限 ¥${Number(state.estimated_cost_upper||0).toFixed(2)}`:'');
 $('browser').textContent=state?.browser_message || state?.browser_stage || '';
 const items=state?.items||[]; $('progress').max=Math.max(1,items.length);$('progress').value=items.filter(i=>i.status==='completed').length;
 const keys = new Set();
 for(const item of items){
  const key = `${state.id}:${item.index}`; keys.add(key);
  let view = cards.get(key);
  if(!view){
   const card=node('article',undefined,'result'), title=node('h3'), detail=node('p'), pair=node('div',undefined,'pair');
   const original=node('img');original.alt='原图';original.hidden=true;
   const originalFigure=node('figure');originalFigure.append(node('figcaption','原图'),original);pair.append(originalFigure);
   const link=node('a','打开结果图片');link.target='_blank';link.rel='noopener';link.hidden=true;
   const path=node('p',undefined,'path'), retry=node('button'), redo=node('button');card.append(title,detail,pair,link,path,retry,redo);$('results').append(card);
   view={card,title,detail,pair,link,path,retry,redo,original,originalVersion:null,resultFigure:null,resultImage:null,resultVersion:null};cards.set(key,view);
  }
  if(item.input_path && view.originalVersion!==item.input_path){view.originalVersion=item.input_path;view.original.src=imageUrl(item.index,'original');view.original.hidden=false;}
  view.title.textContent=`${item.index+1} · ${item.name}`;
  view.detail.textContent=`${phases[item.phase]||item.phase} · ${item.status==='running'||item.phase==='pending'?state.browser_stage:''} ${item.message||''}`;
  if(item.result){
   if(!view.resultImage){const figure=node('figure');const img=node('img');img.alt='转换结果';figure.append(node('figcaption','转换结果'),img);view.pair.append(figure);view.resultFigure=figure;view.resultImage=img;}
   const resultVersion=item.result.public_url||item.result.output_path;
   if(view.resultVersion!==resultVersion){
    view.resultVersion=resultVersion;
    view.resultImage.src=imageUrl(item.index,'result')+`&version=${encodeURIComponent(resultVersion)}`;
    view.link.href=view.resultImage.src;
   }
   view.link.hidden=false;view.path.textContent=item.result.public_url ? '已保存到 OSS：'+item.result.public_url : item.result.output_path;
  }else{
   if(view.resultFigure)view.resultFigure.remove();
   view.resultFigure=null;view.resultImage=null;view.resultVersion=null;
   view.link.hidden=true;view.path.textContent='';
  }
  view.retry.textContent=item.phase==='upload-failed'?'重试上传（不重新翻译）':['pending','saving','aliyun-downloading'].includes(item.phase)?'继续获取此图':'继续处理此图';
  view.retry.hidden=item.status==='completed'||item.status==='needs-review'||item.phase==='uncertain'||(state?.provider==='aliyun'&&['submitting','aliyun-failed'].includes(item.phase));
  view.retry.disabled=busy||terminal||running||(!licensed()&&!existingResult(item));
  view.retry.onclick=()=>act(item.phase==='upload-failed'?'retry-upload':'retry',item.index);
  view.redo.textContent='重新生成此图';view.redo.disabled=busy||terminal||running||!licensed();
  view.redo.onclick=()=>act('redo',item.index);
 }
 for(const [key,view] of cards){if(!keys.has(key)){view.card.remove();cards.delete(key);}}

}
async function command(fn){busy=true;$('error').textContent='';render();try{state=await fn();}catch(e){$('error').textContent=e.message;}finally{busy=false;render();}}
function act(action,index){
 if(!licensed()&&(action==='redo'||(action==='retry'&&!existingResult(state.items[index])))){ $('error').textContent='请激活或续费授权后手动恢复任务';return; }
 const paid=action==='redo'&&state?.provider==='aliyun';
 if(paid&&!window.confirm('阿里云重新生成会再次按 ¥0.06/张计费，图片将上传阿里云；包装文字仍需逐张检查。确认再次付费？'))return;
 return command(()=>api('/api/action',{action,index,...(paid?{paid_confirmed:true}:{})}));
}
async function updateLicense(path, body){
 busy=true;$('error').textContent='';render();
 try{licenseStatus=await api(path,body);if(state)state.license=licenseStatus;}
 catch(e){$('error').textContent=e.message;}
 finally{$('license-code').value='';busy=false;render();}
}
$('license-activate').onclick=()=>updateLicense('/api/license/activate',{code:$('license-code').value.trim()});
$('license-refresh').onclick=()=>updateLicense('/api/license/refresh',{});
async function refreshCredentials(){
 const result=await api('/api/aliyun/credentials');aliyunConfigured=result.aliyun_configured===true;
 $('aliyun-status').textContent=aliyunConfigured?'已配置（¥0.06/张）':'尚未配置，阿里云付费转换不可开始';render();
}
$('aliyun-save').onclick=async()=>{
 busy=true;$('error').textContent='';render();
 try{await api('/api/aliyun/credentials',{access_key_id:$('aliyun-key-id').value.trim(),access_key_secret:$('aliyun-key-secret').value.trim()});await refreshCredentials();}
 catch(e){$('error').textContent=e.message;}
 finally{$('aliyun-key-secret').value='';busy=false;render();}
};
$('aliyun-delete').onclick=async()=>{
 busy=true;$('error').textContent='';render();
 try{await api('/api/aliyun/credentials',undefined,'DELETE');$('aliyun-key-id').value='';await refreshCredentials();}
 catch(e){$('error').textContent=e.message;}
 finally{$('aliyun-key-secret').value='';busy=false;render();}
};
async function refreshOSS(){
 const result=await api('/api/oss/config');ossConfigured=result.oss_configured===true;
 $('oss-status').textContent=ossConfigured?`已配置 · ${result.bucket} · ${result.region}（请点击检查确认权限及链接）`:'尚未配置，插件自动替换图片不可开始';
 if(ossConfigured){$('oss-bucket').value=result.bucket;$('oss-region').value=result.region;$('oss-mode').value=result.credential_mode;}
 render();
}
$('oss-mode').onchange=render;
$('oss-save').onclick=async()=>{
 busy=true;$('error').textContent='';render();
 try{await api('/api/oss/config',{bucket:$('oss-bucket').value.trim(),region:$('oss-region').value.trim(),credential_mode:$('oss-mode').value,...($('oss-mode').value==='independent'?{access_key_id:$('oss-key-id').value.trim(),access_key_secret:$('oss-key-secret').value.trim()}:{})});await refreshOSS();}
 catch(e){$('error').textContent=e.message;}
 finally{$('oss-key-secret').value='';busy=false;render();}
};
$('oss-delete').onclick=async()=>{
 busy=true;$('error').textContent='';render();
 try{await api('/api/oss/config',undefined,'DELETE');$('oss-key-id').value='';await refreshOSS();}
 catch(e){$('error').textContent=e.message;}
 finally{$('oss-key-secret').value='';busy=false;render();}
};
$('oss-check').onclick=async()=>{
 busy=true;$('error').textContent='';render();
 try{const result=await api('/api/oss/check',{});$('oss-status').textContent=result.message||'OSS 上传及公开读取正常';}
 catch(e){$('error').textContent=e.message;}
 finally{busy=false;render();}
};
refreshOSS().catch(e=>{$('error').textContent=e.message;});
$('provider').onchange=render;
refreshCredentials().catch(e=>{$('error').textContent=e.message;});
function clearSelected(){for(const url of selectedUrls)URL.revokeObjectURL(url);selectedUrls=[];}
$('files').onchange=()=>{
 clearSelected();$('selected').replaceChildren();
 for(const f of $('files').files){const figure=node('figure',undefined,'selected-file'),img=node('img');const url=URL.createObjectURL(f);selectedUrls.push(url);img.src=url;img.alt=f.name;figure.append(img,node('figcaption',f.name));$('selected').append(figure);}
 render();
};
window.addEventListener('beforeunload',clearSelected);
$('open').onclick=()=>act('open-browser');$('stop').onclick=()=>act('stop');$('continue').onclick=()=>act('continue');
$('reset').onclick=()=>command(async()=>{const empty=await api('/api/reset',{});$('files').value='';clearSelected();$('selected').replaceChildren();return empty;});
$('start').onclick=()=>{
 if(!licensed()){$('error').textContent='请激活或续费授权后开始新任务';return;}
 const provider=$('provider').value;
 if(provider==='aliyun'){
  if(!aliyunConfigured){$('error').textContent='请先配置阿里云 AccessKey';return;}
  if(!window.confirm(`阿里云图片翻译按 ¥0.06/张计费，本批预计费用上限 ¥${($('files').files.length*0.06).toFixed(2)}。图片将上传阿里云，实体保护不能保证包装文字不变，请逐张检查。确认付费开始？`))return;
 }
 return command(()=>{const form=new FormData();for(const f of $('files').files)form.append('files',f);form.append('output_dir',$('output').value);form.append('provider',provider);if(provider==='aliyun')form.append('paid_confirmed','true');form.append('extra',$('extra').value);form.append('background',$('background').checked);form.append('typography',$('typography').checked);return api('/api/jobs',form);});
};
$('exit').onclick=async()=>{try{await api('/api/exit',{});closed=true;clearSelected();$('error').textContent='';$('status').textContent='工具正在关闭并清空任务，登录和已保存的图片保留，可以关闭此页面';document.querySelectorAll('button').forEach(b=>b.disabled=true);}catch(e){$('error').textContent=e.message;}};
async function poll(){if(closed)return;if(!busy)try{const current=await api('/api/state');if(!closed){state=current;render();}}catch(e){if(!closed)$('error').textContent=e instanceof TypeError?'无法连接本机工具，请确认程序仍在运行；若已关闭，请重新启动。':e.message;}if(!closed)setTimeout(poll,1000);}poll();
