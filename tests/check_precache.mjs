// Every module the frontend imports must be in the service worker's precache list.
import { readFileSync, readdirSync } from 'node:fs';
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const listed = new Set([...sw.matchAll(/'\/js\/[\w/-]+\.js'/g)].map((m) => m[0].slice(1, -1)));
for (const v of sw.match(/\.\.\.\[([^\]]+)\]\.map\(\(v\) => `\/js\/views\/\$\{v\}\.js`\)/)[1].matchAll(/'(\w+)'/g)) listed.add(`/js/views/${v[1]}.js`);
const files = ['js', 'js/views'].flatMap((d) => readdirSync(new URL(`../web/${d}`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `/${d}/${f}`));
const missing = files.filter((f) => !listed.has(f));
if (missing.length) { console.log('NOT PRECACHED:', missing); process.exit(1); } console.log('precache list complete:', files.length, 'files');
