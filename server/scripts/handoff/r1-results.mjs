// Prints what the validation runs produced: exact summary, stack, fidelity, motion rows of the re-audit.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const code = process.argv[2];
const ids = process.argv.slice(3);
const { db } = await import(pathToFileURL(path.join(code, 'src/db/index.js')).href);
const cols = db.prepare("PRAGMA table_info(recreates)").all().map((c) => c.name);
for (const id of ids) {
  const r = db.prepare('SELECT * FROM recreates WHERE id = ?').get(id);
  if (!r) { console.log(id, 'not found', cols); continue; }
  let rep = r.report_json ? JSON.parse(r.report_json) : null;
  if (!rep) rep = JSON.parse(await readFile(path.join(process.env.SAS_DATA_DIR, 'projects', r.project_id, 'recreate', id, 'report.json'), 'utf8').catch(() => 'null'));
  const ra = db.prepare('SELECT * FROM reaudits WHERE recreate_id = ? ORDER BY rowid DESC').get(id);
  const res = ra?.result_json ? JSON.parse(ra.result_json) : null;
  const motion = (res?.checklist?.items ?? []).filter((x) => x.category === 'motion').map((x) => `${x.key} ${x.status} ${JSON.stringify(x.after ?? '').slice(0, 80)}`);
  console.log(JSON.stringify({
    id, status: r.status, error: r.error ?? null, stack: rep?.stack, outputs: Object.fromEntries(Object.entries(rep?.outputs ?? {}).map(([k, v]) => [k, v?.status ?? v])),
    exact: rep?.exact?.summary ?? null, fidelity: rep?.fidelity?.score ?? null, diff: rep?.fidelity?.diff?.score ?? null,
    hover: rep?.generate?.motion?.hover ?? null, loops: rep?.generate?.motion?.loops ? { rebuilt: rep.generate.motion.loops.rebuilt, skipped: rep.generate.motion.loops.skipped } : null,
    visibility: rep?.visibility ? { checked: rep.visibility.checked, fixed: (rep.visibility.fixed ?? []).length, open: (rep.visibility.open ?? []).length } : null,
    reaudit: ra ? { status: ra.status, error: ra.error ?? null, motion } : null,
  }, null, 1));
}
