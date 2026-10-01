// The report as one self-contained HTML file: inline styles, inline images, no script and no external request, so
// it can be saved, e-mailed, opened offline, printed and turned into a PDF (report/pdf.js). It is written for a
// client: a summary first, then numbered sections, and only what a reader needs - the scores, what is wrong, what was
// fixed and what still needs a person. Passing checks are counted, not listed. Every value from the audit or the
// recreate goes through esc(): site names, titles and URLs come from the pages that were analysed.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const date = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
};
const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const bytes = (v) => (v == null ? '—' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`);
const scoreTone = (s) => (s == null ? 'none' : s >= 90 ? 'ok' : s >= 50 ? 'warn' : 'bad');
const fidTone = (s, t = 80) => (s == null ? 'none' : s >= t ? 'ok' : s >= t - 15 ? 'warn' : 'bad');
const STATUS_TONE = { pass: 'ok', ok: 'ok', fixed: 'ok', improved: 'ok', warn: 'warn', changed: 'info', recheck: 'warn', manual: 'warn', open: 'bad', fail: 'bad', regressed: 'bad', na: 'none' };
const STATUS_LABEL = { pass: 'Pass', ok: 'OK', fixed: 'Fixed', improved: 'Improved', warn: 'Warning', fail: 'Fail', open: 'Still open', regressed: 'Regressed', changed: 'Changed', recheck: 'Recheck', manual: 'Manual', na: 'N/A' };
// How many rows a list shows before it says "+N more" (the full data is in the JSON download).
const MAX_ROWS = 12;

/** A small coloured label (severity, score, count). */
const pill = (text, tone = 'none') => `<span class="pill ${tone}">${esc(text)}</span>`;
/** A status as a coloured dot and a word: quieter than a filled badge in a long table. */
const status = (s) => `<span class="st ${STATUS_TONE[s] ?? 'none'}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
const more = (total, shown) => (total > shown ? `<p class="note">+ ${total - shown} more in the JSON download.</p>` : '');

/** A score ring (static SVG). */
function ring(value, label, tone = scoreTone(value)) {
  const c = 2 * Math.PI * 15;
  const dash = value == null ? 0 : (Math.max(0, Math.min(100, value)) / 100) * c;
  return `<div class="ring ${tone}"><svg viewBox="0 0 36 36" width="54" height="54" aria-hidden="true"><circle cx="18" cy="18" r="15" class="track"/><circle cx="18" cy="18" r="15" class="arc" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 18 18)"/></svg><b>${value ?? '—'}</b><span>${esc(label)}</span></div>`;
}

const table = (head, rows) =>
  rows.length
    ? `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '';
const section = (id, title, body, sub = '') => `<section id="${id}" class="card"><h3>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h3>${body}</section>`;
const kpi = (label, value, tone = 'none', sub = '') => `<div class="kpi ${tone}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;

// ---- Charts: inline SVG / CSS, no script -------------------------------------------------------------------------

const TONE_COLOR = { ok: '#0a8f62', warn: '#f59e0b', bad: '#d81b4a', info: '#2557d6', none: '#c9cbe0' };

/** A donut chart with the total in the middle and a legend. segments: [{ label, value, tone }] */
function donut(segments, centerLabel) {
  const list = segments.filter((s) => s.value > 0);
  const total = list.reduce((n, s) => n + s.value, 0);
  if (!total) return '<p class="note">No data.</p>';
  let used = 0;
  const arcs = list.map((s) => {
    const pct = (s.value / total) * 100;
    const arc = `<circle cx="18" cy="18" r="15.9155" fill="none" stroke="${TONE_COLOR[s.tone] ?? s.color ?? TONE_COLOR.none}" stroke-width="4.4" stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${(25 - used).toFixed(2)}"/>`;
    used += pct;
    return arc;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 36 36" width="104" height="104" role="img" aria-label="${esc(centerLabel)}"><circle cx="18" cy="18" r="15.9155" fill="none" stroke="#eef0f8" stroke-width="4.4"/>${arcs}<text x="18" y="18.6" text-anchor="middle" class="dn">${total}</text><text x="18" y="23.4" text-anchor="middle" class="dl">${esc(centerLabel)}</text></svg>
    <ul class="legend">${list.map((s) => `<li><i style="background:${TONE_COLOR[s.tone] ?? TONE_COLOR.none}"></i>${esc(s.label)}<b>${s.value}</b></li>`).join('')}</ul></div>`;
}

/** Horizontal bars 0-100 with an optional threshold mark. rows: [{ label, value, tone }] */
function hbars(rows, { threshold } = {}) {
  if (!rows.length) return '<p class="note">No data.</p>';
  return `<div class="hbars">${rows.map((r) => `<div class="hb"><span class="hl" title="${esc(r.label)}">${esc(r.label)}</span><span class="ht"><i class="${r.tone}" style="width:${Math.max(0, Math.min(100, r.value ?? 0))}%"></i>${threshold != null ? `<u style="left:${threshold}%"></u>` : ''}</span><b>${r.value ?? '—'}</b></div>`).join('')}</div>`;
}

/** Vertical bars 0-100 (one per column) with an optional threshold line. rows: [{ label, value, tone }] */
function vbars(rows, { threshold } = {}) {
  if (!rows.length) return '<p class="note">No data.</p>';
  return `<div class="vbars">${threshold != null ? `<u style="bottom:${(15 + 0.72 * threshold).toFixed(1)}px"></u>` : ''}${rows.map((r) => `<div class="vc"><b>${r.value ?? '—'}</b><span class="vt"><i class="${r.tone}" style="height:${Math.max(2, Math.min(100, r.value ?? 0))}%"></i></span><em>${esc(r.label)}</em></div>`).join('')}</div>`;
}

/** Two bars per row (before and after), both 0-100. rows: [{ label, before, after }] */
function groupedBars(rows, names = ['Original', 'Recreated']) {
  return `<div class="gbars">${rows.map((r) => `<div class="gb"><span class="hl">${esc(r.label)}</span><span class="gt">${[r.before, r.after].map((v, i) => (v == null ? '' : `<i class="g${i}" style="width:${Math.max(1, Math.min(100, v))}%"><b>${v}</b></i>`)).join('')}</span></div>`).join('')}<p class="key"><i class="g0"></i>${esc(names[0])}<i class="g1"></i>${esc(names[1])}</p></div>`;
}

const chartCard = (title, body, sub = '') => `<div class="chart"><h4>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h4>${body}</div>`;

/** "At a glance": the main numbers as small charts. */
function glance(d) {
  const a = d.audit;
  const r = d.recreate;
  const c = a.recreate;
  const charts = [];
  const LABEL = { performance: 'Performance', seo: 'SEO', accessibility: 'Accessibility', bestPractices: 'Best practices' };
  const mobile = a.scores?.mobile;
  const after = c && !c.isDummy ? c.scores?.after?.mobile : null;
  if (d.analyzed && mobile) {
    charts.push(chartCard('Lighthouse scores', groupedBars(Object.keys(LABEL).map((k) => ({ label: LABEL[k], before: mobile[k], after: after?.[k] })), ['Original', 'Recreated']), after ? 'mobile, original vs recreated' : 'mobile'));
  }
  if (d.analyzed) {
    const crawl = a.crawl ?? {};
    const checks = [...(a.seo ?? []), ...(a.aeo ?? []), ...[crawl.sitemap, crawl.robots, crawl.metaTags].filter((x) => x?.status)];
    const count = (s) => checks.filter((x) => (s === 'pass' ? x.status === 'pass' : s === 'warn' ? x.status === 'warn' : !['pass', 'warn'].includes(x.status))).length;
    charts.push(chartCard('Original: SEO, AEO and crawl checks', donut([{ label: 'Passing', value: count('pass'), tone: 'ok' }, { label: 'Warnings', value: count('warn'), tone: 'warn' }, { label: 'Failing', value: count('fail'), tone: 'bad' }], 'checks')));
  }
  if (c && !c.isDummy && c.summary) {
    const s = c.summary;
    charts.push(chartCard('Fix checklist', donut([
      { label: 'Fixed / improved', value: (s.fixed ?? 0) + (s.improved ?? 0), tone: 'ok' },
      { label: 'Passing on both', value: s.pass ?? 0, tone: 'info' },
      { label: 'Needs a person', value: (s.manual ?? 0) + (s.recheck ?? 0) + (s.changed ?? 0), tone: 'warn' },
      { label: 'Still open', value: (s.open ?? 0) + (s.regressed ?? 0), tone: 'bad' },
    ], 'checks'), 'original vs recreated'));
  }
  if (r?.fidelity?.pages?.length) {
    const t = r.fidelity.threshold ?? 80;
    charts.push(chartCard('Fidelity by page', hbars(r.fidelity.pages.slice(0, 8).map((p) => ({ label: p.path, value: p.score, tone: fidTone(p.score, t) })), { threshold: t }), `line = ${t}`));
  }
  return charts.length ? `<section class="card"><h3>At a glance</h3><div class="charts">${charts.join('')}</div></section>` : '';
}

// Small pictures: the width a view is shown at (px); the picture itself has twice that for sharpness.
const SHOT_WIDTH = { desktop: 220, tablet: 115, mobile: 70 };
const shot = (src, label, view) => (src ? `<figure style="flex:0 0 ${SHOT_WIDTH[view]}px"><img src="${src}" alt="${esc(label)}"/></figure>` : '');
const shotRow = (images, name) => `<div class="shots">${['desktop', 'tablet', 'mobile'].map((v) => shot(images[v], `${name} · ${v}`, v)).join('')}</div>`;
const hasShots = (images) => Object.values(images ?? {}).some(Boolean);

/** The first screen of the original and (when there is one) of the recreate, at three sizes, small. */
function snapshot(d) {
  if (!hasShots(d.images.old) && !hasShots(d.images.new)) return '';
  const both = hasShots(d.images.new);
  const body = `<div class="sets"><div><h4>Original</h4>${shotRow(d.images.old, 'Original')}</div>${both ? `<div><h4>Recreated</h4>${shotRow(d.images.new, 'Recreated')}</div>` : ''}</div>`;
  return section('snapshot', both ? 'Original and recreated' : 'The original site', body, 'homepage, first screen · 1440 / 768 / 375 px');
}

// ---- Summary ------------------------------------------------------------------------------------------------------

/** Four or five plain sentences: where the site stands, what the recreate achieved, what is left. */
function highlights(d) {
  const a = d.audit;
  const r = d.recreate;
  const c = a.recreate;
  const out = [];
  if (d.analyzed) {
    const m = a.scores?.mobile;
    const checks = [...(a.seo ?? []), ...(a.aeo ?? [])];
    const issues = checks.filter((i) => i.status !== 'pass').length;
    const names = (a.techStack ?? []).map((t) => t.name).slice(0, 3).join(', ');
    out.push({ tone: scoreTone(m?.performance), text: `The original site${names ? ` (${names})` : ''} scores ${m?.performance ?? '—'} for performance, ${m?.seo ?? '—'} for SEO and ${m?.accessibility ?? '—'} for accessibility on mobile (Lighthouse).` });
    out.push({ tone: issues || a.brokenLinks?.broken?.length ? 'warn' : 'ok', text: `${issues} SEO / AEO ${issues === 1 ? 'issue' : 'issues'}, ${a.brokenLinks?.broken?.length ?? 0} broken ${a.brokenLinks?.broken?.length === 1 ? 'link' : 'links'} and ${a.accessibility?.length ?? 0} accessibility ${a.accessibility?.length === 1 ? 'issue type' : 'issue types'} were found across ${num(a.pagesCrawled)} crawled pages.` });
  } else {
    out.push({ tone: 'none', text: 'The original site has not been analyzed yet.' });
  }
  if (r?.fidelity) {
    const resp = r.responsive?.status === 'done' ? r.responsive : null;
    out.push({ tone: fidTone(r.fidelity.score, r.fidelity.threshold), text: `${r.pages?.length ?? 0} ${r.pages?.length === 1 ? 'page was' : 'pages were'} recreated (${r.stack ?? 'html'}): fidelity ${r.fidelity.score ?? '—'}/100, visual difference ${r.fidelity.diff?.score ?? '—'}/100${resp ? `, layout between screen widths ${resp.score}/100` : ''}.` });
  } else if (d.analyzed) {
    out.push({ tone: 'none', text: 'The site has not been recreated yet.' });
  }
  if (c && !c.isDummy && c.summary) {
    out.push({ tone: c.summary.regressed ? 'bad' : c.summary.open ? 'warn' : 'ok', text: `After recreating: ${c.summary.fixed ?? 0} checks fixed, ${c.summary.open ?? 0} still open, ${c.summary.regressed ?? 0} regressed.` });
  }
  const manual = (a.manualRebuild?.length ?? 0) + (r?.manual?.length ?? 0);
  const auto = r?.autoGenerated?.length ?? 0;
  if (manual || auto) out.push({ tone: 'warn', text: `${manual ? `${manual} ${manual === 1 ? 'item needs' : 'items need'} a manual rebuild` : ''}${manual && auto ? '; ' : ''}${auto ? `${auto} generated ${auto === 1 ? 'value needs' : 'values need'} a review` : ''}.` });
  return out;
}

// ---- Part 1: the original site (the OLD panel) ------------------------------------------------------------

function oldPart(d) {
  const a = d.audit;
  if (!d.analyzed) {
    return `<h2 id="old"><span class="chip old">OLD</span>Original site</h2>${section('old-none', 'Not analyzed yet', '<p class="empty">Run Analyze for this project to include the audit of the original site.</p>')}`;
  }
  const parts = [`<h2 id="old"><span class="chip old">OLD</span>Original site<small>${esc(a.url)}</small></h2>`];

  // Performance: the four Lighthouse scores per device and the numbers behind them.
  const sc = a.scores ?? {};
  const rings = (s) => (s ? [ring(s.performance, 'Performance'), ring(s.seo, 'SEO'), ring(s.accessibility, 'Accessibility'), ring(s.bestPractices, 'Best practices')].join('') : '<p class="note">Lighthouse did not finish.</p>');
  const md = a.metricsByDevice ?? { mobile: a.metrics, desktop: null };
  const metricRow = (m) => (m ? [ms(m.loadTime), ms(m.lcp), ms(m.tbt), m.cls ?? '—', bytes(m.pageSize)] : ['—', '—', '—', '—', '—']);
  parts.push(section('old-perf', 'Performance', `
    <div class="rings2"><div><h4>Mobile</h4><div class="rings">${rings(sc.mobile)}</div></div><div><h4>Desktop</h4><div class="rings">${rings(sc.desktop)}</div></div></div>
    ${table(['Device', 'Load time', 'LCP', 'TBT', 'CLS', 'Page size'], [['Mobile', ...metricRow(md.mobile)], ['Desktop', ...metricRow(md.desktop)]])}`,
  `Lighthouse, homepage · analyzed ${date(a.analyzedAt)} · ${num(a.pagesCrawled)} pages crawled`));

  // Platform and weaknesses.
  const stack = (a.techStack ?? []).map((t) => pill(`${t.name} · ${t.confidence ?? '—'}%`, 'info')).join(' ');
  const weak = (a.weaknesses ?? []).slice(0, MAX_ROWS);
  parts.push(section('old-stack', 'Platform and weaknesses', `${stack ? `<p>${stack}</p>` : '<p class="note">No platform recognised (Custom / Unknown).</p>'}${
    weak.length ? table(['Severity', 'Weakness', 'Detail'], weak.map((w) => [pill(w.severity, w.severity === 'high' ? 'bad' : w.severity === 'medium' ? 'warn' : 'info'), `<b>${esc(w.title)}</b>`, esc(w.detail)])) : ''}`));

  // SEO, AEO and crawl files in one list: only what is not passing.
  const crawl = a.crawl ?? {};
  const checks = [
    ...(a.seo ?? []).map((i) => ({ group: 'SEO', ...i })),
    ...(a.aeo ?? []).map((i) => ({ group: 'AEO', ...i })),
    ...[['sitemap.xml', crawl.sitemap], ['robots.txt', crawl.robots], ['Meta tags', crawl.metaTags]].filter(([, v]) => v?.status).map(([title, v]) => ({ group: 'Crawl', title, status: v.status, detail: v.detail })),
  ];
  const passing = checks.filter((i) => i.status === 'pass').length;
  const issues = checks.filter((i) => i.status !== 'pass');
  parts.push(section('old-checks', 'SEO, AEO and crawl', `${issues.length
    ? table(['Status', 'Area', 'Check', 'Result'], issues.slice(0, MAX_ROWS * 2).map((i) => [status(i.status), esc(i.group), `<b>${esc(i.title)}</b>`, esc(i.detail)]))
    : '<p class="empty">Every check passes.</p>'}${more(issues.length, MAX_ROWS * 2)}`, `${issues.length} to look at · ${passing} passing`));

  // Links and accessibility.
  const bl = a.brokenLinks ?? {};
  const broken = bl.broken ?? [];
  const a11y = (a.accessibility ?? []).slice(0, 8);
  parts.push(section('old-links', 'Broken links and accessibility', `
    <p><b>${num(broken.length)}</b> of ${num(bl.checked)} links checked ${broken.length === 1 ? 'is' : 'are'} broken${bl.unverified?.length ? `; ${num(bl.unverified.length)} could not be verified` : ''}.</p>
    ${table(['Link', 'Result', 'Found on'], broken.slice(0, 8).map((l) => [`<span class="mono">${esc(l.url)}</span>`, pill(l.status, 'bad'), `<span class="mono">${esc(l.foundOn)}</span>`]))}${more(broken.length, 8)}
    ${a11y.length ? table(['Impact', 'Accessibility issue (axe)', 'Elements'], a11y.map((i) => [pill(i.impact, i.impact === 'critical' || i.impact === 'serious' ? 'bad' : 'warn'), `<b>${esc(i.title)}</b>`, num(i.count)])) : '<p class="note">No accessibility issues on the homepage.</p>'}`));

  if (a.manualRebuild?.length) {
    parts.push(section('old-manual', 'Manual rebuild needed', table(['Kind', 'What', 'Why'], a.manualRebuild.slice(0, MAX_ROWS).map((m) => [pill(m.kind, 'warn'), `<b>${esc(m.title)}</b>`, esc(m.detail)]))));
  }
  return parts.join('');
}

// ---- Part 2: the recreated site (the NEW panel) ---------------------------------------------------------------

function newPart(d) {
  const r = d.recreate;
  if (!r) {
    return `<h2 id="new"><span class="chip new">NEW</span>Recreated site</h2>${section('new-none', 'Not recreated yet', '<p class="empty">Run Recreate for this project to include the recreated site in the report.</p>')}`;
  }
  const parts = [`<h2 id="new"><span class="chip new">NEW</span>Recreated site</h2>`];
  const f = r.fidelity;
  const resp = r.responsive?.status === 'done' ? r.responsive : null;
  const t = f?.threshold ?? 80;
  const dt = f?.diff?.threshold ?? 65;

  // How close the recreate is: per page, with the weakest size, and the layout between the captured widths.
  const weakest = (p) => {
    const views = Object.entries(p.views ?? {}).filter(([, v]) => v.score != null).sort((x, y) => x[1].score - y[1].score);
    return views.length ? `${views[0][0] === 'mobile' ? 'phone' : views[0][0]} ${views[0][1].score}` : '—';
  };
  parts.push(section('new-fidelity', 'How close is the recreate', `
    <div class="kpis">
      ${kpi('Fidelity', f?.score ?? '—', fidTone(f?.score, t), `threshold ${t}`)}
      ${kpi('Visual difference', f?.diff?.score ?? '—', fidTone(f?.diff?.score, dt), `threshold ${dt}`)}
      ${kpi('Between widths', resp?.score ?? '—', fidTone(resp?.score, dt), resp ? `${resp.driftCount} of ${resp.measured} drift` : 'not measured')}
      ${kpi('Pages', r.pages?.length ?? 0, 'none', 'recreated')}
    </div>
    ${table(['Page', 'Fidelity', 'Visual diff', 'Weakest size'], (f?.pages ?? []).slice(0, MAX_ROWS).map((p) => [`<span class="mono">${esc(p.path)}</span>`, pill(p.score ?? '—', fidTone(p.score, t)), pill(p.diff?.score ?? '—', fidTone(p.diff?.score, dt)), esc(weakest(p))]))}${more(f?.pages?.length ?? 0, MAX_ROWS)}
    ${resp ? chartCard('Layout between screen widths', vbars(resp.widths.map((w) => ({ label: `${w}`, value: resp.byWidth?.[w], tone: fidTone(resp.byWidth?.[w], dt) })), { threshold: dt }), `score per width in px · line = ${dt}`) : ''}
    <p class="note">Fidelity: element sizes and positions plus a rough picture comparison (below ${t} is flagged). Visual difference: perceptual comparison of the screenshots (below ${dt} is flagged). Recreated ${esc(date(r.createdAt))} · output ${esc(r.stack ?? 'html')}.</p>`));

  // What was built, fixed and left to a person.
  const v = r.verify;
  const rows = [
    v && ['Links, assets, HTML', `${status(v.brokenLinks?.length || v.missingAssets?.length || v.html?.errors ? 'fail' : 'pass')} ${num(v.checked?.links)} links and ${num(v.checked?.assets)} assets resolve${v.html?.warnings ? `; ${v.html.warnings} HTML warnings carried over from the original` : ''}`],
    r.safety && ['Safety', `${status(r.safety.safe ? 'pass' : 'fail')} ${r.safety.safe ? 'no script and no external reference' : 'issues found'}`],
    r.fixes?.length && ['Fixes applied', esc(r.fixes.slice(0, 10).map((x) => `${x.title}${x.count ? ` (${x.count})` : ''}`).join(' · '))],
    r.autoGenerated?.length && ['Auto-generated', `${num(r.autoGenerated.length)} values (descriptions, alt text, …) were written from the page content because the original had none. Please review them.`],
  ].filter(Boolean);
  const outs = Object.entries(r.outputs ?? {}).filter(([k, o]) => k !== 'html' && o.status === 'ready');
  if (outs.length) rows.push(['Other stacks', esc(outs.map(([k, o]) => `${k}${o.build?.js?.gzipBytes ? ` (${bytes(o.build.js.gzipBytes)} JS)` : ''}`).join(' · '))]);
  parts.push(section('new-build', 'Built, fixed and left to review', table(['', 'Result'], rows)));

  if (r.manual?.length) {
    parts.push(section('new-manual', 'Manual rebuild needed', table(['Kind', 'What', 'Why'], r.manual.slice(0, MAX_ROWS).map((m) => [pill(m.kind, 'warn'), `<b>${esc(m.title)}</b>`, esc(m.detail)])) + more(r.manual.length, MAX_ROWS)));
  }
  if (r.warnings?.length) parts.push(section('new-warn', 'Warnings', `<ul class="warns">${r.warnings.slice(0, 6).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${more(r.warnings.length, 6)}`));
  return parts.join('');
}

// ---- Part 3: the fix checklist (the re-audit) ---------------------------------------------------------------------

function checklistPart(d) {
  const c = d.audit.recreate;
  if (!c || c.isDummy || !c.items) {
    return `<h2 id="fix"><span class="chip fix">FIX</span>Fix checklist</h2>${section('fix-none', 'Not available', `<p class="empty">${esc(d.recreate ? 'The recreated site has not been re-audited yet. Run Re-audit in the NEW panel.' : 'Recreate the site first; the fix checklist compares the original with the recreated site.')}</p>`)}`;
  }
  const s = c.summary ?? {};
  const parts = [`<h2 id="fix"><span class="chip fix">FIX</span>Fix checklist<small>original vs recreated${c.stackLabel ? ` · ${esc(c.stackLabel)}` : ''}</small></h2>`];
  const LABEL = { performance: 'Performance', seo: 'SEO', accessibility: 'Accessibility', bestPractices: 'Best practices' };
  const cell = (side, k) => {
    const b = c.scores?.before?.[side]?.[k];
    const a = c.scores?.after?.[side]?.[k];
    const delta = a != null && b != null ? ` <b class="${a - b >= 0 ? 'okt' : 'badt'}">${a - b >= 0 ? '+' : ''}${a - b}</b>` : '';
    return `${pill(b ?? '—', scoreTone(b))} → ${pill(a ?? '—', scoreTone(a))}${delta}`;
  };
  parts.push(section('fix-scores', 'Lighthouse, before and after', `${table(['', 'Mobile', 'Desktop'], Object.keys(LABEL).map((k) => [esc(LABEL[k]), cell('mobile', k), cell('desktop', k)]))}
    <div class="chips">${['fixed', 'improved', 'open', 'regressed', 'changed', 'recheck', 'manual', 'na'].filter((k) => s[k]).map((k) => pill(`${STATUS_LABEL[k]} · ${s[k]}`, STATUS_TONE[k])).join('')}${pill(`Passing on both sides · ${s.pass ?? 0}`, 'ok')}</div>
    <p class="note">${c.scope?.pages?.length ? `${c.scope.pages.length} pages compared` : ''}${c.scope?.outOfScope?.length ? `, ${c.scope.outOfScope.length} original pages were not recreated` : ''}. The recreate is measured on a local preview with simulated throttling: confirm the performance after deploying.</p>`));

  const label = Object.fromEntries((c.categories ?? []).map((x) => [x.id, x.label]));
  const attention = (c.items ?? []).filter((i) => ['regressed', 'open', 'recheck', 'changed', 'manual'].includes(i.status));
  if (attention.length) {
    parts.push(section('fix-open', 'Needs attention', table(['Status', 'Check', 'Area', 'Before → now'], attention.slice(0, 20).map((i) => [
      status(i.status), `<b>${esc(i.title)}</b>${i.review ? ' <small class="reviewtag">review</small>' : ''}`, esc(label[i.category] ?? i.category), esc(`${i.before?.detail ?? i.before?.status ?? '—'} → ${i.after?.detail ?? i.after?.status ?? '—'}`),
    ])) + more(attention.length, 20)));
  }
  const fixed = (c.items ?? []).filter((i) => i.status === 'fixed' || i.status === 'improved');
  if (fixed.length) {
    parts.push(section('fix-done', 'Fixed', `<div class="chips">${fixed.slice(0, 30).map((i) => pill(i.title, 'ok')).join('')}</div>${more(fixed.length, 30)}`, `${fixed.length} checks`));
  }
  return parts.join('');
}

const CSS = `
:root{--ink:#14142b;--ink2:#34365c;--muted:#6a6e94;--line:#e5e7f3;--soft:#f6f7fc;--brand:#5b3df5;--ok:#0a8f62;--okbg:#e8f8f1;--warn:#b8530b;--warnbg:#fff4e2;--bad:#d81b4a;--badbg:#fff0f3;--info:#2557d6;--infobg:#ecf2ff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 'Inter','Segoe UI',system-ui,-apple-system,sans-serif;color:var(--ink);background:#eef0f8}
.mono{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:.9em;word-break:break-all}
main{max-width:980px;margin:0 auto;padding:28px 22px 56px;background:#fff;box-shadow:0 0 0 1px var(--line),0 24px 60px rgba(40,40,100,.08);counter-reset:part}
header.cover{position:relative;overflow:hidden;margin:-28px -22px 0;padding:34px 40px 30px;color:#fff;background:linear-gradient(135deg,#14142b 0%,#2b2470 55%,#5b3df5 130%)}
header.cover::before{content:'';position:absolute;left:0;top:0;bottom:0;width:6px;background:linear-gradient(180deg,#8b6cff,#ec4899)}
header.cover small{opacity:.8;letter-spacing:.16em;text-transform:uppercase;font-weight:700;font-size:11px}
header.cover h1{margin:8px 0 4px;font-size:32px;letter-spacing:-.025em;font-weight:750}
header.cover p{margin:0;opacity:.85}
header.cover .meta{margin-top:18px;display:flex;flex-wrap:wrap;gap:6px 22px;font-size:12px;opacity:.9}
header.cover .meta b{opacity:.65;font-weight:600;margin-right:6px;text-transform:uppercase;letter-spacing:.08em;font-size:10.5px}
.band{margin:0 -22px;padding:16px 40px;background:var(--soft);border-bottom:1px solid var(--line)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.band .kpis{margin:0}
.kpi{border-radius:10px;padding:9px 12px;background:#fff;border:1px solid var(--line);border-top:3px solid var(--line)}
.kpi span{display:block;font-size:11px;color:var(--muted);font-weight:600}
.kpi b{display:block;font-size:25px;line-height:1.2;letter-spacing:-.03em}
.kpi small{color:var(--muted);font-size:11px}
.kpi.ok{border-top-color:var(--ok)}.kpi.ok b{color:var(--ok)}
.kpi.warn{border-top-color:#f59e0b}.kpi.warn b{color:var(--warn)}
.kpi.bad{border-top-color:var(--bad)}.kpi.bad b{color:var(--bad)}
nav.toc{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0}
nav.toc a{padding:3px 12px;border-radius:999px;border:1px solid var(--line);color:var(--ink2);text-decoration:none;font-weight:600;font-size:12px}
h2{counter-increment:part;counter-reset:sec;display:flex;align-items:baseline;gap:10px;margin:30px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--ink);font-size:20px;letter-spacing:-.02em}
h2::before{content:counter(part) '.';color:var(--brand);font-weight:800}
h2 small{margin-left:auto;font-size:11.5px;color:var(--muted);font-weight:500;word-break:break-all}
h3{counter-increment:sec;display:flex;align-items:baseline;gap:10px;margin:0 0 10px;font-size:14.5px}
h3::before{content:counter(part) '.' counter(sec);color:var(--brand);font-weight:700;font-size:12.5px}
h3 small{margin-left:auto;color:var(--muted);font-weight:500;font-size:11.5px;text-align:right}
h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.chip{display:inline-block;padding:1px 9px;border-radius:5px;font:700 11px/1.6 'JetBrains Mono',monospace;letter-spacing:.08em;color:#fff;align-self:center}
.chip.old{background:#0b7bb5}.chip.new{background:var(--brand)}.chip.fix{background:var(--ok)}
.card{margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid var(--line)}
.card:last-child{border-bottom:0}
.sumlist{list-style:none;margin:0;padding:0}
.sumlist li{position:relative;padding:5px 0 5px 20px}
.sumlist li::before{content:'';position:absolute;left:2px;top:12px;width:8px;height:8px;border-radius:50%;background:var(--muted)}
.sumlist li.ok::before{background:var(--ok)}.sumlist li.warn::before{background:#f59e0b}.sumlist li.bad::before{background:var(--bad)}
.pill{display:inline-block;padding:0 8px;border-radius:5px;font-size:11px;font-weight:700;line-height:1.7;background:var(--soft);color:var(--ink2);border:1px solid var(--line)}
.pill.ok{background:var(--okbg);color:var(--ok);border-color:#c4ebdb}
.pill.warn{background:var(--warnbg);color:var(--warn);border-color:#fcdba5}
.pill.bad{background:var(--badbg);color:var(--bad);border-color:#ffc7d3}
.pill.info{background:var(--infobg);color:var(--info);border-color:#cbdcff}
.st{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;white-space:nowrap}
.st::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--muted)}
.st.ok{color:var(--ok)}.st.ok::before{background:var(--ok)}
.st.warn{color:var(--warn)}.st.warn::before{background:#f59e0b}
.st.bad{color:var(--bad)}.st.bad::before{background:var(--bad)}
.st.info{color:var(--info)}.st.info::before{background:var(--info)}
.okt{color:var(--ok);font-weight:700}.badt{color:var(--bad);font-weight:700}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:6px 8px;background:var(--soft);border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
tr:last-child td{border-bottom:0}
.note{margin:8px 0 0;color:var(--muted);font-size:12px}
.empty{margin:0;padding:9px 12px;border-radius:8px;background:var(--soft);color:var(--muted)}
.rings{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px}
.rings2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.ring{position:relative;display:grid;justify-items:center;width:70px}
.ring .track{fill:none;stroke:#e9e8fb;stroke-width:3.4}
.ring .arc{fill:none;stroke-width:3.4;stroke-linecap:round}
.ring.ok .arc{stroke:var(--ok)}.ring.warn .arc{stroke:#f59e0b}.ring.bad .arc{stroke:var(--bad)}
.ring b{position:absolute;top:15px;font-size:15px}
.ring span{font-size:10.5px;color:var(--muted);font-weight:600;text-align:center}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
.chart{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fff}
.chart h4{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 8px}
.chart h4 small{text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted);font-size:10.5px}
.donut{display:flex;align-items:center;gap:14px}
.donut svg{flex:none}
.dn{font:800 8px 'Inter',sans-serif;fill:var(--ink)}.dl{font:600 2.6px 'Inter',sans-serif;fill:var(--muted)}
.legend{list-style:none;margin:0;padding:0;font-size:12px;flex:1}
.legend li{display:flex;align-items:center;gap:7px;padding:2px 0}
.legend li i{width:9px;height:9px;border-radius:3px;flex:none}
.legend li b{margin-left:auto}
.hbars{display:grid;gap:5px}
.hb{display:grid;grid-template-columns:96px 1fr 26px;align-items:center;gap:8px;font-size:11.5px}
.hl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}
.ht{position:relative;height:9px;border-radius:5px;background:#eef0f8}
.ht i{display:block;height:100%;border-radius:5px;background:var(--muted)}
.ht u{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.45}
.hb b{text-align:right;font-size:11.5px}
.i.ok,.ht i.ok,.vt i.ok{background:var(--ok)}.ht i.warn,.vt i.warn{background:#f59e0b}.ht i.bad,.vt i.bad{background:var(--bad)}.ht i.none,.vt i.none{background:#c9cbe0}
.vbars{position:relative;display:flex;align-items:flex-end;gap:7px;height:118px;padding-top:4px}
.vbars u{position:absolute;left:0;right:0;border-top:2px dashed rgba(20,20,43,.35);height:0}
.vc{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%;justify-content:flex-end}
.vc b{font-size:10.5px}
.vt{display:flex;align-items:flex-end;width:100%;height:72px;border-radius:4px 4px 0 0;background:#f3f4fb}
.vt i{display:block;width:100%;border-radius:4px 4px 0 0}
.vc em{font-style:normal;font-size:10px;color:var(--muted)}
.gbars{display:grid;gap:7px}
.gb{display:grid;grid-template-columns:92px 1fr;align-items:center;gap:8px;font-size:11.5px}
.gt{display:grid;gap:3px}
.gt i{display:block;height:10px;border-radius:5px;position:relative;min-width:18px}
.gt i b{position:absolute;right:5px;top:-1px;font-size:8.5px;line-height:10px;color:#fff}
.g0{background:#a99bff}.g1{background:var(--brand)}
.key{display:flex;align-items:center;gap:6px;margin:2px 0 0;color:var(--muted);font-size:10.5px}
.key i{width:9px;height:9px;border-radius:3px;display:inline-block}
.key i+*{margin-right:6px}
.shots{display:flex;gap:10px;align-items:flex-end}
.sets{display:flex;flex-wrap:wrap;gap:12px 30px}
figure{margin:0;min-width:0}
figure img{display:block;width:100%;border-radius:6px;border:1px solid var(--line);box-shadow:0 3px 10px rgba(40,40,100,.12)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
.warns{margin:0;padding-left:18px;color:var(--warn);font-size:12.5px}
.warns li{margin:2px 0}
.reviewtag{background:var(--warnbg);color:var(--warn);border-radius:4px;padding:0 6px;font-weight:700}
footer{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px}
@media print{
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#fff;font-size:12px}
main{max-width:none;padding:0;box-shadow:none}
header.cover{margin:0;padding:24px 28px 22px}
header.cover h1{font-size:27px}
.band{margin:0;padding:12px 28px}
nav.toc{display:none}
h2{break-after:avoid;margin:20px 0 9px;font-size:18px}
h3{break-after:avoid}
.card{margin-bottom:9px;padding-bottom:9px}
.tablewrap{overflow:visible}
table{font-size:11px}
tr,figure,.kpi,.ring,.pill,.shots,.sets,.empty,.sumlist li,.chart{break-inside:avoid}
thead{display:table-header-group}
td,th{padding:4px 7px}
.kpis{break-inside:avoid}
}
@page{size:A4}
`;

/**
 * @param {Awaited<ReturnType<import('./collect.js').collectReport>>} d
 * @returns {string} the whole HTML document
 */
export function renderReportHtml(d) {
  const a = d.audit;
  const r = d.recreate;
  const c = a.recreate;
  const m = a.scores?.mobile;
  const kpis = [
    d.analyzed && kpi('Performance', `${m?.performance ?? '—'}`, scoreTone(m?.performance), 'Lighthouse, mobile'),
    d.analyzed && kpi('SEO', `${m?.seo ?? '—'}`, scoreTone(m?.seo), 'Lighthouse, mobile'),
    r?.fidelity && kpi('Fidelity', `${r.fidelity.score ?? '—'}`, fidTone(r.fidelity.score, r.fidelity.threshold), 'recreate vs original'),
    r?.fidelity?.diff && kpi('Visual difference', `${r.fidelity.diff.score ?? '—'}`, fidTone(r.fidelity.diff.score, r.fidelity.diff.threshold ?? 65), 'recreate vs original'),
    c?.summary && !c.isDummy && kpi('Fixed', `${c.summary.fixed ?? 0}`, 'ok', `${c.summary.open ?? 0} still open`),
  ].filter(Boolean).join('');
  const host = (() => {
    try {
      return new URL(d.project.url).host;
    } catch {
      return d.project.url;
    }
  })();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.project.name)} · audit and recreate report</title>
<meta name="generator" content="Site Audit Studio"><style>${CSS}</style></head>
<body><main>
<header class="cover"><small>Website audit &amp; recreate report</small><h1>${esc(d.project.name)}</h1><p class="mono">${esc(d.project.url)}</p>
<div class="meta"><span><b>Site</b>${esc(host)}</span><span><b>Date</b>${esc(date(d.generatedAt))}</span><span><b>Analysis</b>${d.analyzed ? esc(date(a.analyzedAt)) : 'not run'}</span><span><b>Recreate</b>${r ? esc(date(r.createdAt)) : 'not run'}</span></div></header>
${kpis ? `<div class="band"><div class="kpis">${kpis}</div></div>` : ''}
<nav class="toc"><a href="#summary">Summary</a><a href="#old">Original site</a><a href="#new">Recreated site</a><a href="#fix">Fix checklist</a></nav>
<h2 id="summary">Summary</h2>
<section class="card"><ul class="sumlist">${highlights(d).map((h) => `<li class="${h.tone}">${esc(h.text)}</li>`).join('')}</ul></section>
${glance(d)}
${snapshot(d)}
${oldPart(d)}
${newPart(d)}
${checklistPart(d)}
<footer>Prepared with Site Audit Studio for company-owned or authorized websites. Scores come from Lighthouse (simulated throttling), axe and the tool's own checks. The recreated site is measured on a local preview; confirm the performance after deploying. Generated text is marked and should be reviewed. The complete data is in the JSON download.</footer>
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
