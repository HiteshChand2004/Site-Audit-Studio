// The report as one self-contained HTML file: inline styles, inline images, no script and no external request, so
// it can be saved, e-mailed, opened offline, printed and turned into a PDF (report/pdf.js).
//
// Written for anyone, technical or not. Page 1 is a one-page summary: a plain verdict, the four health scores of the
// original and the copy on a phone and a computer (with Better / Same / Worse in words), the result counts, how close
// the copy is, two small screenshots and at most three next steps. The following pages group the detail by meaning
// (speed, Google and AI, everyone, the copy, what needs a person); each section opens with one plain sentence, then
// compact tables for technical readers, every expert term explained in brackets the first time. Long lists show the
// most important rows and say how many more are in the JSON download. Every value from the audit or the recreate goes
// through esc(): site names, titles and URLs come from the pages that were analysed.
import { AREAS, GENERATED_FIELDS, METRICS, RESULT, RESULT_ORDER, matchRating, plainName, rating } from './words.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const date = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
};
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const clip = (s, max = 150) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** "a, b and c" or "a, b and 4 more". */
const listWords = (items, max = 3) => {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
};
const seconds = (v) => (v == null ? '—' : v < 1000 ? `${(v / 1000).toFixed(2)} s` : `${(v / 1000).toFixed(1)} s`);
const bytes = (v) => (v == null ? '—' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${num(Math.round(v / 1024))} KB`);
const metricValue = (m, unit) => (m == null ? '—' : unit === 'time' ? seconds(m) : unit === 'bytes' ? bytes(m) : unit === 'cls' ? Number(m).toFixed(2) : num(m));
const signed = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0');

/** A check's finding in consistent units: "3,770 ms" → "3.8 s", "Est savings of 427 KiB" → "could save 427 KB". */
const detail = (s, max) => clip(String(s ?? '')
  .replace(/Est savings of/g, 'could save')
  .replace(/\bKiB\b/g, 'KB').replace(/\bMiB\b/g, 'MB')
  .replace(/(\d[\d,]*(?:\.\d+)?)\s?ms\b/g, (m, n) => { const v = Number(n.replace(/,/g, '')); return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${(v / 1000).toFixed(2)} s`; }), max);

const STACK_LABEL = { html: 'Plain HTML', 'react-vite': 'React + Vite', nextjs: 'Next.js', mern: 'MERN' };
const stackName = (id) => STACK_LABEL[id] ?? id ?? 'Plain HTML';
// How many rows a list shows before it says "+N more" (the full data is in the JSON download).
const MAX_ROWS = 12;
const more = (total, shown, what = 'more') => (total > shown ? `<p class="more">+ ${num(total - shown)} ${what} in the JSON download.</p>` : '');

/** A result as a mark and a word (never colour alone). */
const result = (s) => {
  const r = RESULT[s] ?? { label: s, mark: '·', tone: 'none' };
  return `<span class="res ${r.tone}"><i aria-hidden="true">${r.mark}</i>${esc(r.label)}</span>`;
};
/** Status of a check on the original alone (pass / warn / fail). */
const own = (s) => result(s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : 'fail');
/** A check's plain name with its expert term in small type. */
const checkName = (item, review = false) => {
  const { name, term } = plainName(item);
  const sub = [term && esc(term), review && '<em class="rev">review the generated text</em>'].filter(Boolean).join(' · ');
  return `<b>${esc(name)}</b>${sub ? `<small class="term">${sub}</small>` : ''}`;
};

const table = (head, rows, cls = '') =>
  rows.length
    ? `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '';
const section = (id, title, lede, body, about = '') =>
  `<section id="${id}" class="sec"><div class="head"><h2>${esc(title)}</h2>${about ? `<p class="about">${about}</p>` : ''}<p class="lede">${lede}</p></div>${body}</section>`;

// ---- What the report knows ----------------------------------------------------------------------------------------

/** The parts of the data the report uses, and which state the project is in. */
function facts(d) {
  const a = d.analyzed ? d.audit : null;
  const r = d.recreate ?? null;
  const cs = d.analyzed ? d.audit.recreate ?? null : null;
  const c = cs && !cs.isDummy && Array.isArray(cs.items) ? cs : null;
  const checks = a
    ? [
        ...(a.seo ?? []).map((i) => ({ area: 'search', ...i })),
        ...(a.aeo ?? []).map((i) => ({ area: 'ai', ...i })),
        ...[['sitemap.xml', a.crawl?.sitemap], ['robots.txt', a.crawl?.robots], ['Meta tags', a.crawl?.metaTags]].filter(([, v]) => v?.status).map(([title, v]) => ({ area: 'files', title, status: v.status, detail: v.detail })),
      ]
    : [];
  const before = c?.scores?.before ?? a?.scores ?? null;
  const after = c?.scores?.after ?? null;
  return { a, r, c, cs, checks, before, after };
}

/** Better / Same / Worse for two scores: within 2 points counts as the same (scores vary a little run to run). */
function change(b, a) {
  if (b == null || a == null) return null;
  const d = a - b;
  if (d >= 3) return { label: 'Better', tone: 'ok', d };
  if (d <= -3) return { label: 'Worse', tone: 'bad', d };
  return { label: 'Same', tone: 'none', d };
}

/** Manual items of the original and the copy, equal ones (same kind and reason) merged into one row with their pages. */
function manualGroups(a, r) {
  const groups = new Map();
  for (const m of [...(a?.manualRebuild ?? []), ...(r?.manual ?? [])]) {
    const key = `${m.kind}|${m.detail}`;
    const g = groups.get(key) ?? { kind: m.kind, detail: m.detail, titles: [], pages: [] };
    if (!g.titles.includes(m.title)) g.titles.push(m.title);
    let page = null;
    try {
      if (m.url) page = new URL(m.url).pathname;
    } catch {
      /* no page */
    }
    if (page && !g.pages.includes(page)) g.pages.push(page);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    title: g.titles.length > 1 ? (g.kind === 'form' ? `Forms on ${plural(g.titles.length, 'page')} need a backend` : `${g.titles[0]} (and ${g.titles.length - 1} similar)`) : g.titles[0],
  }));
}

// ---- Page 1: the summary ------------------------------------------------------------------------------------------

/** Two or three plain sentences: where the site stands and what the copy achieved. */
function verdict(f) {
  const { a, r, c, before, after } = f;
  if (!a) return 'This website has not been checked yet, so there is nothing to report. Check the site first; the report then shows how healthy it is, and later how the copy compares.';
  const out = [];
  if (c && after) {
    const better = [];
    const worse = [];
    const mixed = [];
    for (const area of AREAS) {
      const p = change(before?.mobile?.[area.id], after?.mobile?.[area.id]);
      const k = change(before?.desktop?.[area.id], after?.desktop?.[area.id]);
      const tones = [p?.tone, k?.tone];
      if (tones.includes('ok') && tones.includes('bad')) mixed.push(`${p.tone === 'ok' ? area.better : area.worse} on phones but ${k.tone === 'ok' ? area.better : area.worse} on computers`);
      else if (tones.includes('ok')) better.push(`${area.better}${!p || p.tone !== 'ok' ? ' on computers' : !k || k.tone !== 'ok' ? ' on phones' : ''}`);
      else if (tones.includes('bad')) worse.push(`${area.worse}${!p || p.tone !== 'bad' ? ' on computers' : !k || k.tone !== 'bad' ? ' on phones' : ''}`);
    }
    if (better.length) out.push(`Compared with the original, the copy is ${listWords(better, 4)}${worse.length ? `, but ${listWords(worse, 4)}` : ''}.`);
    else if (worse.length) out.push(`Compared with the original, the copy is ${listWords(worse, 4)}; the other scores stay about the same.`);
    else out.push('The copy scores about the same as the original on speed, Google, accessibility and modern standards.');
    if (mixed.length) out.push(`It is ${listWords(mixed, 2)}.`);
  } else {
    const good = AREAS.filter((x) => rating(before?.mobile?.[x.id]).tone === 'ok').map((x) => x.title);
    const work = AREAS.filter((x) => ['warn', 'bad'].includes(rating(before?.mobile?.[x.id]).tone)).map((x) => x.title);
    const problems = f.checks.filter((x) => x.status !== 'pass').length + (a.brokenLinks?.broken?.length ? 1 : 0) + (a.accessibility?.length ?? 0);
    out.push(`On a phone the original site is ${good.length ? `good for ${listWords(good.map((g) => `“${g}”`), 4)}` : 'not yet good in any area'}${work.length ? ` and needs work on ${listWords(work.map((w) => `“${w}”`), 4)}` : ''}. The check found ${plural(problems, 'thing')} to improve across ${plural(a.pagesCrawled ?? 0, 'page')}.`);
  }
  if (r?.fidelity) {
    const m = matchRating(r.fidelity.score);
    out.push(`The copy of ${plural(r.pages?.length ?? 0, 'page')} looks ${m.label === 'Clearly different' ? 'clearly different from' : `${m.label.toLowerCase().replace(', worth a look', '')} to`} the original (match ${r.fidelity.score ?? '—'} out of 100).`);
  } else {
    out.push('No copy of the site has been made yet.');
  }
  if (c) {
    const s = c.summary ?? {};
    const parts = [`${plural((s.fixed ?? 0) + (s.improved ?? 0), 'problem')} fixed or improved`, s.open && `${num(s.open)} still ${s.open === 1 ? 'needs' : 'need'} work`, s.regressed && `${num(s.regressed)} got worse`, s.manual && `${num(s.manual)} ${s.manual === 1 ? 'needs' : 'need'} a person`];
    out.push(`${listWords(parts.filter(Boolean), 4)}.`.replace(/^./, (x) => x.toUpperCase()));
  } else if (r) {
    out.push('The copy has not been compared with the original check by check yet.');
  }
  return out.join(' ');
}

/** At most three next steps, most important first. */
function nextSteps(f) {
  const { a, r, c, cs } = f;
  if (!a) return ['Check the site (step 1 in the app). It takes a few minutes and finds speed, Google and accessibility problems.'];
  const steps = [];
  if (!r) {
    const fixable = f.checks.filter((x) => x.status !== 'pass').length;
    steps.push(`Create the copy (step 2). It fixes many of the ${plural(fixable, 'search and AI problem')} found here by itself.`);
  } else if (!c) {
    steps.push(cs?.status === 'running' || cs?.status === 'queued' ? 'The comparison of the copy with the original is running; download the report again when it has finished.' : 'Compare the copy with the original (Re-audit in the app) to see what got better and what did not.');
  } else {
    if (c.stale) steps.push('Compare again: the copy or the check changed after this comparison was made, so some results may be out of date.');
    const worse = c.items.filter((i) => i.status === 'regressed');
    if (worse.length) steps.push(`Look at the ${plural(worse.length, 'check')} that got worse in the copy: ${esc(listWords(worse.map((i) => plainName(i).name.toLowerCase()), 3))}.`);
  }
  const manual = manualGroups(a, r);
  if (manual.length) steps.push(`Rebuild by hand what cannot be copied automatically: ${esc(listWords(manual.map((m) => m.title.charAt(0).toLowerCase() + m.title.slice(1)), 2))} (section ${r ? 5 : 4}).`);
  const open = c?.summary?.open ?? 0;
  if (open) steps.push(`Work through the ${plural(open, 'check')} that still ${open === 1 ? 'needs' : 'need'} work (marked “Still needs work” in sections 1–3).`);
  const auto = r?.autoGenerated?.length ?? 0;
  if (auto) steps.push(`Review the ${plural(auto, 'text')} the copy wrote by itself where the original had none (page descriptions, image descriptions, …).`);
  if (!steps.length) steps.push('Nothing urgent: put the copy online and check its speed again there.');
  return steps.slice(0, 3);
}

/** A 0–100 track with the original (hollow) and the copy (filled) as dots: a small dumbbell chart. */
function dumbbell(b, a, tone) {
  const W = 104;
  const x = (v) => (5 + (Math.max(0, Math.min(100, v)) / 100) * (W - 10)).toFixed(1);
  const parts = [`<line x1="5" y1="8" x2="${W - 5}" y2="8" class="trk"/>`, `<line x1="${x(50)}" y1="4" x2="${x(50)}" y2="12" class="tick"/>`, `<line x1="${x(90)}" y1="4" x2="${x(90)}" y2="12" class="tick"/>`];
  if (b != null && a != null) parts.push(`<line x1="${x(b)}" y1="8" x2="${x(a)}" y2="8" class="lnk ${tone}"/>`);
  if (b != null) parts.push(`<circle cx="${x(b)}" cy="8" r="4.2" class="dot-o"/>`);
  if (a != null) parts.push(`<circle cx="${x(a)}" cy="8" r="4.2" class="dot-n"/>`);
  return `<svg class="db" viewBox="0 0 ${W} 16" width="${W}" height="16" aria-hidden="true">${parts.join('')}</svg>`;
}

function scoreCell(b, a, copy) {
  if (!copy) {
    const r = rating(b);
    return `<div class="sc"><span class="nums"><b>${b ?? '—'}</b></span>${dumbbell(b, null)}<span class="chg ${r.tone}">${esc(r.label)}</span></div>`;
  }
  const ch = change(b, a);
  return `<div class="sc"><span class="nums">${b ?? '—'} <i>→</i> <b>${a ?? '—'}</b></span>${dumbbell(b, a, ch?.tone ?? 'none')}<span class="chg ${ch?.tone ?? 'none'}">${ch ? `${ch.label} <em>${signed(ch.d)}</em>` : 'Not measured'}</span></div>`;
}

function scoresTable(f) {
  const copy = !!(f.c && f.after);
  const rows = AREAS.map((area) => `<tr><th scope="row"><b>${esc(area.title)}</b><small>${esc(area.question)}</small></th><td>${scoreCell(f.before?.mobile?.[area.id], f.after?.mobile?.[area.id], copy)}</td><td>${scoreCell(f.before?.desktop?.[area.id], f.after?.desktop?.[area.id], copy)}</td></tr>`).join('');
  const key = copy
    ? '<span class="key"><i class="k-o"></i>Original <i class="k-n"></i>Copy · scale 0–100, marks at 50 and 90 (below 50 poor, 90 and up good) · a change of 2 points or less counts as the same</span>'
    : '<span class="key"><i class="k-o"></i>Original · scale 0–100, marks at 50 and 90 (below 50 poor, 90 and up good)</span>';
  return `<table class="scores"><thead><tr><th>Health score <small>(Lighthouse, homepage)</small></th><th>On a phone</th><th>On a computer</th></tr></thead><tbody>${rows}</tbody></table>${key}`;
}

function countTiles(f) {
  const { a, c } = f;
  const tile = (label, value, tone, sub = '') => `<div class="tile ${tone}"><b>${num(value ?? 0)}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  if (c) {
    const s = c.summary ?? {};
    const pages = c.scope?.pages?.length;
    const extra = [s.na && `${num(s.na)} depend on hosting`, s.changed && `${num(s.changed)} vary from run to run`, s.recheck && `${num(s.recheck)} to check again`].filter(Boolean);
    return `<div class="tiles">${tile('Fixed', s.fixed, 'ok')}${tile('Better', s.improved, 'ok', 'not perfect yet')}${tile('Still needs work', s.open, 'warn')}${tile('Got worse', s.regressed, 'bad')}${tile('Needs a person', s.manual, 'info')}${tile('Already fine', s.pass, 'none', 'on both sites')}</div>
      <p class="cap">Every check of the original compared with the copy${pages ? ` on the ${plural(pages, 'page')} both have` : ''}.${extra.length ? ` Also: ${esc(listWords(extra, 3))}.` : ''}</p>`;
  }
  const fail = f.checks.filter((x) => x.status === 'fail').length;
  const warn = f.checks.filter((x) => x.status === 'warn').length;
  const pass = f.checks.filter((x) => x.status === 'pass').length;
  return `<div class="tiles">${tile('Problems', fail, 'bad', 'search, AI and site files')}${tile('Worth fixing', warn, 'warn')}${tile('Already fine', pass, 'none')}${tile('Accessibility issues', a.accessibility?.length ?? 0, (a.accessibility?.length ? 'warn' : 'ok'), 'kinds, homepage')}${tile('Dead links', a.brokenLinks?.broken?.length ?? 0, a.brokenLinks?.broken?.length ? 'bad' : 'ok')}${tile('Needs a person', a.manualRebuild?.length ?? 0, 'info')}</div>
    <p class="cap">Checks of the original site across ${plural(a.pagesCrawled ?? 0, 'page')}.</p>`;
}

// Small pictures: the width a view is shown at (px); the picture itself has about twice that for sharpness.
const shotPair = (images, label) => {
  if (!images?.desktop && !images?.mobile) return '';
  return `<figure class="shot"><div>${images.desktop ? `<img class="d" src="${images.desktop}" alt="${esc(label)} on a computer"/>` : ''}${images.mobile ? `<img class="m" src="${images.mobile}" alt="${esc(label)} on a phone"/>` : ''}</div><figcaption>${esc(label)}</figcaption></figure>`;
};

function matchBlock(f) {
  const { r } = f;
  if (!r?.fidelity) return '';
  const m = matchRating(r.fidelity.score);
  const v = matchRating(r.fidelity.diff?.score);
  return `<div class="match"><h3>How close is the copy?</h3>
    <div class="mrow"><b class="big">${r.fidelity.score ?? '—'}</b><span><strong class="t-${m.tone}">${esc(m.label)}</strong><small>Match with the original, out of 100 (80 and up is good)</small></span></div>
    <dl class="mini"><dt>Looks the same</dt><dd>${r.fidelity.diff?.score ?? '—'} · ${esc(v.label)}</dd><dt>Pages copied</dt><dd>${num(r.pages?.length ?? 0)}</dd><dt>Built with</dt><dd>${esc(stackName(r.stack))}</dd>${r.responsive?.status === 'done' ? `<dt>Other screen sizes</dt><dd>${r.responsive.score} · ${esc(matchRating(r.responsive.score).label)}</dd>` : ''}</dl></div>`;
}

function summaryPage(d, f, hasDetail) {
  const { a, r, c, cs } = f;
  const steps = nextSteps(f);
  const shots = `${shotPair(d.images?.old, 'Original')}${shotPair(d.images?.new, 'Copy')}`;
  const stage = (label, done, when, extra = '') => `<div class="stage ${done ? 'done' : ''}"><span>${esc(label)}</span><b>${done ? esc(date(when)) : 'Not yet'}</b>${extra ? `<small>${extra}</small>` : ''}</div>`;
  return `<section id="summary" class="page1${hasDetail ? ' brk' : ''}">
  <header class="top"><p class="eyebrow">Website report</p><h1>${esc(d.project.name)}</h1><p class="url">${esc(d.project.url)}</p>
  <div class="stages">${stage('Report made', true, d.generatedAt)}${stage('1 · Site checked', !!a, a?.analyzedAt, a ? `${plural(a.pagesCrawled ?? 0, 'page')}` : '')}${stage('2 · Copy made', !!r, r?.createdAt, r ? `${plural(r.pages?.length ?? 0, 'page')}, ${esc(stackName(r.stack))}` : '')}${stage('3 · Compared', !!c, c?.reauditedAt, c ? (c.stale ? 'may be out of date' : 'check by check') : cs?.status === 'running' || cs?.status === 'queued' ? 'running now' : '')}</div></header>
  <p class="verdict">${esc(verdict(f))}</p>
  ${a ? scoresTable(f) : ''}
  ${a ? countTiles(f) : ''}
  ${matchBlock(f) || shots ? `<div class="duo">${matchBlock(f)}${shots ? `<div class="shots">${shots}<p class="cap">Homepage, first screen, on a computer and a phone.</p></div>` : ''}</div>` : ''}
  <div class="next"><h3>What to do next</h3><ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>
</section>`;
}

// ---- Detail sections ------------------------------------------------------------------------------------------------

/** Checklist rows of some categories, worst first, as a table; passing and hosting-dependent ones as a short line. */
function checklistRows(c, categories) {
  const items = c.items.filter((i) => categories.includes(i.category) && i.status !== 'manual');
  const shown = items.filter((i) => !['pass', 'na'].includes(i.status)).sort((x, y) => RESULT_ORDER.indexOf(x.status) - RESULT_ORDER.indexOf(y.status));
  const rows = shown.slice(0, MAX_ROWS + 2).map((i) => [
    result(i.status),
    checkName(i, i.review),
    esc(detail(i.before?.detail ?? (i.before?.status ? RESULT[i.before.status === 'pass' ? 'ok' : i.before.status]?.label : '') ?? '—', 110)),
    esc(detail(i.after?.detail ?? (i.after?.status ? RESULT[i.after.status === 'pass' ? 'ok' : i.after.status]?.label : '') ?? '—', 110)),
  ]);
  const pass = items.filter((i) => i.status === 'pass').map((i) => plainName(i).name);
  const na = items.filter((i) => i.status === 'na').map((i) => plainName(i).name);
  return `${table(['Result', 'Check', 'Original', 'Copy'], rows, 'checks')}${more(shown.length, MAX_ROWS + 2, 'more checks')}
    ${pass.length ? `<p class="fine"><b>Fine on both (${num(pass.length)}):</b> ${esc(pass.join(' · '))}.</p>` : ''}
    ${na.length ? `<p class="fine"><b>Depends on hosting (${num(na.length)}),</b> not judged on the local preview: ${esc(na.join(' · '))}.</p>` : ''}`;
}

/** Checks of the original alone (no comparison yet): problems first, passing ones as a short line. */
function originalRows(list) {
  const order = { fail: 0, warn: 1 };
  const issues = list.filter((i) => i.status !== 'pass').sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2));
  const pass = list.filter((i) => i.status === 'pass').map((i) => plainName(i).name);
  return `${table(['Result', 'Check', 'What the check found'], issues.slice(0, MAX_ROWS + 2).map((i) => [own(i.status), checkName(i), esc(detail(i.detail, 190))]), 'checks')}${more(issues.length, MAX_ROWS + 2, 'more checks')}
    ${pass.length ? `<p class="fine"><b>Already fine (${num(pass.length)}):</b> ${esc(pass.join(' · '))}.</p>` : ''}`;
}

function speedSection(f) {
  const { a, c } = f;
  const before = c?.metrics?.before ?? a.metricsByDevice ?? { mobile: a.metrics };
  const after = c?.metrics?.after ?? null;
  const pb = before?.mobile;
  const pa = after?.mobile;
  let lede;
  if (pb && pa) lede = `On a phone the main content of the homepage shows in ${seconds(pa.lcp)} on the copy instead of ${seconds(pb.lcp)}, and the page weighs ${bytes(pa.pageSize)} instead of ${bytes(pb.pageSize)}.`;
  else if (pb) lede = `On a phone the main content of the homepage shows in ${seconds(pb.lcp)} (Google’s target is 2.5 s or less), and the page weighs ${bytes(pb.pageSize)}.`;
  else lede = 'The speed measurement did not finish for this check.';
  const head = after
    ? ['Measurement', 'Good if', 'Phone · original', 'Phone · copy', 'Computer · original', 'Computer · copy']
    : ['Measurement', 'Good if', 'On a phone', 'On a computer'];
  const rows = METRICS.map((m) => {
    const cells = [`<b>${esc(m.title)}</b><small class="term">${esc(m.term)}</small>`, esc(m.good), metricValue(before?.mobile?.[m.key], m.unit)];
    if (after) cells.push(`<b>${metricValue(after?.mobile?.[m.key], m.unit)}</b>`);
    cells.push(metricValue(before?.desktop?.[m.key], m.unit));
    if (after) cells.push(`<b>${metricValue(after?.desktop?.[m.key], m.unit)}</b>`);
    return cells;
  });
  const stack = (a.techStack ?? []).map((t) => `${esc(t.name)} <small>(${t.confidence ?? '—'} % sure)</small>`).join(' · ');
  const weak = (a.weaknesses ?? []).slice().sort((x, y) => ['high', 'medium', 'low'].indexOf(x.severity) - ['high', 'medium', 'low'].indexOf(y.severity));
  const sev = (s) => result(s === 'high' ? 'fail' : s === 'medium' ? 'warn' : 'ok').replace(/Problem|Worth fixing|Fine/, s === 'high' ? 'Important' : s === 'medium' ? 'Worth fixing' : 'Minor');
  const body = `${table(head, rows, 'metrics num')}
    <p class="cap">Measured by Lighthouse on the homepage with a simulated slow phone and network${after ? '; the copy on a local preview, so confirm after it is online' : ''}.</p>
    <p class="built"><b>The original is built with:</b> ${stack || 'no known platform (custom or unknown)'}.</p>
    ${weak.length ? `<h3>What holds the original back</h3>${table(['Importance', 'Problem', 'Detail'], weak.slice(0, 8).map((w) => [sev(w.severity), checkName({ title: w.title }), esc(detail(w.detail, 170))]), 'checks')}${more(weak.length, 8)}` : ''}
    ${c ? `<h3>Speed and technology checks, original → copy</h3>${checklistRows(c, ['performance', 'platform', 'best-practices'])}` : ''}`;
  return section('speed', 'Speed and technology', esc(lede), body, 'How fast pages appear and react, how heavy they are, and what the site is built with.');
}

function searchSection(f) {
  const { c } = f;
  const list = f.checks;
  let lede;
  if (c) {
    const items = c.items.filter((i) => ['seo', 'aeo', 'crawl'].includes(i.category));
    const n = (s) => items.filter((i) => i.status === s).length;
    lede = `Of ${plural(items.length, 'check')}: ${listWords([n('pass') && `${num(n('pass'))} already fine`, (n('fixed') + n('improved')) && `${num(n('fixed') + n('improved'))} fixed or better in the copy`, n('open') && `${num(n('open'))} still ${n('open') === 1 ? 'needs' : 'need'} work`, n('regressed') && `${num(n('regressed'))} got worse`].filter(Boolean), 4)}.`;
  } else {
    const n = (s) => list.filter((i) => i.status === s).length;
    lede = `Of ${plural(list.length, 'check')} on the original, ${num(n('pass'))} ${n('pass') === 1 ? 'is' : 'are'} fine, ${num(n('fail'))} ${n('fail') === 1 ? 'is a problem' : 'are problems'} and ${num(n('warn'))} ${n('warn') === 1 ? 'is' : 'are'} worth fixing.`;
  }
  return section('search', 'Found on Google and by AI assistants', esc(lede), c ? checklistRows(c, ['seo', 'aeo', 'crawl']) : originalRows(list),
    'SEO (search engine optimisation: being listed well on Google) and AEO (answer engine optimisation: being read and quoted by AI assistants such as ChatGPT), plus the site files search engines read (sitemap.xml, robots.txt).');
}

function accessSection(f) {
  const { a, c } = f;
  const bl = a.brokenLinks ?? {};
  const broken = bl.broken ?? [];
  const issues = a.accessibility ?? [];
  const lede = `${issues.length ? `${plural(issues.length, 'kind')} of accessibility problem on the original homepage (${plural(issues.reduce((n, i) => n + (i.count ?? 0), 0), 'element')})` : 'No accessibility problems on the original homepage'}; ${broken.length ? `${plural(broken.length, 'dead link')}` : 'no dead links'} among ${plural(bl.checked ?? 0, 'link')} checked${bl.unverified?.length ? ` (${num(bl.unverified.length)} could not be verified: the site refused or did not answer)` : ''}.`;
  const rows = c
    ? checklistRows(c, ['accessibility', 'links'])
    : issues.length
      ? table(['Result', 'Problem', 'Affected'], issues.slice(0, MAX_ROWS).map((i) => [own(['critical', 'serious'].includes(i.impact) ? 'fail' : 'warn'), checkName({ id: i.id, title: i.title }), `${plural(i.count ?? 0, 'element')} <small class="term">${esc(i.impact)}</small>`]), 'checks') + more(issues.length, MAX_ROWS)
      : '';
  const links = broken.length
    ? `<h3>Dead links on the original</h3>${table(['Link', 'Error', 'Found on'], broken.slice(0, 8).map((l) => [`<span class="mono">${esc(clip(l.url, 90))}</span>`, esc(l.status), `<span class="mono">${esc(clip(l.foundOn, 50))}</span>`]), 'checks')}${more(broken.length, 8, 'more links')}`
    : '';
  return section('access', 'Easy for everyone', esc(lede), `${rows}${links}`, 'Accessibility (whether people with disabilities can use the site: contrast, labels for screen readers, keyboard use), checked with axe on the homepage, and links that lead nowhere.');
}

/** The motion of the original that the copy carries (hover, scroll reveal, loops), as one sentence. */
function motionText(m) {
  if (!m) return null;
  const hover = m.hover?.elements ?? 0;
  const reveal = m.reveal?.elements ?? 0;
  const loops = (m.loops?.carried ?? 0) + (m.loops?.rebuilt ?? 0);
  if (!hover && !reveal && !loops) return null;
  const parts = [hover && `${num(hover)} hover effects`, reveal && `${num(reveal)} fade-ins while scrolling`, loops && `${num(loops)} looping animations`].filter(Boolean);
  const notRebuilt = m.loops?.skipped?.length ?? 0;
  return `${listWords(parts, 3)} rebuilt${m.script ? ' (fade-ins use one small generated script; without it the page simply shows finished)' : ''}${notRebuilt ? `; ${plural(notRebuilt, 'loop')} could not be rebuilt` : ''}.`;
}

function copySection(f) {
  const { r, c } = f;
  const fid = r.fidelity ?? {};
  const t = fid.threshold ?? 80;
  const dt = fid.diff?.threshold ?? 65;
  const resp = r.responsive?.status === 'done' ? r.responsive : null;
  const m = matchRating(fid.score);
  const lede = `${plural(r.pages?.length ?? 0, 'page')} copied as ${stackName(r.stack)} on ${date(r.createdAt)}; overall the copy is ${m.label.toLowerCase().replace(', worth a look', '')} to the original (match ${fid.score ?? '—'} out of 100).`;
  const kpi = (label, value, word, sub) => `<div class="kpi"><span>${label}</span><b>${value ?? '—'}</b><em>${esc(word)}</em><small>${sub}</small></div>`;
  const kpis = `<div class="kpis">${kpi('Match with the original', fid.score, matchRating(fid.score).label, `fidelity: sizes, positions and look of every element; ${t} and up is good`)}${kpi('Looks the same', fid.diff?.score, matchRating(fid.diff?.score).label, `visual difference: how alike the screenshots look; ${dt} and up is good`)}${kpi('Other screen sizes', resp?.score, resp ? matchRating(resp.score).label : 'Not measured', resp ? `${resp.widths.length} widths between phone and big screen; ${num(resp.driftCount)} of ${num(resp.measured)} page widths drift` : 'layout between phone, tablet and computer')}</div>`;

  // Pages, weakest first: a reader looks for what is off.
  const weakest = (p) => {
    const views = Object.entries(p.views ?? {}).filter(([, v]) => v.score != null).sort((x, y) => x[1].score - y[1].score);
    const names = { desktop: 'computer', laptop: 'laptop', tablet: 'tablet', mobile: 'phone' };
    return views.length ? `${names[views[0][0]] ?? views[0][0]} · ${views[0][1].score}` : '—';
  };
  const pages = (fid.pages ?? []).slice().sort((x, y) => (x.score ?? 101) - (y.score ?? 101));
  const shown = pages.slice(0, 8);
  const rest = pages.slice(8).map((p) => p.score).filter((x) => x != null);
  const pageTable = table(['Page', 'Match', 'Looks the same', 'Weakest screen'], shown.map((p) => [`<span class="mono">${esc(clip(p.path, 44))}</span>`, `${p.score ?? '—'} <small class="t-${matchRating(p.score).tone}">${esc(matchRating(p.score).label)}</small>`, `${p.diff?.score ?? '—'}`, esc(weakest(p))]), 'checks num pages');
  const pagesNote = pages.length > shown.length ? `<p class="more">Weakest ${shown.length} of ${num(pages.length)} pages; the other ${num(pages.length - shown.length)} score ${rest.length ? `${Math.min(...rest)}–${Math.max(...rest)}` : 'higher'}. All pages are in the JSON download.</p>` : '';
  const widths = resp ? widthChart(resp, dt) : '';

  // What was built, checked and fixed.
  const v = r.verify;
  const motionItems = c ? c.items.filter((i) => i.category === 'motion') : [];
  const rows = [
    v && ['Links and files', `${result(v.brokenLinks?.length || v.missingAssets?.length || v.html?.errors ? 'fail' : 'ok')} ${num(v.checked?.links)} links and ${num(v.checked?.assets)} files all work${v.html?.warnings ? `; ${plural(v.html.warnings, 'small HTML warning')} carried over from the original` : ''}`],
    r.safety && ['Safety', `${result(r.safety.safe ? 'ok' : 'fail')} ${r.safety.safe ? (r.outputs?.html?.scripts ? 'only the small generated animation script, nothing loaded from other sites' : 'no scripts and nothing loaded from other sites') : 'problems found'}`],
    r.generate?.noticePageCount ? ['Pages not copied', `${plural(r.generate.noticePageCount, 'link')} to pages that cannot be copied (login, shop, …) open a short notice page instead of the old site`] : null,
    motionText(r.generate?.motion) && ['Hover effects & animations', esc(motionText(r.generate.motion))],
    ...motionItems.map((i) => [esc(plainName(i).name), `${result(i.status === 'pass' ? 'ok' : i.status)} ${esc(detail(`Original: ${i.before?.detail ?? '—'} Copy: ${i.after?.detail ?? '—'}`, 220))}`]),
    r.fixes?.length && ['Fixed automatically', esc(r.fixes.slice(0, 10).map((x) => `${x.title}${x.count ? ` (${num(x.count)})` : ''}`).join(' · '))],
    generatedText(r) && ['Written by the copy', generatedText(r)],
  ].filter(Boolean);
  const outs = Object.entries(r.outputs ?? {}).filter(([k]) => k !== 'html');
  if (outs.length) {
    rows.push(['Other technologies', esc(outs.map(([k, o]) => `${stackName(k)}: ${o.status === 'ready' ? `ready${o.build?.js?.gzipBytes ? `, ${bytes(o.build.js.gzipBytes)} of script` : ''}` : o.status === 'failed' ? 'build failed' : o.status}`).join(' · '))]);
  }
  const warnings = r.warnings ?? [];
  const body = `${kpis}
    <div class="split"><div>${pageTable}${pagesNote}</div>${widths}</div>
    <h3>Built and checked</h3>${table(['', 'Result'], rows, 'facts')}
    ${warnings.length ? `<h3>Warnings</h3><ul class="warns">${warnings.slice(0, 5).map((w) => `<li>${esc(clip(w, 260))}</li>`).join('')}</ul>${more(warnings.length, 5, 'more warnings')}` : ''}`;
  return section('copy', 'The copy', esc(lede), body, 'How closely the new site follows the original on every page and screen size, and what was checked before it was handed over.');
}

/** "579 names for screen readers, 122 image descriptions, …" of report.autoGenerated, or null. */
function generatedText(r) {
  const list = r.autoGenerated ?? [];
  if (!list.length) return null;
  const by = new Map();
  for (const g of list) by.set(g.field, (by.get(g.field) ?? 0) + 1);
  const parts = [...by.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${GENERATED_FIELDS[k] ?? k} (${num(n)})`);
  return `${plural(list.length, 'value')} written from the page content where the original had none: ${esc(listWords(parts, 5))}. Please review them.`;
}

/** Vertical bars: the layout score at each width between phone and big screen (single series, threshold line). */
function widthChart(resp, threshold) {
  const widths = resp.widths ?? [];
  if (!widths.length) return '';
  const W = 230;
  const H = 96;
  const top = 12;
  const base = 70;
  const col = (W - 10) / widths.length;
  const y = (v) => base - ((Math.max(0, Math.min(100, v ?? 0)) / 100) * (base - top));
  const bars = widths.map((w, i) => {
    const v = resp.byWidth?.[w];
    const x = 5 + i * col + col * 0.18;
    const bw = col * 0.64;
    const low = v != null && v < threshold;
    return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - y(v)).toFixed(1)}" rx="2" class="${low ? 'bar-low' : 'bar'}"/><text x="${(x + bw / 2).toFixed(1)}" y="${(y(v) - 3).toFixed(1)}" class="bv">${v ?? '—'}</text><text x="${(x + bw / 2).toFixed(1)}" y="${base + 11}" class="bl">${w}</text>`;
  }).join('');
  return `<figure class="wchart"><figcaption>Layout at other screen widths <small>(score per width in px; dashed line = ${threshold}, below it is marked lighter)</small></figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Layout score per screen width">
    <line x1="5" y1="${base}" x2="${W - 5}" y2="${base}" class="axis"/><line x1="5" y1="${y(threshold).toFixed(1)}" x2="${W - 5}" y2="${y(threshold).toFixed(1)}" class="thr"/>${bars}
    <text x="${W / 2}" y="${H - 2}" class="bl">screen width (px)</text></svg></figure>`;
}

function manualSection(f) {
  const { a, r } = f;
  const groups = manualGroups(a, r);
  const kind = { form: 'Form', integration: 'Add-on', page: 'Page', media: 'Media', login: 'Login', cart: 'Shop' };
  const rows = groups.slice(0, 10).map((g) => [esc(kind[g.kind] ?? g.kind), `<b>${esc(g.title)}</b>${g.pages.length > 1 ? `<small class="term">${esc(listWords(g.pages.map((p) => clip(p, 40)), 4))}</small>` : ''}`, esc(clip(g.detail, 170))]);
  const lede = groups.length
    ? `${plural(groups.length, 'thing')} cannot be copied honestly by automation and ${groups.length === 1 ? 'is' : 'are'} listed instead of faked; a developer or the site owner should handle ${groups.length === 1 ? 'it' : 'them'}.`
    : 'Nothing needs to be rebuilt by hand.';
  return section('manual', 'Needs a person', esc(lede), `${table(['Kind', 'What', 'Why'], rows, 'checks')}${more(groups.length, 10)}`, 'Things like form backends, logins, shops and tracking that need a real server or an account.');
}

function aboutSection(f) {
  const { a, c, r } = f;
  const notes = [
    'Scores come from Lighthouse (Google’s page test, run with a simulated slow phone and network), the accessibility test axe and the tool’s own checks. Scores vary by a few points from run to run.',
    c?.scope?.pages?.length ? `The comparison covers the ${plural(c.scope.pages.length, 'page')} both sites have${c.scope.outOfScope?.length ? `; ${plural(c.scope.outOfScope.length, 'page')} of the original ${c.scope.outOfScope.length === 1 ? 'was' : 'were'} not copied and ${c.scope.outOfScope.length === 1 ? 'is' : 'are'} not compared` : ''}.` : null,
    c ? 'The copy was measured on a local preview: confirm speed once it is online. Checks that depend on hosting (secure connection, compression, caching) are judged only after it is deployed.' : null,
    c?.stale ? 'This comparison may be out of date: the copy or the check changed after it was made. Run the comparison again in the app.' : null,
    ...(c?.notes ?? []).filter((x) => !/local preview/i.test(x)),
    a?.errors?.length ? `Parts of the check did not finish: ${a.errors.slice(0, 4).map((e) => (e.step ? `${e.step} (${clip(e.message, 70)})` : clip(e.message ?? String(e), 80))).join('; ')}${a.errors.length > 4 ? `; ${a.errors.length - 4} more` : ''}.` : null,
    r ? 'Texts the copy wrote by itself are marked in the data and should be reviewed. The complete data, including every page and check, is in the JSON download.' : 'The complete data is in the JSON download.',
  ].filter(Boolean);
  return `<section id="about" class="sec about-sec"><h2>About this report</h2><ul>${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  <p>Prepared with Site Audit Studio for company-owned or authorized websites.</p></section>`;
}

// ---- Styles ---------------------------------------------------------------------------------------------------------

const CSS = `
:root{--ink:#101828;--ink2:#344054;--muted:#5d6879;--faint:#98a2b3;--line:#e4e7ec;--line2:#d0d5dd;--soft:#f8fafc;--soft2:#f2f4f7;
--accent:#c2410c;--accent-tint:#fff7ed;--accent-line:#fdba74;--ok:#067647;--ok-t:#ecfdf3;--warn:#b54708;--warn-t:#fffaeb;--bad:#b42318;--bad-t:#fef3f2;--info:#175cd3;--info-t:#eff8ff;--orig:#667085}
*{box-sizing:border-box}
html{background:#eef1f5}
body{margin:0;font:13.5px/1.5 'Segoe UI','Inter',system-ui,-apple-system,Arial,sans-serif;color:var(--ink);background:#eef1f5;font-variant-numeric:tabular-nums}
main{max-width:880px;margin:24px auto;padding:36px 40px 40px;background:#fff;border:1px solid var(--line)}
.mono,.url{font-family:Consolas,'JetBrains Mono',ui-monospace,monospace;font-size:.92em;word-break:break-all}
b,strong{font-weight:650}
small{font-size:.85em}
h1{margin:2px 0 0;font-size:26px;line-height:1.2;letter-spacing:-.015em;font-weight:700}
h3{margin:16px 0 6px;font-size:12.5px;font-weight:650;color:var(--ink)}
.eyebrow{margin:0;color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.url{margin:2px 0 0;color:var(--muted)}
header.top{padding-bottom:12px;border-bottom:2px solid var(--accent)}
.stages{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:12px;border:1px solid var(--line);border-radius:6px}
.stage{padding:6px 10px;border-left:1px solid var(--line);min-width:0}
.stage:first-child{border-left:0}
.stage span{display:block;font-size:10.5px;color:var(--muted);font-weight:600}
.stage b{display:block;font-size:12px}
.stage small{display:block;color:var(--muted);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage:not(.done) b{color:var(--faint)}
.verdict{margin:14px 0 12px;font-size:15px;line-height:1.5;color:var(--ink);padding-left:12px;border-left:3px solid var(--accent)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;font-size:10.5px;font-weight:650;color:var(--muted);padding:5px 8px;border-bottom:1px solid var(--line2);vertical-align:bottom}
td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
table.num td{white-space:nowrap}
table.num td:first-child{white-space:normal}
.term{display:block;color:var(--muted);font-weight:400;font-size:10.5px;line-height:1.35}
.rev{font-style:normal;color:var(--warn);font-weight:650}
.scores th small{font-weight:400}
.scores tbody th{padding:5px 8px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink);vertical-align:middle;width:30%}
.scores tbody th small{display:block;font-weight:400;color:var(--muted);font-size:10.5px}
.scores td{vertical-align:middle;padding:5px 8px}
.sc{display:grid;grid-template-columns:66px 104px 1fr;align-items:center;gap:8px}
.nums{font-size:12px;color:var(--muted);white-space:nowrap}.nums b{font-size:15px;color:var(--ink)}.nums i{font-style:normal;color:var(--faint)}
.chg{font-size:11.5px;font-weight:650;white-space:nowrap;text-align:right}.chg em{font-style:normal;font-weight:500}
.chg.ok,.t-ok{color:var(--ok)}.chg.warn,.t-warn{color:var(--warn)}.chg.bad,.t-bad{color:var(--bad)}.chg.none,.t-none{color:var(--muted)}
.db{display:block}
.db .trk{stroke:var(--line);stroke-width:2;stroke-linecap:round}.db .tick{stroke:var(--line2);stroke-width:1}
.db .lnk{stroke-width:2.4}.db .lnk.ok{stroke:var(--ok)}.db .lnk.bad{stroke:var(--bad)}.db .lnk.none{stroke:var(--faint)}
.db .dot-o{fill:#fff;stroke:var(--orig);stroke-width:1.6}.db .dot-n{fill:var(--accent);stroke:#fff;stroke-width:1.4}
.key{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:5px 0 0;color:var(--muted);font-size:10.5px}
.key i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 2px 0 6px}.key i:first-child{margin-left:0}
.k-o{border:1.6px solid var(--orig);background:#fff}.k-n{background:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:14px}
.tile{padding:7px 9px;border:1px solid var(--line);border-top:3px solid var(--line2);border-radius:4px}
.tile b{display:block;font-size:20px;line-height:1.15}
.tile span{display:block;font-size:11px;font-weight:650;color:var(--ink2)}
.tile small{display:block;font-size:10px;color:var(--muted)}
.tile.ok{border-top-color:var(--ok)}.tile.ok b{color:var(--ok)}.tile.warn{border-top-color:#f79009}.tile.warn b{color:var(--warn)}
.tile.bad{border-top-color:var(--bad)}.tile.bad b{color:var(--bad)}.tile.info{border-top-color:var(--info)}.tile.info b{color:var(--info)}
.cap,.more{margin:5px 0 0;color:var(--muted);font-size:10.5px}
.duo{display:grid;grid-template-columns:1fr 1.45fr;gap:18px;margin-top:14px;align-items:start}
.duo>:only-child{grid-column:1/-1}
.match{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.match h3{margin:0 0 4px}
.mrow{display:flex;align-items:center;gap:10px}
.big{font-size:34px;line-height:1;color:var(--accent);font-weight:700}
.mrow strong{display:block;font-size:13.5px}.mrow small{display:block;color:var(--muted);font-size:10.5px}
dl.mini{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:8px 0 0;font-size:11.5px}
dl.mini dt{color:var(--muted)}dl.mini dd{margin:0;font-weight:600}
.shots{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:flex-end}
.shots .cap{flex-basis:100%;margin:0}
figure{margin:0}
.shot div{display:flex;gap:5px;align-items:flex-end}
.shot img{display:block;border:1px solid var(--line2);border-radius:3px}
.shot img.d{width:150px}.shot img.m{width:42px}
.shot figcaption{margin-top:3px;font-size:10.5px;font-weight:650;color:var(--ink2)}
.next{margin-top:14px;padding:10px 14px;background:var(--accent-tint);border:1px solid var(--accent-line);border-radius:6px}
.next h3{margin:0 0 4px;color:var(--accent)}
.next ol{margin:0;padding-left:18px}.next li{margin:2px 0}
.sec{counter-increment:sec;margin-top:26px}
main{counter-reset:sec}
.sec h2{display:flex;align-items:baseline;gap:10px;margin:0;padding-bottom:5px;border-bottom:1px solid var(--ink);font-size:17px;letter-spacing:-.01em}
.sec h2::before{content:counter(sec);color:var(--accent);font-weight:700}
.about-sec{counter-increment:none}.about-sec h2::before{content:none}
.about{margin:5px 0 0;color:var(--muted);font-size:11px}
.lede{margin:6px 0 8px;font-size:13.5px;font-weight:600;color:var(--ink)}
.res{display:inline-flex;align-items:baseline;gap:5px;font-size:11px;font-weight:650;white-space:nowrap;color:var(--muted)}
.res i{font-style:normal;display:inline-block;width:13px;text-align:center}
.res.ok{color:var(--ok)}.res.warn{color:var(--warn)}.res.bad{color:var(--bad)}.res.info{color:var(--info)}
table.checks td:first-child{width:112px}
table.checks td:nth-child(2){width:31%}
table.pages td:first-child{width:46%}
table.pages .mono{font-size:10.5px}
table.pages td:nth-child(2){width:auto}
table.checks td:nth-child(3),table.checks td:nth-child(4){color:var(--ink2);font-size:11.5px}
table.facts td:first-child{width:150px;font-weight:650}
.fine{margin:6px 0 0;font-size:11px;color:var(--muted)}.fine b{color:var(--ink2)}
.built{margin:10px 0 0;font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.kpi{border:1px solid var(--line);border-radius:5px;padding:7px 10px}
.kpi span{display:block;font-size:11px;font-weight:650;color:var(--ink2)}
.kpi b{font-size:22px;line-height:1.2;margin-right:6px}.kpi em{font-style:normal;font-size:11.5px;font-weight:650;color:var(--muted)}
.kpi small{display:block;font-size:10px;color:var(--muted);line-height:1.35}
.split{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start}
.wchart figcaption{font-size:11px;font-weight:650;color:var(--ink2);max-width:230px}
.wchart figcaption small{display:block;font-weight:400;color:var(--muted);font-size:10px}
.wchart .bar{fill:var(--accent)}.wchart .bar-low{fill:var(--accent-line)}
.wchart .axis{stroke:var(--line2)}.wchart .thr{stroke:var(--ink2);stroke-dasharray:3 3;stroke-width:1;opacity:.6}
.wchart .bv{font-size:8.5px;text-anchor:middle;fill:var(--ink2);font-weight:600}.wchart .bl{font-size:8px;text-anchor:middle;fill:var(--muted)}
.warns{margin:0;padding-left:16px;font-size:11.5px;color:var(--ink2)}.warns li{margin:2px 0}
.about-sec ul{margin:6px 0 0;padding-left:16px;font-size:11px;color:var(--muted)}.about-sec p{font-size:11px;color:var(--muted);margin:6px 0 0}
@media (max-width:700px){main{margin:0;padding:20px 16px}.tiles{grid-template-columns:repeat(3,1fr)}.stages,.kpis{grid-template-columns:1fr 1fr}.duo,.split{grid-template-columns:1fr}}
@media print{
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{background:#fff}
body{font-size:11.5px}
main{max-width:none;margin:0;padding:0;border:0}
.page1.brk{break-after:page}
h1{font-size:23px}
.verdict{font-size:13.5px}
.lede{font-size:12.5px}
.sec{margin-top:18px}
.sec h2,h3{break-after:avoid}
.sec h2{font-size:15.5px}
.head{break-inside:avoid;break-after:avoid}
tr,.tile,.kpi,.match,.next,.shot,.wchart,.stage,.fine{break-inside:avoid}
thead{display:table-header-group}
table{font-size:11px}
td{padding:4px 7px}
}
@page{size:A4}
`;

/**
 * @param {Awaited<ReturnType<import('./collect.js').collectReport>>} d
 * @returns {string} the whole HTML document
 */
export function renderReportHtml(d) {
  const f = facts(d);
  const parts = [];
  if (f.a) {
    parts.push(speedSection(f), searchSection(f), accessSection(f));
    if (f.r) parts.push(copySection(f));
    if (manualGroups(f.a, f.r).length) parts.push(manualSection(f));
    parts.push(aboutSection(f));
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.project.name)} · website report</title>
<meta name="generator" content="Site Audit Studio"><style>${CSS}</style></head>
<body><main>
${summaryPage(d, f, parts.length > 0)}
${parts.join('\n')}
${f.a ? '' : '<p class="cap">Prepared with Site Audit Studio for company-owned or authorized websites.</p>'}
</main></body></html>`;
}

/** A file name for the download: <host>-audit-report-<date>.<ext> */
export function reportFileName(project, ext) {
  let host = 'site';
  try {
    host = new URL(project.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep the default */
  }
  return `${host.replace(/[^a-z0-9.-]/gi, '-')}-audit-report-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
