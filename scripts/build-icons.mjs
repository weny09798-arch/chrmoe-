import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const sharp=require('C:/Users/yang2/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect x="2" y="2" width="124" height="124" rx="32" fill="#e8563c"/><rect x="27" y="28" width="50" height="59" rx="11" fill="none" stroke="white" stroke-width="7" opacity=".5"/><rect x="47" y="43" width="50" height="59" rx="11" fill="#e8563c" stroke="white" stroke-width="7"/><path d="m59 72 10 10 18-23" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
await mkdir('extension/icons',{recursive:true});
for(const size of [16,48,128]) await writeFile(`extension/icons/icon${size}.png`,await sharp(Buffer.from(svg)).resize(size,size).png().toBuffer());
console.log('Created 16/48/128px extension icons.');
