import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [code, recreateId] = process.argv.slice(2);
const { db } = await import(pathToFileURL(path.join(code, 'src/db/index.js')).href);
const ra = db.prepare('SELECT result_json FROM reaudits WHERE recreate_id = ? ORDER BY rowid DESC').get(recreateId);
const r = JSON.parse(ra.result_json);
for (const k of ['motion.clicks', 'motion.loops']) {
  const it = r.checklist.items.find((x) => x.key === k);
  console.log(k, JSON.stringify({ before: it.before?.detail, after: it.after?.detail, differences: (it.differences ?? it.after?.differences ?? []).slice(0, 8) }, null, 1));
}
console.log('motion summary', JSON.stringify(r.checklist.motion ?? r.motion ?? {}).slice(0, 1500));
