import {readFile,readdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
for(const file of [manifest.background.service_worker,...Object.values(manifest.icons),'manager.html','manager.mjs','manager.css','conversion-ui.mjs','lib/image-conversion.mjs','content.js','detail-pdd-ui.js','detail-content.js','vendor/xlsx.full.min.js','vendor/LICENSE-SheetJS.txt']) await access(path.join('extension',file));
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory()) await walk(file);else if(/\.(?:mjs|js)$/.test(file)){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0) throw new Error(result.stderr);}}}
await walk('extension');
if(manifest.manifest_version!==3) throw new Error('Expected Manifest V3');
console.log('Manifest assets and every extension JavaScript module verified.');
