const fs=require('fs'),vm=require('vm'),assert=require('assert');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.files=[];this.checked=false;this.value='';this._src='';this.srcWrites=0;}
 append(...elements){for(const e of elements){if(e.parent)e.parent.children=e.parent.children.filter(x=>x!==e);e.parent=this;this.children.push(e);}}
 replaceChildren(...elements){this.children=[];this.append(...elements);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this);}
 set src(value){this._src=value;this.srcWrites++;}get src(){return this._src;}
}
const ids=['files','output','extra','background','typography','selected','results','start','stop','continue','reset','exit','open','error','status','browser','progress','connection-code','copy-code','connection-message','aliyun-key-id','aliyun-key-secret','aliyun-save','aliyun-delete','aliyun-status','provider'];
const nodes=Object.fromEntries(ids.map(id=>[id,new Element(['start','stop','continue','exit','open'].includes(id)?'button':'div')]));
nodes.provider.value='doubao';
function all(root){return [root,...root.children.flatMap(all)];}
const revoked=[],created=[];const URLClass=URL;
URLClass.createObjectURL=file=>{const url='blob:local/'+created.length;created.push(url);return url;};URLClass.revokeObjectURL=url=>revoked.push(url);
let timers=0;const events={};
const snapshot={id:'job',status:'completed',message:'saved',browser_stage:'保存',items:[{index:0,name:'<img>.png',input_path:'D:/source.png',status:'completed',phase:'done',result:{output_path:'D:/result.png'}}]};
const requests=[];
const copied=[],warnings=[];
let configured=false;
const context={document:{getElementById:id=>nodes[id],createElement:tag=>new Element(tag),querySelectorAll:tag=>Object.values(nodes).flatMap(all).filter(e=>e.tag===tag)},location:{hash:'#token=secret',pathname:'/',origin:'http://127.0.0.1:54321'},navigator:{clipboard:{writeText:async text=>copied.push(text)}},sessionStorage:{getItem:()=>'',setItem:()=>{}},history:{replaceState:()=>{}},URL:URLClass,URLSearchParams,encodeURIComponent,FormData:class{constructor(){this.fields={};}append(k,v){this.fields[k]=v;}},snapshot,confirm:text=>{warnings.push(text);return true;},fetch:async(path,opts)=>{requests.push({path,body:opts.body,method:opts.method});if(path==='/api/aliyun/credentials'){if(opts.method==='POST')configured=true;if(opts.method==='DELETE')configured=false;return {ok:true,json:async()=>({aliyun_configured:configured,aliyun_price_per_image:0.06})};}return {ok:true,json:async()=>path==='/api/reset'?{id:null,status:'idle',items:[]}:snapshot};},setTimeout:()=>{timers++;},addEventListener:(name,fn)=>events[name]=fn,console};
context.window=context;
vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert.strictEqual(typeof nodes['aliyun-save'].onclick,'function','Credential configuration needs a save action');
 nodes['aliyun-key-id'].value='id';nodes['aliyun-key-secret'].value='secret-value';
 await nodes['aliyun-save'].onclick();
 assert.strictEqual(nodes['aliyun-key-secret'].value,'','Submitted Secret must be cleared');
 assert.ok(requests.some(r=>r.path==='/api/aliyun/credentials'&&r.body&&JSON.parse(r.body).access_key_secret==='secret-value'));
 assert.strictEqual(typeof nodes['aliyun-delete'].onclick,'function');
 assert.strictEqual(requests.filter(r=>r.path==='/api/jobs').length,0,'Saving keys must never submit paid images');
 nodes.provider.value='aliyun';nodes.files.files=[{name:'paid.png'}];vm.runInContext('render()',context);
 assert.strictEqual(nodes.start.disabled,false,'Configured provider permits start');
 context.confirm=()=>false;const beforePaid=requests.length;await nodes.start.onclick();assert.strictEqual(requests.length,beforePaid,'Declining paid consent must not start');
 context.confirm=text=>{warnings.push(text);return true;};await nodes.start.onclick();
 assert.strictEqual(requests.at(-1).body.fields.provider,'aliyun');assert.strictEqual(requests.at(-1).body.fields.paid_confirmed,'true');
 assert.ok(warnings.at(-1).includes('0.06')&&warnings.at(-1).includes('包装'));
 await nodes['aliyun-delete'].onclick();assert.strictEqual(nodes.start.disabled,true,'Deleting configuration prevents paid start');
 assert.ok(requests.some(r=>r.path==='/api/aliyun/credentials'&&r.method==='DELETE'));
 nodes.provider.value='doubao';nodes.files.files=[];vm.runInContext('render()',context);
 assert.strictEqual(nodes['connection-code'].value,'http://127.0.0.1:54321/#token=secret');
 await nodes['copy-code'].onclick();
 assert.deepStrictEqual(copied,['http://127.0.0.1:54321/#token=secret']);
 const initial=all(nodes.results).filter(e=>e.tag==='img');
 vm.runInContext('state=snapshot;render()',context);
 const next=all(nodes.results).filter(e=>e.tag==='img');
 assert.strictEqual(next[0],initial[0],'polling must retain original preview DOM');
 assert.strictEqual(next[1],initial[1],'polling must retain result preview DOM');
 assert.strictEqual(next[0].srcWrites,1,'unchanged preview URL must not be assigned again');
 context.snapshot.items[0].result.output_path='D:/new-result.png';vm.runInContext('render()',context);
 assert.strictEqual(next[1].srcWrites,2,'redo output must refresh same preview');
 const previousResult=snapshot.items[0].result;
 snapshot.items[0].result=null;vm.runInContext('render()',context);
 assert.strictEqual(all(nodes.results).filter(e=>e.tag==='img').length,1,'Regeneration must remove stale result preview');
 snapshot.items[0].result=previousResult;vm.runInContext('render()',context);
 nodes.files.files=[{name:'local.png'}];nodes.files.onchange();
 assert.ok(all(nodes.selected).some(e=>e.tag==='img'&&e.src.startsWith('blob:local/')),'selected file needs local blob thumbnail');
 nodes.files.files=[];nodes.files.onchange();assert.deepStrictEqual(revoked,created,'replaced selected thumbnails must release blob URLs');
 snapshot.status='paused';snapshot.items[0].status='paused';snapshot.items[0].phase='pending';
 vm.runInContext('render()',context);
 const regenerate=all(nodes.results).find(e=>e.tag==='button'&&e.textContent==='重新生成此图');
 assert.ok(regenerate,'Paused items need a distinct new-generation action');
 await regenerate.onclick();
 assert.strictEqual(JSON.parse(requests.at(-1).body).action,'redo','Regenerate must request a new submission');
 snapshot.provider='aliyun';await regenerate.onclick();assert.strictEqual(JSON.parse(requests.at(-1).body).paid_confirmed,true,'Paid redo needs renewed consent');
 context.confirm=()=>false;const beforeRedo=requests.length;await regenerate.onclick();assert.strictEqual(requests.length,beforeRedo);
 context.confirm=text=>{warnings.push(text);return true;};snapshot.provider='doubao';
 const resume=all(nodes.results).find(e=>e.tag==='button'&&e.textContent==='继续获取此图');
 assert.ok(resume,'Getting the existing result must be distinct from regeneration');
 await resume.onclick();
 assert.strictEqual(JSON.parse(requests.at(-1).body).action,'retry');
 assert.strictEqual(typeof nodes.reset.onclick,'function');
 await nodes.reset.onclick();
 assert.strictEqual(requests.at(-1).path,'/api/reset');
 assert.strictEqual(nodes.results.children.length,0,'Reset must clear old result cards');
 snapshot.items[0].input_path=null;snapshot.items[0].result=null;snapshot.items[0].phase='downloading';
 vm.runInContext('state=snapshot;render()',context);
 const downloading=all(nodes.results).find(e=>e.tag==='img');
 assert.strictEqual(downloading.srcWrites,0,'Downloading input must not request an absent preview');
 snapshot.items[0].input_path='D:/downloaded.png';snapshot.items[0].phase='ready';vm.runInContext('render()',context);
 assert.strictEqual(downloading.srcWrites,1,'Finished download must load original preview on the next poll');
 const before=timers;await nodes.exit.onclick();vm.runInContext('poll()',context);await new Promise(resolve=>setImmediate(resolve));
 assert.strictEqual(timers,before,'explicit close must stop polling');
 assert.ok(nodes.status.textContent.includes('清空任务'));
 console.log('UI behavior passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
