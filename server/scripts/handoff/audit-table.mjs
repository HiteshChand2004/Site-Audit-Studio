// node audit-table.mjs before.json after.json : the section -> element table, before vs after, as Markdown.
import { readFileSync } from 'node:fs';
const [b, a] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const yes = (v) => (v === true ? 'yes' : v === false ? 'no' : '-');
const click = (c) => {
  if (!c) return '-';
  if (c === 'link') return 'link';
  if (c.navigates) return 'navigates';
  if (c.error) return 'error';
  if (c.found === false) return 'missing';
  if (!c.changes) return 'nothing';
  return c.undone ? 'opens+closes' : 'opens';
};
const works = (o, c, kind) => {
  if (!c) return false;
  if (kind === 'hover') return o.hover !== true || c.hover === true;
  const oc = click(o.click);
  const cc = click(c.click);
  if (oc === 'nothing' || oc === '-' || oc === 'link' || oc === 'navigates') return true;
  return cc === oc;
};
for (const w of Object.keys(a)) {
  const rowsA = a[w].rows;
  const rowsB = new Map(b[w].rows.map((r) => [`${r.section}|${r.element}`, r]));
  console.log(`\n### ${w} px\n`);
  console.log('| Section | Element | Original | Copy before | Copy after | Status |');
  console.log('|---|---|---|---|---|---|');
  const counts = { fixed: 0, still: 0, worse: 0, ok: 0 };
  for (const r of rowsA) {
    const old = rowsB.get(`${r.section}|${r.element}`);
    let orig;
    let before;
    let after;
    let okB;
    let okA;
    if (r.element === '(section)') {
      orig = r.original.shown ? `shown, ${r.original.height}px` : 'hidden';
      const fmt = (c) => (c ? `${c.shown ? 'shown' : 'hidden'}, ${c.height}px, text ${c.textKept}%` : 'missing');
      before = fmt(old?.copy);
      after = fmt(r.copy);
      const ok = (c) => !!c && c.shown === r.original.shown && c.textKept >= 95;
      okB = ok(old?.copy);
      okA = ok(r.copy);
    } else if (r.element === '(moving elements)') {
      orig = `${r.original} moving`;
      before = old ? `${old.copy} moving` : '-';
      after = `${r.copy} moving`;
      const ok = (n) => n != null && n >= Math.max(1, r.original * 0.8);
      okB = old ? ok(old.copy) : null;
      okA = ok(r.copy);
      if (!r.original) { okB = true; okA = true; }
    } else {
      orig = `hover ${yes(r.original.hover)}, click ${click(r.original.click)}`;
      const fmt = (c) => (c ? `hover ${yes(c.hover)}, click ${click(c.click)}${c.cursor !== r.original.cursor ? `, cursor ${c.cursor}` : ''}` : 'missing');
      before = fmt(old?.copy);
      after = fmt(r.copy);
      const ok = (c) => !!c && works(r.original, c, 'hover') && works(r.original, c, 'click') && c.cursor === r.original.cursor;
      okB = old ? ok(old.copy) : null;
      okA = ok(r.copy);
    }
    const status = okA && okB === false ? 'FIXED' : okA ? 'ok' : okB === false ? 'still broken' : 'BROKE';
    if (status === 'FIXED') counts.fixed++;
    else if (status === 'ok') counts.ok++;
    else if (status === 'still broken') counts.still++;
    else counts.worse++;
    if (status === 'ok' && !process.argv.includes('--all')) continue;
    console.log(`| ${r.section.slice(0, 40)} | ${r.element.slice(0, 50)} | ${orig} | ${before} | ${after} | ${status} |`);
  }
  console.log(`\n${w} px: ${counts.ok} ok on both, ${counts.fixed} fixed, ${counts.still} still broken, ${counts.worse} broke`);
}
