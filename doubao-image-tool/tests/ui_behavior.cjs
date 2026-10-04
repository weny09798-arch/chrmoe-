const fs=require('fs'),vm=require('vm'),assert=require('assert');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.files=[];this.checked=false;this.value='';this._src='';this.srcWrites=0;}
 append(...elements){for(const e of elements){if(e.parent)e.parent.children=e.parent.children.filter(x=>x!==e);e.parent=this;this.children.push(e);}}
 replaceChildren(...elements){this.children=[];this.append(...elements);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this);}
 set src(value){this._src=value;this.srcWrites++;}get src(){return this._src;}
}
const ids=['files','output','extra','background','typography','selected','results','start','stop','continue','exit','open','error','status','browser','progress'];
const nodes=Object.fromEntries(ids.map(id=>[id,new Element(['start','stop','continue','exit','open'].includes(id)?'button':'div')]));
function all(root){return [root,...root.children.flatMap(all)];}
const revoked=[],created=[];const URLClass=URL;
URLClass.createObjectURL=file=>{const url='blob:local/'+created.length;created.push(url);return url;};URLClass.revokeObjectURL=url=>revoked.push(url);
let timers=0;const events={};
const snapshot={id:'job',status:'completed',message:'saved',browser_stage:'保存',items:[{index:0,name:'<img>.png',status:'completed',phase:'done',result:{output_path:'D:/result.png'}}]};
const context={document:{getElementById:id=>nodes[id],createElement:tag=>new Element(tag),querySelectorAll:tag=>Object.values(nodes).flatMap(all).filter(e=>e.tag===tag)},location:{hash:'#token=secret',pathname:'/'},sessionStorage:{getItem:()=>'',setItem:()=>{}},history:{replaceState:()=>{}},URL:URLClass,URLSearchParams,encodeURIComponent,FormData:class{},snapshot,fetch:async()=>({ok:true,json:async()=>snapshot}),setTimeout:()=>{timers++;},addEventListener:(name,fn)=>events[name]=fn,console};
context.window=context;
vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 const initial=all(nodes.results).filter(e=>e.tag==='img');
 vm.runInContext('state=snapshot;render()',context);
 const next=all(nodes.results).filter(e=>e.tag==='img');
 assert.strictEqual(next[0],initial[0],'polling must retain original preview DOM');
 assert.strictEqual(next[1],initial[1],'polling must retain result preview DOM');
 assert.strictEqual(next[0].srcWrites,1,'unchanged preview URL must not be assigned again');
 context.snapshot.items[0].result.output_path='D:/new-result.png';vm.runInContext('render()',context);
 assert.strictEqual(next[1].srcWrites,2,'redo output must refresh same preview');
 nodes.files.files=[{name:'local.png'}];nodes.files.onchange();
 assert.ok(all(nodes.selected).some(e=>e.tag==='img'&&e.src.startsWith('blob:local/')),'selected file needs local blob thumbnail');
 nodes.files.files=[];nodes.files.onchange();assert.deepStrictEqual(revoked,created,'replaced selected thumbnails must release blob URLs');
 const before=timers;await nodes.exit.onclick();vm.runInContext('poll()',context);await new Promise(resolve=>setImmediate(resolve));
 assert.strictEqual(timers,before,'explicit close must stop polling');
 assert.ok(nodes.status.textContent.includes('已关闭'));
 console.log('UI behavior passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
