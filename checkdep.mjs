import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('C:/Users/danru/Pokemon/dep.json', 'utf8'));
for (const x of d.slice(0, 3)) console.log(x.sha.slice(0, 7), x.created_at, x.environment);
