// The report as one self-contained HTML file: inline styles, inline images, no script and no external request, so
// it can be saved, e-mailed, opened offline and printed (Save as PDF). Every value from the audit or the recreate
// goes through esc(): site names, titles and URLs come from the pages that were analysed.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const date = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
};
const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const bytes = (v) => (v == null ? '—' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`);
const scoreTone = (s) => (s == null ? 'none' : s >= 90 ? 'ok' : s >= 50 ? 'warn' : 'bad');
const fidTone = (s, t = 80) => (s == null ? 'none' : s >= t ? 'ok' : s >= t - 15 ? 'warn' : 'bad');
const STATUS_TONE = { pass: 'ok', ok: 'ok', fixed: 'ok', improved: 'ok', warn: 'warn', changed: 'info', recheck: 'warn', manual: 'warn', open: 'bad', fail: 'bad', regressed: 'bad', na: 'none' };
const STATUS_LABEL = { pass: 'Pass', ok: 'OK', fixed: 'Fixed', improved: 'Improved', warn: 'Warning', fail: 'Fail', open: 'Still open', regressed: 'Regressed', changed: 'Changed', recheck: 'Recheck', manual: 'Manual', na: 'N/A' };

const pill = (text, tone = 'none') => `<span class="pill ${tone}">${esc(text)}</span>`;
const status = (s) => pill(STATUS_LABEL[s] ?? s, STATUS_TONE[s] ?? 'none');

/** A score ring (static SVG). */
function ring(value, label, tone = scoreTone(value)) {
  const c = 2 * Math.PI * 15;
  const dash = value == null ? 0 : (Math.max(0, Math.min(100, value)) / 100) * c;
  return `<div class="ring ${tone}"><svg viewBox="0 0 36 36" width="64" height="64" aria-hidden="true"><circle cx="18" cy="18" r="15" class="track"/><circle cx="18" cy="18" r="15" class="arc" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 18 18)"/></svg><b>${value ?? '—'}</b><span>${esc(label)}</span></div>`;
}

const table = (head, rows, cls = '') =>
  rows.length
    ? `<div class="tablewrap"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '';
const empty = (text) => `<p class="empty">${esc(text)}</p>`;
const section = (id, title, body, sub = '') => `<section id="${id}" class="card"><h3>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h3>${body}</section>`;
const kpi = (label, value, tone = 'none', sub = '') => `<div class="kpi ${tone}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
// weight: the share of the row the picture gets (desktop, tablet and phone shots sit side by side in proportion).
const shot = (src, label, weight = 1) => (src ? `<figure style="flex:${weight} 1 0"><img src="${src}" alt="${esc(label)}"/><figcaption>${esc(label)}</figcaption></figure>` : '');
const VIEW_WEIGHT = { desktop: 560, tablet: 360, mobile: 240 };

// ---- Part 1: the original site (the OLD panel) ------------------------------------------------------------

function oldPart(d) {
  const a = d.audit;
  if (!d.analyzed) {
    return `<h2 id="old"><span class="chip old">OLD</span> Original site</h2>${section('old-none', 'Not analyzed yet', empty('Run Analyze for this project to include the audit of the original site.'))}`;
  }
  const parts = [`<h2 id="old"><span class="chip old">OLD</span> Original site <small>${esc(a.url)}</small></h2>`];

  const sc = a.scores ?? {};
  const rings = (s) => (s ? [ring(s.performance, 'Performance'), ring(s.seo, 'SEO'), ring(s.accessibility, 'Accessibility'), ring(s.bestPractices, 'Best practices')].join('') : empty('Lighthouse did not finish for this device.'));
  const metricRow = (m) => (m ? [ms(m.loadTime), ms(m.lcp), ms(m.tbt), m.cls ?? '—', bytes(m.pageSize), m.requests ?? '—'] : ['—', '—', '—', '—', '—', '—']);
  const md = a.metricsByDevice ?? { mobile: a.metrics, desktop: null };
  parts.push(section('old-perf', 'Performance (Lighthouse, homepage)', `
    <div class="rings2"><div><h4>Mobile</h4><div class="rings">${rings(sc.mobile)}</div></div><div><h4>Desktop</h4><div class="rings">${rings(sc.desktop)}</div></div></div>
    ${table(['Device', 'Load time', 'LCP', 'TBT', 'CLS', 'Page size', 'Requests'], [['Mobile', ...metricRow(md.mobile)], ['Desktop', ...metricRow(md.desktop)]])}
    <p class="note">Analyzed ${esc(date(a.analyzedAt))} · ${num(a.pagesCrawled)} pages crawled${a.frame ? ` · framing: ${a.frame.frameable ? 'allowed' : `blocked${a.frame.reason ? ` (${esc(a.frame.reason)})` : ''}`}` : ''}.</p>`));

  const shots = ['desktop', 'tablet', 'mobile'].map((v) => shot(d.images.old[v], `Original · ${v}`, VIEW_WEIGHT[v])).join('');
  if (shots) parts.push(section('old-shots', 'The original at three sizes', `<div class="shots">${shots}</div>`, '1440 · 768 · 375 px, first screen'));

  parts.push(section('old-stack', 'Tech stack', a.techStack?.length
    ? table(['Platform', 'Category', 'Confidence', 'Evidence'], a.techStack.map((t) => [`<b>${esc(t.name)}</b>`, esc(t.category ?? '—'), pill(`${t.confidence ?? '—'}%`, t.confidence >= 80 ? 'ok' : 'warn'), esc((t.evidence ?? []).join(' · '))]))
    : empty('No platform recognised: Custom / Unknown.')));

  parts.push(section('old-weak', 'Weaknesses and platform limits', a.weaknesses?.length
    ? table(['Severity', 'Weakness', 'Detail'], a.weaknesses.map((w) => [pill(w.severity, w.severity === 'high' ? 'bad' : w.severity === 'medium' ? 'warn' : 'info'), `<b>${esc(w.title)}</b>`, esc(w.detail)]))
    : empty('No weaknesses were reported.')));

  const items = (list) => table(['', 'Check', 'Result'], list.map((i) => [status(i.status), `<b>${esc(i.title)}</b>`, esc(i.detail)]));
  parts.push(section('old-seo', 'SEO', a.seo?.length ? items(a.seo) : empty('No SEO results.')));
  parts.push(section('old-aeo', 'AEO · answer engines', a.aeo?.length ? items(a.aeo) : empty('No AEO results.')));

  const crawl = a.crawl ?? {};
  parts.push(section('old-crawl', 'Meta tags, sitemap and robots', items([
    { status: crawl.sitemap?.status, title: 'sitemap.xml', detail: crawl.sitemap?.detail },
    { status: crawl.robots?.status, title: 'robots.txt', detail: crawl.robots?.detail },
    { status: crawl.metaTags?.status, title: 'Meta tags', detail: crawl.metaTags?.detail },
  ].filter((i) => i.status))));

  const bl = a.brokenLinks ?? {};
  parts.push(section('old-links', 'Broken links', `<p>${num(bl.checked)} links checked, <b>${num(bl.broken?.length ?? 0)}</b> broken${bl.unverified?.length ? `, ${num(bl.unverified.length)} could not be verified` : ''}.</p>${
    bl.broken?.length ? table(['Link', 'Result', 'Found on'], bl.broken.slice(0, 40).map((l) => [`<span class="mono">${esc(l.url)}</span>`, pill(l.status, 'bad'), `<span class="mono">${esc(l.foundOn)}</span>`])) : ''}`));

  parts.push(section('old-a11y', 'Accessibility (axe)', a.accessibility?.length
    ? table(['Impact', 'Issue', 'Elements'], a.accessibility.map((i) => [pill(i.impact, i.impact === 'critical' || i.impact === 'serious' ? 'bad' : 'warn'), `<b>${esc(i.title)}</b>`, num(i.count)]))
    : empty('No accessibility issues were found on the homepage.')));

  parts.push(section('old-manual', 'Manual rebuild needed', a.manualRebuild?.length
    ? table(['Kind', 'What', 'Why'], a.manualRebuild.map((m) => [pill(m.kind, 'warn'), `<b>${esc(m.title)}</b>`, esc(m.detail)]))
    : empty('Nothing was detected that needs a manual rebuild.')));
  return parts.join('');
}

// ---- Part 2: the recreated site (the NEW panel) ---------------------------------------------------------------

function newPart(d) {
  const r = d.recreate;
  if (!r) {
    return `<h2 id="new"><span class="chip new">NEW</span> Recreated site</h2>${section('new-none', 'Not recreated yet', empty('Run Recreate for this project to include the recreated site in the report.'))}`;
  }
  const parts = [`<h2 id="new"><span class="chip new">NEW</span> Recreated site</h2>`];
  const f = r.fidelity;
  const resp = r.responsive?.status === 'done' ? r.responsive : null;

  parts.push(section('new-overview', 'Overview', `
    <div class="kpis">
      ${kpi('Fidelity', f?.score ?? '—', fidTone(f?.score, f?.threshold), `threshold ${f?.threshold ?? 80}`)}
      ${kpi('Visual difference', f?.diff?.score ?? '—', fidTone(f?.diff?.score, f?.diff?.threshold ?? 65), `threshold ${f?.diff?.threshold ?? 65}`)}
      ${kpi('Between widths', resp?.score ?? '—', fidTone(resp?.score, 65), resp ? `${resp.driftCount} of ${resp.measured} widths drift` : 'not measured')}
      ${kpi('Pages', r.pages?.length ?? 0, 'none', 'recreated')}
    </div>
    <p class="note">Recreated ${esc(date(r.createdAt))} · output: ${esc(r.stack ?? 'html')} · base URL <span class="mono">${esc(r.baseUrl)}</span>${r.generate?.breakpoints ? ` · breakpoints: ${Object.entries(r.generate.breakpoints).filter(([k]) => k !== 'source').map(([k, v]) => `${esc(k)} ≤ ${esc(Math.round(v))} px`).join(', ')} (${esc(r.generate.breakpoints.source)})` : ''}.</p>`));

  const compare = ['desktop', 'tablet', 'mobile'].filter((v) => d.images.old[v] || d.images.new[v]).map((v) => `<div class="pair"><h4>${esc(v)}</h4><div class="shots">${shot(d.images.old[v], 'Original')}${shot(d.images.new[v], 'Recreated')}</div></div>`).join('');
  if (compare) parts.push(section('new-compare', 'Original and recreated, side by side', compare, `homepage, first screen${d.images.diff ? '' : ''}`));

  if (f?.pages?.length) {
    const t = f.threshold ?? 80;
    const dt = f.diff?.threshold ?? 65;
    parts.push(section('new-fidelity', 'Fidelity and visual difference', `
      ${table(['Page', 'Fidelity', 'Visual diff', 'Desktop', 'Laptop', 'Tablet', 'Phone'], f.pages.map((p) => {
        const cell = (v) => (p.views?.[v] ? `<span class="${fidTone(p.views[v].score, t)}t">${p.views[v].score}</span> <small>/ ${p.views[v].diff?.score ?? '—'}</small>` : '—');
        return [`<span class="mono">${esc(p.path)}</span>`, pill(p.score ?? '—', fidTone(p.score, t)), pill(p.diff?.score ?? '—', fidTone(p.diff?.score, dt)), cell('desktop'), cell('laptop'), cell('tablet'), cell('mobile')];
      }))}
      <p class="note">Fidelity: element sizes and boxes plus a rough picture comparison (below ${t} is flagged). Visual difference: perceptual comparison of the full-page screenshots (below ${dt} is flagged). The view cells show fidelity / visual difference.</p>
      ${d.images.diff ? `<figure class="heat"><img src="${d.images.diff}" alt="Visual difference heatmap"/><figcaption>Where the recreated homepage differs from the original (desktop, red = differs).</figcaption></figure>` : ''}`));
  }

  if (resp) {
    parts.push(section('new-resp', 'Layout between the captured widths', `
      <div class="chips">${resp.widths.map((w) => pill(`${w} px · ${resp.byWidth?.[w] ?? '—'}`, fidTone(resp.byWidth?.[w], 65))).join('')}</div>
      <p>${resp.driftCount} of ${resp.measured} measured page widths drift from the original.</p>
      ${resp.worst?.length ? table(['Page', 'Width', 'Score', 'Flags'], resp.worst.map((w) => [`<span class="mono">${esc(w.path)}</span>`, `${w.width} px`, pill(w.score, 'bad'), esc((w.flags ?? []).join(', '))])) : ''}`, 'the original and the recreate rendered at 320 – 1920 px'));
  }

  const v = r.verify;
  if (v || r.safety || r.minify) {
    parts.push(section('new-build', 'Build, verification and safety', table(['Check', 'Result'], [
      v && ['Internal links', `${status(v.brokenLinks?.length ? 'fail' : 'pass')} ${num(v.checked?.links)} links resolve${v.brokenLinks?.length ? `, ${v.brokenLinks.length} broken` : ''}`],
      v && ['Assets', `${status(v.missingAssets?.length || v.externalAssets?.length ? 'fail' : 'pass')} ${num(v.checked?.assets)} references, all local`],
      v && ['HTML', `${status(v.html?.errors ? 'fail' : v.html?.warnings ? 'warn' : 'pass')} ${v.html?.warnings ? `${v.html.warnings} warnings (markup carried over from the original)` : 'valid'}`],
      r.safety && ['Safety gate', `${status(r.safety.safe ? 'pass' : 'fail')} ${r.safety.safe ? 'no script, no external reference' : 'issues found'}`],
      r.minify && ['Production build', `${num(r.minify.files)} files${r.minify.css ? ` · CSS ${bytes(r.minify.css.bytes)} → ${bytes(r.minify.css.minBytes)}` : ''}`],
    ].filter(Boolean))));
  }

  if (r.fixes?.length) {
    parts.push(section('new-fixes', 'Fixes applied while recreating', table(['', 'Fix', 'Count'], r.fixes.map((x) => [status(x.status === 'partial' ? 'warn' : x.status), `<b>${esc(x.title)}</b>`, `${num(x.count)}${x.open ? ` <small>(${x.open} still open)</small>` : ''}`]))));
  }

  if (r.autoGenerated?.length) {
    const byField = {};
    for (const a of r.autoGenerated) byField[a.field] = (byField[a.field] ?? 0) + 1;
    parts.push(section('new-auto', 'Auto-generated content (please review)', `<p>${num(r.autoGenerated.length)} values were generated from the pages by rules (no AI) because the original had none.</p>
      ${table(['Field', 'Count'], Object.entries(byField).map(([k, n]) => [esc(k), num(n)]))}
      ${table(['Page', 'Field', 'Value', 'Source'], r.autoGenerated.slice(0, 20).map((a) => [`<span class="mono">${esc(a.page)}</span>`, esc(a.field), esc(String(a.value).slice(0, 140)), esc(a.source)]))}`));
  }

  parts.push(section('new-manual', 'Manual rebuild needed', r.manual?.length
    ? table(['Kind', 'What', 'Why'], r.manual.map((m) => [pill(m.kind, 'warn'), `<b>${esc(m.title)}</b>`, esc(m.detail)]))
    : empty('Nothing needs a manual rebuild.')));

  if (r.motion?.status === 'captured') {
    parts.push(section('new-motion', 'Hover and focus effects found', `<p>${num(r.motion.hover)} hover effects, ${num(r.motion.focus)} focus styles and ${num(r.motion.rules)} authored :hover / :focus rules were captured on ${r.motion.pages} pages. They are recorded for the motion step; the recreated site does not replay them yet.</p>`));
  }

  const outs = Object.entries(r.outputs ?? {}).filter(([k]) => k !== 'html');
  if (outs.length) {
    parts.push(section('new-stacks', 'Other stacks built from this recreate', table(['Stack', 'Status', 'JavaScript (gzip)', 'Equivalence with HTML'], outs.map(([k, o]) => [
      `<b>${esc(k)}</b>`, status(o.status === 'ready' ? 'pass' : o.status === 'failed' ? 'fail' : 'warn'), bytes(o.build?.js?.gzipBytes),
      o.equivalence?.dom ? esc(`${o.equivalence.dom.equal}/${o.equivalence.dom.total} pages identical`) : '—'])),
    ));
  }

  if (r.warnings?.length) parts.push(section('new-warn', 'Warnings', `<ul class="warns">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`));
  return parts.join('');
}

// ---- Part 3: the fix checklist (the re-audit) ---------------------------------------------------------------------

function checklistPart(d) {
  const c = d.audit.recreate;
  if (!c || c.isDummy || !c.items) {
    return `<h2 id="fix"><span class="chip fix">FIX</span> Fix checklist</h2>${section('fix-none', 'Not available', empty(d.recreate ? 'The recreated site has not been re-audited yet. Run Re-audit in the NEW panel.' : 'Recreate the site first; the fix checklist compares the original with the recreated site.'))}`;
  }
  const s = c.summary ?? {};
  const parts = [`<h2 id="fix"><span class="chip fix">FIX</span> Fix checklist <small>original vs recreated${c.stackLabel ? ` · ${esc(c.stackLabel)}` : ''}</small></h2>`];
  const scoresFor = (side) => ({ before: c.scores?.before?.[side], after: c.scores?.after?.[side] });
  const rows = (side) => ['performance', 'seo', 'accessibility', 'bestPractices'].map((k) => {
    const { before, after } = scoresFor(side);
    const b = before?.[k];
    const a = after?.[k];
    return [esc({ performance: 'Performance', seo: 'SEO', accessibility: 'Accessibility', bestPractices: 'Best practices' }[k]), pill(b ?? '—', scoreTone(b)), '→', pill(a ?? '—', scoreTone(a)), a != null && b != null ? `<b class="${a - b >= 0 ? 'okt' : 'badt'}">${a - b >= 0 ? '+' : ''}${a - b}</b>` : '—'];
  });
  parts.push(section('fix-scores', 'Lighthouse scores, before and after', `<div class="rings2"><div><h4>Mobile</h4>${table(['Category', 'Before', '', 'After', 'Change'], rows('mobile'))}</div><div><h4>Desktop</h4>${table(['Category', 'Before', '', 'After', 'Change'], rows('desktop'))}</div></div>
    <p class="note">The recreated site is measured on a local preview with simulated throttling; confirm the performance after deploying.</p>`));
  parts.push(section('fix-summary', 'Summary', `<div class="chips">${['fixed', 'improved', 'open', 'regressed', 'changed', 'recheck', 'manual', 'na'].filter((k) => s[k]).map((k) => pill(`${STATUS_LABEL[k]} · ${s[k]}`, STATUS_TONE[k])).join('')}${pill(`Passing on both sides · ${s.pass ?? 0}`, 'ok')}</div>
    ${c.scope ? `<p class="note">${num(c.scope.pairs ?? c.scope.pages?.length)} pages compared${c.scope.outOfScope?.length ? `, ${c.scope.outOfScope.length} original pages were not recreated` : ''}. Re-audited ${esc(date(c.reauditedAt))}.</p>` : ''}`));
  const cats = (c.categories ?? []).map((cat) => [cat, (c.items ?? []).filter((i) => i.category === cat.id && i.status !== 'pass')]).filter(([, list]) => list.length);
  for (const [cat, list] of cats) {
    parts.push(section(`fix-${cat.id}`, cat.label, table(['', 'Check', 'Before', 'Now', 'Note'], list.map((i) => [
      status(i.status), `<b>${esc(i.title)}</b>${i.review ? ' <small class="reviewtag">review</small>' : ''}`, esc(i.before?.detail ?? i.before?.status ?? '—'), esc(i.after?.detail ?? i.after?.status ?? '—'), esc(i.note ?? ''),
    ]))));
  }
  return parts.join('');
}

const CSS = `
:root{--ink:#17173a;--ink2:#363863;--muted:#666a94;--line:#e4e5f7;--tint:#f3f2ff;--violet:#6d4aff;--pink:#ec4899;--sky:#0ea5e9;--ok:#0b9a69;--okbg:#e6faf2;--warn:#c2570c;--warnbg:#fff3df;--bad:#e11d48;--badbg:#fff0f3;--info:#2563eb;--infobg:#eaf1ff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 'Inter','Segoe UI',system-ui,-apple-system,sans-serif;color:var(--ink);background:radial-gradient(900px 500px at 0 -5%,#e4dbff,transparent 60%),radial-gradient(800px 450px at 100% 0,#d3f1ff,transparent 58%),#f5f6ff}
.mono{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:.92em;word-break:break-all}
main{max-width:1060px;margin:0 auto;padding:28px 20px 60px}
header.cover{position:relative;overflow:hidden;border-radius:26px;padding:34px 36px;color:#fff;background:linear-gradient(120deg,#6d4aff,#a24cf5 55%,#ec4899);box-shadow:0 24px 60px rgba(109,74,255,.35)}
header.cover::after{content:'';position:absolute;right:-60px;top:-80px;width:280px;height:280px;border-radius:50%;background:rgba(255,255,255,.16)}
header.cover small{opacity:.85;letter-spacing:.12em;text-transform:uppercase;font-weight:700;font-size:11.5px}
header.cover h1{margin:6px 0 4px;font-size:34px;letter-spacing:-.03em}
header.cover p{margin:0;opacity:.92}
header.cover .meta{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px}
header.cover .meta span{background:rgba(255,255,255,.2);border-radius:999px;padding:3px 12px;font-size:12.5px;font-weight:600}
nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
nav.toc a{padding:5px 13px;border-radius:999px;background:#fff;border:1px solid var(--line);color:var(--ink2);text-decoration:none;font-weight:600;font-size:12.5px}
nav.toc a:hover{border-color:var(--violet);color:var(--violet)}
h2{display:flex;align-items:center;gap:12px;margin:38px 0 14px;font-size:24px;letter-spacing:-.02em}
h2 small{font-size:13px;color:var(--muted);font-weight:500;word-break:break-all}
h3{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;font-size:16px}
h3 small{color:var(--muted);font-weight:500;font-size:12px}
h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.chip{display:inline-block;padding:3px 12px;border-radius:999px;font:700 12px/1.4 'JetBrains Mono',monospace;letter-spacing:.08em;color:#fff}
.chip.old{background:linear-gradient(120deg,#0ea5e9,#6366f1)}
.chip.new{background:linear-gradient(120deg,#6d4aff,#ec4899)}
.chip.fix{background:linear-gradient(120deg,#10b981,#06b6d4)}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:18px 20px;margin:0 0 14px;box-shadow:0 2px 4px rgba(60,50,140,.05),0 10px 28px rgba(80,60,200,.07);break-inside:avoid-page}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:10px}
.kpi{border-radius:14px;padding:12px 14px;background:var(--tint);border:1px solid var(--line)}
.kpi span{display:block;font-size:11.5px;color:var(--muted);font-weight:600}
.kpi b{display:block;font-size:30px;line-height:1.15;letter-spacing:-.03em}
.kpi small{color:var(--muted)}
.kpi.ok{background:var(--okbg)}.kpi.ok b{color:var(--ok)}
.kpi.warn{background:var(--warnbg)}.kpi.warn b{color:var(--warn)}
.kpi.bad{background:var(--badbg)}.kpi.bad b{color:var(--bad)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:700;line-height:1.5;white-space:nowrap;background:var(--tint);color:var(--ink2);border:1px solid var(--line)}
.pill.ok{background:var(--okbg);color:var(--ok);border-color:#bdeedb}
.pill.warn{background:var(--warnbg);color:var(--warn);border-color:#ffd9a0}
.pill.bad{background:var(--badbg);color:var(--bad);border-color:#ffc2cf}
.pill.info{background:var(--infobg);color:var(--info);border-color:#c5d8ff}
.okt{color:var(--ok);font-weight:700}.warnt{color:var(--warn);font-weight:700}.badt{color:var(--bad);font-weight:700}.nonet{color:var(--muted)}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:6px 10px;border-bottom:2px solid var(--line)}
td{padding:8px 10px;border-bottom:1px dashed var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.note{margin:10px 0 0;color:var(--muted);font-size:12.5px}
.empty{margin:0;padding:12px;border-radius:12px;background:var(--tint);color:var(--muted)}
.rings{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px}
.rings2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.ring{position:relative;display:grid;justify-items:center;width:78px}
.ring svg{display:block}
.ring .track{fill:none;stroke:rgba(109,74,255,.12);stroke-width:3.6}
.ring .arc{fill:none;stroke-width:3.6;stroke-linecap:round}
.ring.ok .arc{stroke:var(--ok)}.ring.warn .arc{stroke:#f59e0b}.ring.bad .arc{stroke:var(--bad)}
.ring b{position:absolute;top:19px;font-size:17px}
.ring span{font-size:11px;color:var(--muted);font-weight:600;text-align:center}
.shots{display:flex;gap:14px;align-items:flex-start}
figure{margin:0;min-width:0}
figure img{display:block;width:100%;border-radius:12px;border:1px solid var(--line);box-shadow:0 6px 18px rgba(60,50,140,.12)}
figcaption{margin-top:6px;font-size:12px;color:var(--muted);text-align:center}
.pair{margin-bottom:14px}
.heat{max-width:280px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.warns{margin:0;padding-left:18px;color:var(--warn)}
.warns li{margin:3px 0}
.reviewtag{background:var(--warnbg);color:var(--warn);border-radius:6px;padding:0 6px;font-weight:700}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
@media print{body{background:#fff}main{max-width:none;padding:0}header.cover{box-shadow:none;-webkit-print-color-adjust:exact;print-color-adjust:exact}.card{box-shadow:none;break-inside:avoid}h2{break-after:avoid}.chip,.pill,.kpi,.ring,.shots,figure{-webkit-print-color-adjust:exact;print-color-adjust:exact}nav.toc{display:none}@page{margin:14mm}}
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
    d.analyzed && kpi('Lighthouse (mobile)', `${m?.performance ?? '—'}`, scoreTone(m?.performance), 'performance'),
    d.analyzed && kpi('SEO', `${m?.seo ?? '—'}`, scoreTone(m?.seo), 'mobile'),
    r?.fidelity && kpi('Fidelity', `${r.fidelity.score ?? '—'}`, fidTone(r.fidelity.score, r.fidelity.threshold), 'recreate'),
    r?.fidelity?.diff && kpi('Visual difference', `${r.fidelity.diff.score ?? '—'}`, fidTone(r.fidelity.diff.score, r.fidelity.diff.threshold ?? 65), 'recreate'),
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
<div class="meta"><span>${esc(host)}</span><span>Generated ${esc(date(d.generatedAt))}</span>${d.analyzed ? `<span>Analyzed ${esc(date(a.analyzedAt))}</span>` : '<span>Not analyzed yet</span>'}<span>${r ? 'Recreated' : 'Not recreated yet'}</span></div></header>
${kpis ? `<div class="card" style="margin-top:18px"><div class="kpis">${kpis}</div></div>` : ''}
<nav class="toc"><a href="#old">OLD · Original site</a><a href="#new">NEW · Recreated site</a><a href="#fix">Fix checklist</a></nav>
${oldPart(d)}
${newPart(d)}
${checklistPart(d)}
<footer>Generated by Site Audit Studio for company-owned or authorized websites. Scores come from Lighthouse (simulated throttling), axe and the tool's own checks; the recreated site is measured on a local preview, so confirm performance after deploying. Auto-generated text is marked and should be reviewed.</footer>
</main></body></html>`;
}

/** A file name for the download: <host>-report-<date>.<ext> */
export function reportFileName(project, ext) {
  let host = 'site';
  try {
    host = new URL(project.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep the default */
  }
  return `${host.replace(/[^a-z0-9.-]/gi, '-')}-audit-report-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
