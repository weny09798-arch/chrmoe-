// Read-only pixel analysis of the supplied reference; does not alter the original file.
import { createRequire } from 'node:module';
import { fingerprint, similar } from '../extension/lib/fingerprint.mjs';
import { addCandidate, createTask, selected } from '../extension/lib/core.mjs';
import assert from 'node:assert/strict';
const sharp=createRequire(import.meta.url)('C:/Users/yang2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const source=process.argv[2];
if(!source) throw new Error('Pass the reference image path');
const left=await sharp(source).extract({left:16,top:7,width:571,height:571}).resize(32,32).ensureAlpha().raw().toBuffer();
const right=await sharp(source).extract({left:596,top:7,width:571,height:571}).resize(32,32).ensureAlpha().raw().toBuffer();
const a=fingerprint(left),b=fingerprint(right);
assert.ok(similar(a,b),'The supplied two main pictures should group together');
const job=createTask(['CCD数码相机']).jobs[0];
addCandidate(job,{id:'right-reference',cents:3200,title:'右侧相机',image:'reference-right',fingerprint:b});
addCandidate(job,{id:'left-reference',cents:2988,title:'左侧相机',image:'reference-left',fingerprint:a});
assert.equal(selected(job).length,1);
assert.equal(selected(job)[0].cents,2988);
console.log('Supplied screenshot: two main pictures group into one; ¥29.88 wins over ¥32.00.');
