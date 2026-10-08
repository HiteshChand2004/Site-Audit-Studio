// The report as one self-contained HTML file: inline styles, inline images and inline SVG charts, no script and no
// external request, so it can be saved, e-mailed, opened offline, printed and turned into a PDF (report/pdf.js).
//
// A visual, dashboard-style report for a business reader, laid out as A4 sheets:
//   page 1  the website's logo and name, one verdict line, four score gauges (original vs copy), result tiles,
//           the two homepages side by side and at most three next steps;
//   page 2  the analytics: scores by device (grouped bars), the checklist outcome (donut), speed in everyday words
//           (bars against Google's "good" mark), the match with the original per page, and short lists of what was
//           fixed and what needs a person.
// A project that was never checked gets one page. Text stays short: one caption per chart, lists of at most six
// lines; every check, page and value is in the JSON download. Every value from the audit or the recreate goes
// through esc(): site names, titles and URLs come from the pages that were analysed.
import { AREAS, matchRating, plainName, rating } from './words.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const date = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
};
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const clip = (s, max = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** "a, b and c". */
const listWords = (items) => {
  const list = items.filter(Boolean);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
};
const seconds = (v) => (v == null ? '—' : v === 0 ? '0 s' : `${(v / 1000).toFixed(v < 1000 ? 2 : 1)} s`);
const bytes = (v) => (v == null ? '—' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${num(Math.round(v / 1024))} KB`);
const signed = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0');
const f1 = (v) => Number(v.toFixed(1));
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url ?? '');
  }
};

// Chart colours: the app's theme (orange accent for the copy, slate grey for the original) and status colours,
// which always come with a word.
const C = {
  copy: '#c2410c',
  orig: '#a3acbb',
  track: '#eef1f5',
  grid: '#e4e7ec',
  ink: '#101828',
  ink2: '#344054',
  muted: '#667085',
  ok: '#067647',
  okSoft: '#5fb98c',
  warn: '#d97706',
  bad: '#b42318',
  info: '#175cd3',
  pass: '#c5ccd6',
};

// ---- What the report knows ----------------------------------------------------------------------------------------

/** The parts of the data the report uses, and which state the project is in. */
function facts(d) {
  const a = d.analyzed ? d.audit : null;
  const r = a ? d.recreate ?? null : null;
  const cs = a ? a.recreate ?? null : null;
  const c = cs && !cs.isDummy && Array.isArray(cs.items) ? cs : null;
  const checks = a
    ? [
        ...(a.seo ?? []),
        ...(a.aeo ?? []),
        ...[['sitemap.xml', a.crawl?.sitemap], ['robots.txt', a.crawl?.robots], ['Meta tags', a.crawl?.metaTags]].filter(([, v]) => v?.status).map(([title, v]) => ({ title, status: v.status, detail: v.detail })),
      ]
    : [];
  const before = c?.scores?.before ?? a?.scores ?? null;
  const after = c?.scores?.after ?? null;
  const mBefore = c?.metrics?.before ?? a?.metricsByDevice ?? null;
  const mAfter = c?.metrics?.after ?? null;
  const state = !a ? 'none' : c ? 'full' : r ? 'copied' : 'checked';
  return { a, r, c, cs, checks, before, after, mBefore, mAfter, state, logo: d.images?.logo ?? null };
}

/** Better / Same / Worse for two scores: within 2 points counts as the same (scores vary a little run to run). */
function change(b, a) {
  if (b == null || a == null) return null;
  const d = a - b;
  if (d >= 3) return { label: 'Better', tone: 'ok', d };
  if (d <= -3) return { label: 'Worse', tone: 'bad', d };
  return { label: 'Same', tone: 'none', d };
}

/** Manual items of the original and the copy, equal ones (same kind and reason) merged into one line. */
function manualGroups(a, r) {
  const groups = new Map();
  for (const m of [...(a?.manualRebuild ?? []), ...(r?.manual ?? [])]) {
    const key = `${m.kind}|${m.detail}`;
    const g = groups.get(key) ?? { kind: m.kind, detail: m.detail, titles: [] };
    if (!g.titles.includes(m.title)) g.titles.push(m.title);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    title: g.titles.length > 1 ? (g.kind === 'form' ? `Forms on ${plural(g.titles.length, 'page')} need a backend` : `${g.titles[0]} (and ${g.titles.length - 1} similar)`) : g.titles[0],
  }));
}

/** Problems the check found on the original, worst first: { name, detail, tone }. */
function originalIssues(f) {
  const { a } = f;
  const out = [];
  for (const x of f.checks) if (x.status !== 'pass') out.push({ name: plainName(x).name, detail: x.detail, tone: x.status === 'fail' ? 'bad' : 'warn', rank: x.status === 'fail' ? 0 : 2 });
  for (const x of a.accessibility ?? []) {
    const serious = ['critical', 'serious'].includes(x.impact);
    out.push({ name: plainName(x).name, detail: x.count ? `${plural(x.count, 'place')} on the homepage` : '', tone: serious ? 'bad' : 'warn', rank: serious ? 1 : 3 });
  }
  const broken = a.brokenLinks?.broken?.length ?? 0;
  if (broken) out.push({ name: 'Dead links', detail: `${plural(broken, 'link')} lead nowhere`, tone: 'bad', rank: 0 });
  for (const w of a.weaknesses ?? []) out.push({ name: plainName(w).name, detail: '', tone: w.severity === 'high' ? 'bad' : 'warn', rank: w.severity === 'high' ? 1 : 4 });
  return out.sort((x, y) => x.rank - y.rank);
}

const CATEGORY_ORDER = ['accessibility', 'seo', 'aeo', 'links', 'crawl', 'performance', 'platform', 'motion', 'best-practices'];
/** Fixed and improved checks of the comparison, the ones a visitor notices first. */
function fixedItems(c) {
  const rank = (i) => (CATEGORY_ORDER.indexOf(i.category) + 1 || 99) * 2 + (i.status === 'improved' ? 1 : 0);
  return c.items.filter((i) => i.status === 'fixed' || i.status === 'improved').sort((x, y) => rank(x) - rank(y));
}

// ---- Words: the verdict and the next steps ------------------------------------------------------------------------

const BETTER = { performance: 'faster', seo: 'easier to find on Google', accessibility: 'more accessible', bestPractices: 'more modern' };
const WORSE = { performance: 'slower', seo: 'harder to find on Google', accessibility: 'less accessible', bestPractices: 'less up to date' };
const STRONG = { performance: 'fast', seo: 'easy to find on Google', accessibility: 'easy for everyone to use', bestPractices: 'safe and modern' };
const WEAK = { performance: 'speed', seo: 'Google visibility', accessibility: 'accessibility', bestPractices: 'modern standards' };

/** One line, about twenty words: where the site stands, or what the copy achieved. */
function verdict(f) {
  const { a, r, c, before, after } = f;
  if (!a) return 'This website has not been checked yet.';
  if (c && after) {
    const better = [];
    const worse = [];
    for (const area of AREAS) {
      const p = change(before?.mobile?.[area.id], after?.mobile?.[area.id]);
      const k = change(before?.desktop?.[area.id], after?.desktop?.[area.id]);
      const tones = [p?.tone, k?.tone];
      if (tones.includes('bad')) worse.push(WORSE[area.id] + (p?.tone === 'bad' && k?.tone !== 'bad' ? ' on phones' : k?.tone === 'bad' && p?.tone !== 'bad' ? ' on computers' : ''));
      else if (tones.includes('ok')) better.push(BETTER[area.id]);
    }
    const s = c.summary ?? {};
    const fixed = (s.fixed ?? 0) + (s.improved ?? 0);
    const head = better.length ? `The copy is ${listWords(better)}` : 'The copy scores about the same as the original';
    const fixes = fixed ? `${better.length > 1 ? ',' : ''} and fixes ${plural(fixed, 'problem')}` : '';
    const buts = [worse.length && `is ${listWords(worse)}`, s.regressed && `${plural(s.regressed, 'check')} got worse`].filter(Boolean);
    return `${head}${fixes}${buts.length ? `, but ${buts.join(' and ')}` : ''}.`;
  }
  if (r) {
    const m = r.fidelity?.score;
    return `A copy of ${plural(r.pages?.length ?? 0, 'page')} was made${m != null ? ` and matches the original ${m}%` : ''}; it has not been compared check by check yet.`;
  }
  const good = AREAS.filter((x) => rating(before?.mobile?.[x.id]).tone === 'ok').map((x) => STRONG[x.id]);
  const work = AREAS.filter((x) => ['warn', 'bad'].includes(rating(before?.mobile?.[x.id]).tone)).map((x) => WEAK[x.id]);
  const n = originalIssues(f).length;
  const head = good.length ? `The site is ${listWords(good)}${work.length ? `, but needs work on ${listWords(work)}` : ''}` : `The site needs work on ${listWords(work) || 'every area'}`;
  return `${head}; ${plural(n, 'thing')} to improve.`;
}

/** The small line under the verdict: what was measured. */
function subline(f) {
  const { a, r } = f;
  if (!a) return '';
  const parts = [`Checked on ${date(a.analyzedAt)} across ${plural(a.pagesCrawled ?? 0, 'page')}`];
  if (r) parts.push(`copy of ${plural(r.pages?.length ?? 0, 'page')} made on ${date(r.createdAt)}`);
  if (f.c?.reauditedAt) parts.push(`compared on ${date(f.c.reauditedAt)}`);
  return `${parts.join(' · ')}.`;
}

/** At most three next steps, most important first. */
function nextSteps(f) {
  const { a, r, c, cs } = f;
  if (!a) return ['Check the site (step 1 in the app): a few minutes, and it finds speed, Google and accessibility problems.', 'Create the copy (step 2): it fixes many of those problems by itself.', 'Compare the copy with the original (step 3) and download this report again.'];
  const steps = [];
  if (!r) steps.push('Create the copy (step 2 in the app): it fixes many of the problems found here by itself.');
  else if (!c) steps.push(cs?.status === 'running' || cs?.status === 'queued' ? 'The comparison with the original is running; download the report again when it has finished.' : 'Compare the copy with the original (Re-audit in the app) to see what got better.');
  else {
    if (c.stale) steps.push('Compare again: the copy changed after this comparison was made.');
    const worse = c.items.filter((i) => i.status === 'regressed');
    if (worse.length) steps.push(`Look at the ${plural(worse.length, 'check')} that got worse: ${listWords(worse.slice(0, 3).map((i) => plainName(i).name.toLowerCase()))}.`);
  }
  const manual = manualGroups(a, r);
  if (manual.length) steps.push(`Rebuild by hand what cannot be copied automatically (${plural(manual.length, 'item')}, listed on page 2).`);
  const open = c?.summary?.open ?? 0;
  if (open) steps.push(`Work through the ${plural(open, 'check')} that still ${open === 1 ? 'needs' : 'need'} work.`);
  if (!steps.length) steps.push('Nothing urgent: put the copy online and check its speed again there.');
  return steps.slice(0, 3);
}

// ---- Charts (inline SVG, no script) ---------------------------------------------------------------------------------

const arcPoint = (cx, cy, r, deg) => [f1(cx + r * Math.cos((deg * Math.PI) / 180)), f1(cy + r * Math.sin((deg * Math.PI) / 180))];
/** A 270° arc from the bottom left over the top to the bottom right, as a path whose length counts as 100. */
const arc = (cx, cy, r) => {
  const [x0, y0] = arcPoint(cx, cy, r, 135);
  const [x1, y1] = arcPoint(cx, cy, r, 45);
  return `M${x0} ${y0}A${r} ${r} 0 1 1 ${x1} ${y1}`;
};
const ringValue = (d, v, color, width) =>
  v > 0 ? `<path d="${d}" pathLength="100" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${f1(Math.min(100, v))} 200"/>` : '';

/** A score gauge: the copy as the outer orange ring, the original as the inner grey ring (or one ring alone). */
function gauge(area, f) {
  const b = f.before?.mobile?.[area.id] ?? null;
  const a = f.after?.mobile?.[area.id] ?? null;
  const both = f.state === 'full';
  const shown = both ? a : b;
  const outer = arc(70, 68, 54);
  const inner = arc(70, 68, 41);
  const [tx0, ty0] = arcPoint(70, 68, 60, 135 + 2.7 * 90);
  const [tx1, ty1] = arcPoint(70, 68, 68, 135 + 2.7 * 90);
  const svg = `<svg class="gauge" viewBox="0 0 140 122" aria-hidden="true">
<path d="${outer}" fill="none" stroke="${C.track}" stroke-width="11" stroke-linecap="round"/>
${ringValue(outer, shown, C.copy, 11)}
${both ? `<path d="${inner}" fill="none" stroke="${C.track}" stroke-width="6" stroke-linecap="round"/>${ringValue(inner, b, C.orig, 6)}` : ''}
<line x1="${tx0}" y1="${ty0}" x2="${tx1}" y2="${ty1}" stroke="${C.ok}" stroke-width="2.2" stroke-linecap="round"/>
<text x="70" y="76" text-anchor="middle" class="g-num">${shown == null ? '—' : shown}</text>
<text x="70" y="94" text-anchor="middle" class="g-of">of 100</text>
</svg>`;
  const ch = both ? change(b, a) : null;
  const rate = rating(shown);
  const line = both
    ? `<span class="chg ${ch?.tone ?? 'none'}">${ch ? `${signed(ch.d)} ${ch.label}` : 'Not measured'}</span><span class="was">Original ${b ?? '—'}</span>`
    : `<span class="chg ${rate.tone}">${esc(rate.label)}</span>`;
  const kb = f.before?.desktop?.[area.id];
  const ka = f.after?.desktop?.[area.id];
  const desk = both ? (kb != null || ka != null ? `Computer ${kb ?? '—'} → ${ka ?? '—'}` : '') : kb != null ? `Computer ${kb}` : '';
  return `<div class="g-cell">${svg}<div class="g-title">${esc(area.title)}</div><div class="g-line">${line}</div>${desk ? `<div class="g-desk">${desk}</div>` : ''}</div>`;
}

/** Scores by device: grouped bars per area, original (grey) next to the copy (orange), values on the bars. */
function scoresChart(f) {
  const both = f.state === 'full';
  const W = 660;
  const L = 30;
  const R = 652;
  const T = 16;
  const B = 172;
  const y = (v) => f1(B - (Math.max(0, Math.min(100, v)) / 100) * (B - T));
  const out = [];
  for (const g of [0, 50, 90, 100]) {
    out.push(`<line x1="${L}" x2="${R}" y1="${y(g)}" y2="${y(g)}" stroke="${g === 0 ? C.ink2 : C.grid}" stroke-width="${g === 0 ? 1 : 0.8}"${g === 90 ? ' stroke-dasharray="3 3"' : ''}/>`);
    out.push(`<text x="${L - 6}" y="${y(g) + 3}" text-anchor="end" class="ax">${g}</text>`);
  }
  const gw = (R - L) / AREAS.length;
  const bar = (x, w, v, color, label) => {
    if (v == null) return `<text x="${f1(x + w / 2)}" y="${B - 4}" text-anchor="middle" class="ax">—</text>`;
    const top = y(v);
    const h = B - top;
    const r = Math.min(3, h);
    return `<path d="M${f1(x)} ${B}V${f1(top + r)}Q${f1(x)} ${top} ${f1(x + r)} ${top}H${f1(x + w - r)}Q${f1(x + w)} ${top} ${f1(x + w)} ${f1(top + r)}V${B}Z" fill="${color}"/><text x="${f1(x + w / 2)}" y="${f1(top - 4)}" text-anchor="middle" class="${label}">${v}</text>`;
  };
  AREAS.forEach((area, i) => {
    const gx = L + i * gw;
    if (i) out.push(`<line x1="${f1(gx)}" x2="${f1(gx)}" y1="${T}" y2="${B + 34}" stroke="${C.grid}" stroke-width="0.8"/>`);
    ['mobile', 'desktop'].forEach((dev, j) => {
      const cx = gx + gw * (j === 0 ? 0.3 : 0.7);
      const b = f.before?.[dev]?.[area.id] ?? null;
      if (both) {
        out.push(bar(cx - 21, 20, b, C.orig, 'v-o'));
        out.push(bar(cx + 1, 20, f.after?.[dev]?.[area.id] ?? null, C.copy, 'v-n'));
      } else {
        out.push(bar(cx - 13, 26, b, C.copy, 'v-n'));
      }
      out.push(`<text x="${f1(cx)}" y="${B + 13}" text-anchor="middle" class="ax">${dev === 'mobile' ? 'Phone' : 'Computer'}</text>`);
    });
    out.push(`<text x="${f1(gx + gw / 2)}" y="${B + 30}" text-anchor="middle" class="ax-h">${esc(area.title)}</text>`);
  });
  return `<svg class="chart" viewBox="0 0 ${W} 210" aria-hidden="true">${out.join('')}</svg>`;
}

/** A donut of counts with a legend: [{ label, value, color, keep? }]. */
function donut(parts, centreLabel) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((s, p) => s + p.value, 0);
  const gap = shown.length > 1 ? 0.9 : 0;
  let start = 0;
  const segs = shown.map((p) => {
    const len = (p.value / total) * 100;
    const seg = `<circle cx="70" cy="70" r="54" fill="none" stroke="${p.color}" stroke-width="20" pathLength="100" stroke-dasharray="${f1(Math.max(0.1, len - gap))} ${f1(100 - len + gap)}" stroke-dashoffset="${f1(-start)}" transform="rotate(-90 70 70)"/>`;
    start += len;
    return seg;
  });
  const svg = `<svg class="donut" viewBox="0 0 140 140" aria-hidden="true"><circle cx="70" cy="70" r="54" fill="none" stroke="${C.track}" stroke-width="20"/>${segs.join('')}<text x="70" y="75" text-anchor="middle" class="d-num">${num(total)}</text><text x="70" y="91" text-anchor="middle" class="d-of">${esc(centreLabel)}</text></svg>`;
  const legend = parts
    .filter((p) => p.value > 0 || p.keep)
    .map((p) => `<li><i style="background:${p.color}"></i><span>${esc(p.label)}</span><b>${num(p.value)}</b><em>${total ? Math.round((p.value / total) * 100) : 0}%</em></li>`)
    .join('');
  return `<div class="donut-wrap">${svg}<ul class="legend">${legend}</ul></div>`;
}

const SPEED = [
  { key: 'lcp', title: 'Main content shows in', good: 2500, goodText: 'Good ≤ 2.5 s', fmt: seconds },
  { key: 'loadTime', title: 'Ready to use in', good: 3800, goodText: 'Good ≤ 3.8 s', fmt: seconds },
  { key: 'tbt', title: 'Page freezes for', good: 200, goodText: 'Good ≤ 0.2 s', fmt: seconds, onlyWhen: 50 },
  { key: 'pageSize', title: 'Page weight', good: null, goodText: 'Lighter is better', fmt: bytes },
];

/** Speed in everyday words: each measurement on its own scale, bars against Google's "good" mark. */
function speedChart(f) {
  const dev = f.mBefore?.mobile ? 'mobile' : 'desktop';
  const b = f.mBefore?.[dev] ?? {};
  const a = f.state === 'full' ? f.mAfter?.[dev] ?? null : null;
  const rows = SPEED.filter((m) => b[m.key] != null || a?.[m.key] != null).filter((m) => !m.onlyWhen || Math.max(b[m.key] ?? 0, a?.[m.key] ?? 0) >= m.onlyWhen);
  const W = 250;
  const body = rows.map((m) => {
    const vals = [b[m.key], a?.[m.key]].filter((v) => v != null);
    // The scale leaves room past Google's mark (and, for the original alone, 2 MB for weight), so one bar alone still says whether it is good.
    const max = Math.max(...vals, (m.good ?? 0) * 1.6, !a && m.key === 'pageSize' ? 2097152 : 0) * 1.08 || 1;
    const x = (v) => f1((v / max) * (W - 54));
    const barRow = (v, yy, color, cls) => (v == null ? '' : `<rect x="0" y="${yy}" width="${Math.max(2, x(v))}" height="11" rx="2.5" fill="${color}"/><text x="${Math.max(2, x(v)) + 5}" y="${yy + 9}" class="${cls}">${esc(m.fmt(v))}</text>`);
    const parts = a ? [barRow(b[m.key], 3, C.orig, 'v-o'), barRow(a[m.key], 17, C.copy, 'v-n')] : [barRow(b[m.key], 10, C.copy, 'v-n')];
    const mark = m.good ? `<line x1="${x(m.good)}" x2="${x(m.good)}" y1="0" y2="31" stroke="${C.ok}" stroke-width="1.2" stroke-dasharray="2.5 2"/>` : '';
    return `<div class="sp-row"><div class="sp-lab"><b>${esc(m.title)}</b><small>${esc(m.goodText)}</small></div><svg viewBox="0 0 ${W} 32" class="sp-svg" aria-hidden="true">${mark}${parts.join('')}</svg></div>`;
  });
  return { html: body.join(''), device: dev === 'mobile' ? 'a phone' : 'a computer' };
}

/** Match with the original per page (horizontal bars with the target mark), or a distribution for many pages. */
function matchChart(r) {
  const pages = (r.fidelity?.pages ?? []).filter((p) => Number.isFinite(p.score));
  const threshold = r.fidelity?.threshold ?? 80;
  if (!pages.length) return '';
  const W = 380;
  if (pages.length <= 11) {
    const sorted = [...pages].sort((x, y) => y.score - x.score);
    const L = 150;
    const x = (v) => f1(L + (v / 100) * (W - L - 34));
    const rowH = 19;
    const H = sorted.length * rowH + 22;
    const out = [];
    sorted.forEach((p, i) => {
      const yy = 6 + i * rowH;
      const label = p.path === '/' ? 'Homepage' : clip(p.path, 26);
      const low = p.score < threshold;
      out.push(`<text x="${L - 8}" y="${yy + 10}" text-anchor="end" class="ax-p">${esc(label)}</text>`);
      out.push(`<rect x="${L}" y="${yy + 1}" width="${f1(x(100) - L)}" height="12" rx="2.5" fill="${C.track}"/>`);
      out.push(`<rect x="${L}" y="${yy + 1}" width="${f1(x(p.score) - L)}" height="12" rx="2.5" fill="${low ? C.warn : C.copy}"/>`);
      out.push(`<text x="${x(100) + 5}" y="${yy + 10}" class="v-n">${p.score}${low ? ' low' : ''}</text>`);
    });
    out.push(`<line x1="${x(threshold)}" x2="${x(threshold)}" y1="4" y2="${H - 16}" stroke="${C.ok}" stroke-width="1.2" stroke-dasharray="2.5 2"/>`, `<text x="${x(threshold)}" y="${H - 4}" text-anchor="middle" class="ax good">Target ${threshold}</text>`);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" aria-hidden="true">${out.join('')}</svg>`;
  }
  // Many pages: how many pages fall in each band of match.
  const bands = [
    { label: '95–100', min: 95, max: 101 },
    { label: '90–94', min: 90, max: 95 },
    { label: '85–89', min: 85, max: 90 },
    { label: '80–84', min: 80, max: 85 },
    { label: '65–79', min: 65, max: 80 },
    { label: 'below 65', min: -1, max: 65 },
  ].map((band) => ({ ...band, n: pages.filter((p) => p.score >= band.min && p.score < band.max).length }));
  const max = Math.max(...bands.map((x) => x.n), 1);
  const L = 70;
  const rowH = 24;
  const x = (n) => f1((n / max) * (W - L - 64));
  const out = bands.map((band, i) => {
    const yy = 4 + i * rowH;
    const color = band.min >= threshold ? C.copy : C.warn;
    const w = band.n ? Math.max(3, x(band.n)) : 0;
    return `<text x="${L - 8}" y="${yy + 12}" text-anchor="end" class="ax-p">${band.label}</text><rect x="${L}" y="${yy + 2}" width="${f1(W - L - 64)}" height="14" rx="2.5" fill="${C.track}"/>${w ? `<rect x="${L}" y="${yy + 2}" width="${w}" height="14" rx="2.5" fill="${color}"/>` : ''}<text x="${f1(W - 58)}" y="${yy + 12}" class="v-n">${plural(band.n, 'page')}</text>`;
  });
  const worst = [...pages].sort((p, q) => p.score - q.score)[0];
  return `<svg class="chart" viewBox="0 0 ${W} ${bands.length * rowH + 6}" aria-hidden="true">${out.join('')}</svg><p class="note">Lowest: ${esc(worst.path === '/' ? 'the homepage' : clip(worst.path, 40))} at ${worst.score}. Target ${threshold}.</p>`;
}

// ---- Building blocks --------------------------------------------------------------------------------------------

const logoTile = (f, name, cls = 'logo') =>
  typeof f.logo === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(f.logo)
    ? `<span class="${cls}"><img src="${esc(f.logo)}" alt=""></span>`
    : `<span class="${cls} mono">${esc((String(name || '?').replace(/^www\./i, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase())}</span>`;

const card = (eyebrow, title, caption, body, cls = '') =>
  `<section class="card ${cls}"><header><div><p class="eyebrow">${esc(eyebrow)}</p><h3>${esc(title)}</h3></div></header>${caption ? `<p class="cap">${caption}</p>` : ''}${body}</section>`;

const legendKey = (f) =>
  f.state === 'full'
    ? `<div class="key"><span><i class="sw copy"></i>Copy</span><span><i class="sw orig"></i>Original</span></div>`
    : `<div class="key"><span><i class="sw copy"></i>Original site</span></div>`;

const tile = (value, label, tone, note = '') =>
  `<div class="tile"><div class="t-val">${value}</div><div class="t-lab">${tone ? `<i class="dot ${tone}"></i>` : ''}${esc(label)}</div>${note ? `<div class="t-note">${note}</div>` : ''}</div>`;

function tiles(f) {
  const { a, r, c } = f;
  const manual = manualGroups(a, r).length;
  const match = r?.fidelity?.score;
  const matchTile = r ? tile(match == null ? '—' : `${match}<small>%</small>`, 'Match with the original', '', esc(matchRating(match).label)) : '';
  if (f.state === 'full') {
    const s = c.summary ?? {};
    return [
      tile(num((s.fixed ?? 0) + (s.improved ?? 0)), 'Fixed or better', 'ok', s.improved ? `${num(s.improved)} of them improved` : 'problems of the original'),
      tile(num(s.open ?? 0), 'Still needs work', 'warn', 'same as the original'),
      tile(num(s.regressed ?? 0), 'Got worse', 'bad', s.regressed ? 'worth a look' : 'nothing got worse'),
      tile(num(s.manual ?? manual), 'Needs a person', 'info', 'cannot be automated'),
      matchTile,
    ].join('');
  }
  if (f.state === 'copied') {
    const fixes = (r.fixes ?? []).filter((x) => x.status !== 'open');
    return [
      tile(num(r.pages?.length ?? 0), 'Pages copied', '', `of ${plural(a.pagesCrawled ?? 0, 'page')} checked`),
      tile(num(fixes.length), 'Kinds of fixes applied', 'ok', 'by the copy, automatically'),
      tile(num(manual), 'Needs a person', 'info', 'cannot be automated'),
      matchTile,
    ].join('');
  }
  const issues = originalIssues(f);
  const a11y = (a.accessibility ?? []).reduce((s, x) => s + (x.count ?? 1), 0);
  const broken = a.brokenLinks?.broken?.length ?? 0;
  return [
    tile(num(a.pagesCrawled ?? 0), 'Pages checked', '', 'read by the check'),
    tile(num(issues.length), 'Things to improve', 'warn', `${num(issues.filter((x) => x.tone === 'bad').length)} important`),
    tile(num(a11y), 'Accessibility issues', a11y ? 'bad' : 'ok', 'on the homepage'),
    tile(num(broken), 'Dead links', broken ? 'bad' : 'ok', `of ${num(a.brokenLinks?.checked ?? 0)} checked`),
    tile(num(manual), 'Needs a person', 'info', 'cannot be automated'),
  ].join('');
}

function shots(d, f) {
  const frame = (img, phone, label, sub) => `<figure class="shot">
<figcaption><b>${esc(label)}</b><span>${esc(sub)}</span></figcaption>
<div class="stage"><div class="browser"><div class="bar"><i></i><i></i><i></i></div>${img ? `<img src="${esc(img)}" alt="">` : '<div class="noimg">No picture</div>'}</div>${phone ? `<div class="phone"><img src="${esc(phone)}" alt=""></div>` : ''}</div>
</figure>`;
  const old = d.images?.old ?? {};
  const neu = d.images?.new ?? {};
  if (!old.desktop && !neu.desktop) return '';
  const items = [frame(old.desktop, old.mobile, 'Original', hostOf(d.project.url))];
  if (f.r) items.push(frame(neu.desktop, neu.mobile, 'Copy', plural(f.r.pages?.length ?? 0, 'page') + ' rebuilt'));
  return `<div class="shots ${items.length === 1 ? 'one' : ''}">${items.join('')}</div>`;
}

const listBlock = (items, empty = '') =>
  items.length ? `<ul class="items">${items.join('')}</ul>` : empty ? `<p class="empty">${empty}</p>` : '';
const itemLine = (mark, tone, name, detailText = '') =>
  `<li><i class="mk ${tone}" aria-hidden="true">${mark}</i><span><b>${esc(name)}</b>${detailText ? `<small>${esc(detailText)}</small>` : ''}</span></li>`;

// ---- Pages ------------------------------------------------------------------------------------------------------

const footer = (d, n, total) => `<footer class="foot-line"><span>${esc(d.project.name || hostOf(d.project.url))} · Website report · ${esc(date(d.generatedAt))}</span><span>Page ${n} of ${total}</span></footer>`;

function cover(d, f, total) {
  const host = hostOf(d.project.url);
  const band = `<header class="band">
<div class="brand">${logoTile(f, d.project.name || host)}<div><h1>${esc(d.project.name || host)}</h1><p class="addr">${esc(d.project.url)}</p></div></div>
<div class="meta"><p class="kicker">Website report</p><p>${esc(date(d.generatedAt))}</p></div>
</header>`;
  const next = `<section class="nextbox${f.a ? '' : ' flat'}"><p class="eyebrow">What to do next</p><ol class="next">${nextSteps(f).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>`;
  if (!f.a) {
    const steps = [['Check the site', 'Speed, Google and accessibility scores'], ['Create the copy', 'A faster copy with many problems fixed'], ['Compare', 'What got better, check by check']];
    return `${band}<div class="body" id="summary">
<p class="verdict">${esc(verdict(f))}</p>
<p class="sub">There is nothing to measure yet. Three steps in the app fill this report with scores, charts and results.</p>
<ol class="track">${steps.map(([s, what], i) => `<li><span class="n">${i + 1}</span><b>${esc(s)}</b><small>${esc(what)}</small><em>Not yet</em></li>`).join('')}</ol>
${next}
</div>${footer(d, 1, total)}`;
  }
  return `${band}<div class="body" id="summary">
<p class="verdict">${esc(verdict(f))}</p>
<p class="sub">${esc(subline(f))}</p>
<section class="card gauges" id="scores"><header><div><p class="eyebrow">Health scores on a phone</p><h3>${f.state === 'full' ? 'Original and copy, out of 100' : 'The original site, out of 100'}</h3></div>${legendKey(f)}</header>
<div class="g-row">${AREAS.map((x) => gauge(x, f)).join('')}</div>
<p class="cap foot">Google looks at phones first. The green tick on each dial marks “good” (90).${f.state === 'full' ? ' Outer ring: the copy; inner ring: the original.' : f.state === 'copied' ? ' The copy gets its own scores once it is compared (Re-audit).' : ''}</p></section>
<div class="tiles">${tiles(f)}</div>
${f.r ? `${shots(d, f)}${next}` : `<div class="duo">${shots(d, f)}${next}</div>`}
</div>${footer(d, 1, total)}`;
}

function analytics(d, f, pageNo, total) {
  const { a, r, c } = f;
  const blocks = [];
  blocks.push(card('Scores', f.state === 'full' ? 'Every score, original next to copy' : 'Every score of the original', 'Lighthouse scores on a phone and a computer, out of 100. The dashed line marks “good” (90).', `${legendKey(f)}${scoresChart(f)}`, 'wide'));

  let donutCard;
  if (c) {
    const s = c.summary ?? {};
    const parts = [
      { label: 'Fixed', value: s.fixed ?? 0, color: C.ok, keep: true },
      { label: 'Better', value: s.improved ?? 0, color: C.okSoft },
      { label: 'Fine on both', value: s.pass ?? 0, color: C.pass },
      { label: 'Still needs work', value: s.open ?? 0, color: C.warn, keep: true },
      { label: 'Got worse', value: s.regressed ?? 0, color: C.bad, keep: true },
      { label: 'Needs a person', value: s.manual ?? 0, color: C.info },
    ];
    donutCard = card('Checklist', 'How every check turned out', 'Each check of the original, run again on the copy.', donut(parts, 'checks'));
  } else {
    const count = (st) => f.checks.filter((x) => x.status === st).length;
    const parts = [
      { label: 'Fine', value: count('pass'), color: C.ok, keep: true },
      { label: 'Worth fixing', value: count('warn'), color: C.warn, keep: true },
      { label: 'Problem', value: count('fail'), color: C.bad, keep: true },
    ];
    donutCard = card('Checks', 'Google, AI and site files', 'Titles, descriptions, headings, site map and AI readiness.', donut(parts, 'checks'));
  }
  const sp = speedChart(f);
  const speedCard = card('Speed', 'How fast the homepage loads', `Measured on ${sp.device}. Dashed green line: Google’s “good” mark.${f.state === 'full' ? ' Grey original, orange copy.' : ''}`, `<div class="speed">${sp.html || '<p class="empty">Speed was not measured.</p>'}</div>`);
  blocks.push(`<div class="row two">${donutCard}${speedCard}</div>`);

  const manual = manualGroups(a, r).slice(0, 4).map((m) => itemLine('→', 'info', clip(m.title, 70)));
  const lists = [];
  let left;
  const match = r ? matchChart(r) : '';
  if (match) {
    const pagesN = r.fidelity?.pages?.length ?? 0;
    left = card('Match', 'How close the copy looks', `${pagesN > 11 ? `${plural(pagesN, 'page')} grouped by how closely each matches the original` : 'Each copied page compared with the original'}, out of 100.`, match);
  } else {
    const top = originalIssues(f).slice(0, 6).map((x) => itemLine(x.tone === 'bad' ? '!' : '·', x.tone, clip(x.name, 60), clip(x.detail, 70)));
    left = card('To improve', 'The most important problems', 'Found by the check; the copy fixes many of them by itself.', listBlock(top, 'No problems found.'));
  }
  if (c) {
    const all = fixedItems(c);
    const shown = all.slice(0, 6).map((i) => itemLine('✓', 'ok', clip(plainName(i).name, 60), i.status === 'improved' ? 'better, not yet perfect' : ''));
    if (shown.length) lists.push(card('What was fixed', `${plural(all.length, 'check')} fixed or better`, '', `${listBlock(shown)}${all.length > 6 ? `<p class="more">and ${num(all.length - 6)} more</p>` : ''}`));
  } else if (r) {
    const fixes = (r.fixes ?? []).filter((x) => x.status !== 'open');
    const shown = fixes.slice(0, 6).map((x) => itemLine('✓', 'ok', clip(String(x.title ?? '').split(': ')[0], 60), x.count ? plural(x.count, 'place') : ''));
    if (shown.length) lists.push(card('Fixed by the copy', 'Applied automatically', '', listBlock(shown)));
  }
  if (manual.length) lists.push(card('Needs a person', 'Rebuild by hand', '', listBlock(manual)));
  blocks.push(lists.length ? `<div class="row split">${left}<div class="stack">${lists.join('')}</div></div>` : left);

  const head = `<header class="minihead">${logoTile(f, d.project.name, 'logo sm')}<span>${esc(d.project.name || hostOf(d.project.url))}</span><em>The numbers</em></header>`;
  return `${head}<div class="body" id="numbers">${blocks.join('')}<p class="end">Every check, page and value is in the JSON download.</p></div>${footer(d, pageNo, total)}`;
}

// ---- Styles -----------------------------------------------------------------------------------------------------

const CSS = `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#e9edf2;color:${C.ink};font:400 11px/1.45 'Segoe UI','Inter',system-ui,-apple-system,Arial,sans-serif;font-variant-numeric:tabular-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;margin:24px auto;background:#fff;position:relative;overflow:hidden;box-shadow:0 2px 14px rgba(16,24,40,.12);display:flex;flex-direction:column}
@media print{body{background:#fff}.page{margin:0;box-shadow:none;break-after:page}.page:last-child{break-after:auto}}
@media screen and (max-width:820px){.page{width:auto;height:auto;margin:0 0 16px;overflow:visible}}
h1,h2,h3,p{margin:0}
.band{background:${C.ink};color:#fff;padding:30px 40px 28px;display:flex;justify-content:space-between;align-items:center;gap:24px;border-bottom:4px solid ${C.copy}}
.brand{display:flex;align-items:center;gap:16px;min-width:0}
.brand h1{font-size:24px;font-weight:700;letter-spacing:-.01em;line-height:1.15;overflow-wrap:anywhere}
.addr{color:#c3cad5;font-size:11.5px;margin-top:3px;overflow-wrap:anywhere}
.logo{flex:none;width:58px;height:58px;border-radius:14px;background:#fff;display:grid;place-items:center;overflow:hidden}
.logo img{width:40px;height:40px;object-fit:contain}
.logo.mono{background:${C.copy};color:#fff;font-size:28px;font-weight:700}
.logo.sm{width:22px;height:22px;border-radius:6px;border:1px solid #e4e7ec}
.logo.sm img{width:16px;height:16px}
.logo.sm.mono{font-size:12px;border:0}
.meta{text-align:right;flex:none;color:#c3cad5;font-size:11.5px}
.kicker{color:#fff;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;margin-bottom:4px}
.body{flex:1;padding:28px 40px 0;display:flex;flex-direction:column;gap:18px;min-height:0}
.verdict{font-size:21px;line-height:1.3;font-weight:650;letter-spacing:-.01em;color:${C.ink};max-width:660px}
.sub{color:${C.muted};font-size:11px;margin-top:-6px}
.card{border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px;background:#fff;break-inside:avoid}
.card>header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:6px}
.eyebrow{color:${C.copy};font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.card h3{font-size:13.5px;font-weight:650;margin-top:2px;letter-spacing:-.005em}
.cap{color:${C.muted};font-size:10px;margin:0 0 8px}
.cap.foot{margin:6px 0 0;padding-top:8px;border-top:1px solid #eef1f5}
.key{display:flex;gap:14px;color:${C.ink2};font-size:10px;align-items:center;white-space:nowrap}
.card.wide .key{justify-content:flex-end;margin:-26px 0 4px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.sw.copy{background:${C.copy}}.sw.orig{background:${C.orig}}
.g-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.g-cell{text-align:center}
.gauge{width:150px;height:131px;display:block;margin:0 auto}
.g-num{font-size:30px;font-weight:700;fill:${C.ink};letter-spacing:-.02em}
.g-of{font-size:9px;fill:${C.muted}}
.g-title{font-size:12px;font-weight:650;margin-top:-6px}
.g-line{display:flex;justify-content:center;gap:8px;align-items:center;margin-top:4px;font-size:10px}
.g-desk{color:${C.muted};font-size:9.5px;margin-top:2px}
.was{color:${C.muted}}
.chg{font-weight:650;padding:1px 7px;border-radius:999px;border:1px solid}
.chg.ok{color:${C.ok};background:#ecfdf3;border-color:#abefc6}
.chg.bad{color:${C.bad};background:#fef3f2;border-color:#fecdca}
.chg.warn{color:#b54708;background:#fffaeb;border-color:#fedf89}
.chg.none{color:${C.ink2};background:#f2f4f7;border-color:#e4e7ec}
.tiles{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:10px}
.tile{border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px;background:#f8fafc}
.t-val{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1.05}
.t-val small{font-size:15px;font-weight:650;margin-left:1px}
.t-lab{font-size:10.5px;font-weight:600;color:${C.ink2};margin-top:4px;display:flex;align-items:center;gap:5px}
.t-note{font-size:9.5px;color:${C.muted};margin-top:1px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.dot.ok{background:${C.ok}}.dot.warn{background:${C.warn}}.dot.bad{background:${C.bad}}.dot.info{background:${C.info}}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.shots.one{grid-template-columns:1fr}
.duo{display:grid;grid-template-columns:1.2fr 1fr;gap:28px;align-items:end}
.duo .nextbox{margin-top:0;border-top:0;border-left:1px solid #e4e7ec;padding:0 0 10px 22px}
.nextbox.flat{margin-top:4px}
.shot{margin:0}
.shot figcaption{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:10px;color:${C.muted};padding-right:46px}
.shot figcaption b{color:${C.ink};font-size:11px}
.stage{position:relative;padding-right:46px;padding-bottom:10px}
.browser{border:1px solid #d0d5dd;border-radius:9px;overflow:hidden;background:#f2f4f7}
.browser .bar{height:14px;display:flex;gap:4px;align-items:center;padding:0 7px;border-bottom:1px solid #e4e7ec}
.browser .bar i{width:5px;height:5px;border-radius:50%;background:#d0d5dd}
.browser img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top}
.noimg{aspect-ratio:16/10;display:grid;place-items:center;color:${C.muted}}
.phone{position:absolute;right:0;bottom:0;width:70px;border:3px solid ${C.ink};border-radius:12px;overflow:hidden;background:${C.ink};box-shadow:0 4px 12px rgba(16,24,40,.18)}
.phone img{display:block;width:100%;aspect-ratio:375/760;object-fit:cover;object-position:top;border-radius:8px}
.nextbox{border-top:1px solid #e4e7ec;padding-top:14px;margin-top:auto}
.next{margin:6px 0 0;padding:0;list-style:none;counter-reset:n;display:grid;gap:5px}
.next li{counter-increment:n;display:flex;gap:9px;font-size:11px;color:${C.ink2}}
.next li::before{content:counter(n);flex:none;width:17px;height:17px;border-radius:50%;background:#fff7ed;color:${C.copy};font-weight:700;font-size:9.5px;display:grid;place-items:center;border:1px solid #fdba74}
.track{list-style:none;margin:8px 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.track li{border:1px dashed #d0d5dd;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:6px}
.track .n{width:24px;height:24px;border-radius:50%;background:#f2f4f7;display:grid;place-items:center;font-weight:700;color:${C.ink2}}
.track small{color:${C.muted};font-size:10.5px}.track b{font-size:13px}.track em{font-style:normal;color:${C.muted}}
.minihead{display:flex;align-items:center;gap:8px;padding:18px 40px 12px;border-bottom:1px solid #e4e7ec;font-weight:650;font-size:11.5px}
.minihead em{margin-left:auto;font-style:normal;color:${C.copy};font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.chart{display:block;width:100%;height:auto}
.ax{font-size:9px;fill:${C.muted}}
.ax.good{fill:${C.ok};font-weight:600}
.ax-h{font-size:10.5px;font-weight:650;fill:${C.ink}}
.ax-p{font-size:9.5px;fill:${C.ink2}}
.v-o{font-size:9px;fill:${C.muted};font-weight:600;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}
.v-n{font-size:9.5px;fill:${C.ink};font-weight:700;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}
.row{display:grid;gap:14px}
.row.two{grid-template-columns:1fr 1.15fr}
.row.split{grid-template-columns:1.15fr 1fr;align-items:start}
.stack{display:flex;flex-direction:column;gap:14px}
.donut-wrap{display:flex;align-items:center;gap:14px}
.donut{width:128px;height:128px;flex:none}
.d-num{font-size:24px;font-weight:700;fill:${C.ink}}
.d-of{font-size:9px;fill:${C.muted}}
.legend{list-style:none;margin:0;padding:0;flex:1;display:grid;gap:4px}
.legend li{display:grid;grid-template-columns:10px 1fr auto 32px;gap:7px;align-items:center;font-size:10.5px;padding-bottom:3px;border-bottom:1px solid #f2f4f7}
.legend i{width:10px;height:10px;border-radius:3px}
.legend b{font-weight:700}
.legend em{font-style:normal;color:${C.muted};text-align:right;font-size:9.5px}
.speed{display:grid;gap:9px}
.sp-row{display:grid;grid-template-columns:128px 1fr;gap:10px;align-items:center}
.sp-lab b{display:block;font-size:10.5px;font-weight:600}
.sp-lab small{font-size:9px;color:${C.muted}}
.sp-svg{width:100%;height:auto;display:block}
.items{list-style:none;margin:0;padding:0;display:grid;gap:5px}
.items li{display:flex;gap:8px;align-items:flex-start;font-size:10.5px}
.items b{font-weight:600}
.items small{display:block;color:${C.muted};font-size:9.5px}
.mk{flex:none;width:15px;height:15px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:9px;font-weight:700;margin-top:1px}
.mk.ok{background:#ecfdf3;color:${C.ok}}.mk.warn{background:#fffaeb;color:#b54708}.mk.bad{background:#fef3f2;color:${C.bad}}.mk.info{background:#eff8ff;color:${C.info}}
.more{color:${C.muted};font-size:9.5px;margin:6px 0 0 23px}
.note{color:${C.muted};font-size:9.5px;margin-top:6px}
.empty{color:${C.muted}}
.end{color:${C.muted};font-size:10px;text-align:center;margin-top:auto;padding-bottom:4px}
.foot-line{display:flex;justify-content:space-between;padding:10px 0 16px;color:${C.muted};font-size:8.5px;border-top:1px solid #eef1f5;margin:12px 40px 0}
`;

// ---- The document -------------------------------------------------------------------------------------------------

/**
 * @param {{ generatedAt: string, project: object, audit: object, analyzed: boolean, recreate: object|null, images?: object }} d
 * @returns {string}
 */
export function renderReportHtml(d) {
  const f = facts(d);
  const total = f.a ? 2 : 1;
  const pages = [cover(d, f, total)];
  if (f.a) pages.push(analytics(d, f, 2, total));
  const title = `${d.project.name || hostOf(d.project.url)} · Website report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${pages.map((p, i) => `<div class="page" id="page-${i + 1}">${p}</div>`).join('\n')}
</body>
</html>`;
}

export function reportFileName(project, ext) {
  let host = 'site';
  try {
    host = new URL(project.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep the default */
  }
  return `${host.replace(/[^a-z0-9.-]/gi, '-')}-audit-report-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
