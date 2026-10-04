'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="local-token"]').content;
const limits = {files:20, bytes:80 * 1024 * 1024};
let selected = [], busy = false, currentJob = null, rendered = new Set();
const reasons = {low_confidence:'识别置信度较低',too_small:'文字太小',out_of_bounds:'识别区域超出图片',invalid_box:'识别区域无效',rotated:'文字倾斜',no_clear_foreground:'文字与背景不易分离',complex_background:'背景或描边复杂',transparent_text:'文字区域透明度不均，保留原样',text_does_not_fit:'繁体文字无法安全排入原区域'};
function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function updateSelection() {
  $('selected').replaceChildren();
  selected.forEach((entry, index) => {
    const card = node('div', undefined, 'thumb'), image = node('img'); image.src = entry.url; image.alt = entry.file.name;
    const remove = node('button','×','remove'); remove.type = 'button'; remove.disabled = busy; remove.setAttribute('aria-label',`移除 ${entry.file.name}`);
    remove.onclick = () => { URL.revokeObjectURL(entry.url); selected.splice(index, 1); updateSelection(); };
    card.append(image, node('small', entry.file.name), remove); $('selected').append(card);
  });
  $('count').textContent = selected.length ? `已选择 ${selected.length} 张` : '尚未选择图片';
  $('start').disabled = busy || !selected.length;
}
function addFiles(files) {
  if (busy) return;
  const additions = Array.from(files);
  if (selected.length + additions.length > limits.files) return showError('一批最多20张，请移除一些图片。');
  if (additions.some(f => !/\.(png|jpe?g|webp)$/i.test(f.name))) return showError('请选择 JPG、PNG 或 WebP 图片。');
  if ([...selected.map(e=>e.file),...additions].reduce((n,f)=>n+f.size,0) > limits.bytes) return showError('图片总大小超过80MB，请分批处理。');
  additions.forEach(file => selected.push({file,url:URL.createObjectURL(file)})); showError(''); updateSelection();
}
$('files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
['dragenter','dragover'].forEach(type => $('drop').addEventListener(type, e => {e.preventDefault(); if (!busy) $('drop').classList.add('over');}));
['dragleave','drop'].forEach(type => $('drop').addEventListener(type, e => {e.preventDefault(); $('drop').classList.remove('over');}));
$('drop').addEventListener('drop', e => addFiles(e.dataTransfer.files));
async function api(path, options={}) {
  const response = await fetch(path,{...options,headers:{'X-Local-Token':token,...options.headers}});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function imageUrl(job, index, kind) {return `/api/jobs/${encodeURIComponent(job)}/image/${index}/${kind}?token=${encodeURIComponent(token)}`;}
function renderResult(job, result) {
  const card = node('article', undefined, 'panel'), head = node('div',undefined,'result-head'); head.append(node('h2', result.name)); card.append(head);
  if (result.status !== 'ok') {card.append(node('p',result.error,'review')); $('results').append(card); return;}
  const report = result.report;
  head.append(node('span',`替换 ${report.changed} 处 · 跳过 ${report.skipped} 处`,'badge'));
  const compare = node('div',undefined,'compare');
  for (const [kind,label] of [['original','原图'],['result','转换后']]) {
    const figure = node('figure',undefined,'picture'), img = node('img'); img.src = imageUrl(job,result.index,kind); img.alt = `${result.name} ${label}`; img.loading = 'lazy';
    figure.append(node('figcaption',label),img); compare.append(figure);
  }
  card.append(compare,node('p',`已保存：${result.paths.png}`,'save-path'));
  const download = node('a','下载转换图片','button'); download.href = imageUrl(job,result.index,'result')+'&download=1'; card.append(download);
  if (!report.changed) card.append(node('p','未读到需要转换的可靠文字，输出为原图副本，请检查下方识别记录。','review'));
  else if (report.skipped) card.append(node('p','有文字未替换，请查看识别记录并检查图片。','review'));
  const details = node('details'), table = node('table'), tr = node('tr');
  details.append(node('summary',`识别与转换记录（${report.count} 处）`));
  ['识别文字','转换文字','处理结果'].forEach(title => tr.append(node('th',title))); table.append(tr);
  for (const region of report.regions) {const row = node('tr'); row.append(node('td',region.source),node('td',region.traditional),node('td',region.status === 'changed' ? '已替换' : region.status === 'unchanged' ? '无需转换' : `跳过：${reasons[region.reason] || region.reason}`)); table.append(row);}
  details.append(table); card.append(details); $('results').append(card);
}
function setBusy(value) {busy = value; $('files').disabled=value; $('output').disabled=value; $('mode').disabled=value; updateSelection();}
$('start').onclick = async () => {
  if (busy || !selected.length) return;
  showError(''); setBusy(true); $('progress-panel').hidden=false; $('results').replaceChildren(); rendered=new Set(); currentJob=null;
  $('status').textContent='准备处理'; $('progress').value=0; $('fraction').textContent=`0 / ${selected.length}`; $('current').textContent='首次启动会加载本地识别模型，请稍候。';
  try {
    const form = new FormData(); selected.forEach(entry=>form.append('images',entry.file)); form.append('output_dir',$('output').value); form.append('mode',$('mode').value);
    const start = await api('/api/jobs',{method:'POST',body:form}); currentJob=start.id;
    while (currentJob===start.id) {
      const state = await api(`/api/jobs/${start.id}`);
      $('progress').max=state.total; $('progress').value=state.processed; $('fraction').textContent=`${state.processed} / ${state.total}`; $('current').textContent=state.current;
      const terminal=['done','partial','error'].includes(state.status);
      $('status').textContent=terminal ? (state.status==='done'?'处理完成':state.status==='partial'?'部分图片处理失败':'处理失败') : '正在转换';
      for (const result of state.results) if (!rendered.has(result.index)) {renderResult(start.id,result); rendered.add(result.index);}
      if (terminal) break;
      await new Promise(resolve=>setTimeout(resolve,700));
    }
  } catch (error) {showError(error.message || '工具连接已断开，请重新启动。'); $('status').textContent='未完成';}
  finally {setBusy(false);}
};
$('exit').onclick = async () => {
  if (busy) return showError('正在处理图片，请等本批完成后退出。');
  try {await api('/api/shutdown',{method:'POST'}); currentJob=null; setBusy(true); $('exit').disabled=true; showError(''); $('progress-panel').hidden=false; $('status').textContent='工具已关闭'; $('current').textContent='可以关闭此页面；下次双击程序重新打开。';}
  catch (error) {showError(error.message);}
};
