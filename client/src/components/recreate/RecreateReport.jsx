import { AlertTriangle, Check, X } from 'lucide-react';
import { apiUrl } from '../../api/base.js';
import Badge from '../common/Badge.jsx';
import CountUp from '../common/CountUp.jsx';
import styles from './RecreateReport.module.css';

const VIEW_LABEL = { desktop: 'desktop', laptop: 'laptop', tablet: 'tablet', mobile: 'phone' };

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function scoreTone(score, threshold) {
  if (score == null) return 'neutral';
  return score < threshold ? 'warn' : 'ok';
}

function CheckRow({ ok, label, detail }) {
  const Icon = ok ? Check : X;
  return (
    <li className={styles.check} data-ok={ok}>
      <span className={styles.mark} aria-label={ok ? 'Passed' : 'Failed'}>
        <Icon size={11} strokeWidth={3} />
      </span>
      <span className={styles.checkLabel}>{label}</span>
      <span className={styles.checkDetail}>{detail}</span>
    </li>
  );
}

const bandTone = (score) => (score >= 0.85 ? 'ok' : score >= 0.65 ? 'mid' : 'bad');
const VIEW_ORDER = ['desktop', 'laptop', 'tablet', 'mobile'];

/** The page top to bottom in ten bands, coloured by how much the recreate differs from the original there. */
function BandStrip({ bands, label }) {
  return (
    <span className={styles.strip} role="img" aria-label={label}>
      {bands.map((b) => (
        <span key={b.from} data-tone={bandTone(b.score)} title={`${Math.round(b.from * 100)}–${Math.round(b.to * 100)}% of the page: ${Math.round(b.score * 100)}`} />
      ))}
    </span>
  );
}

/** Perceptual visual difference per page: where it differs (bands of the worst view) and a heatmap per view. */
function VisualDiff({ result, projectId }) {
  const diff = result.fidelity.diff;
  const threshold = diff.threshold ?? 65;
  const slugOf = Object.fromEntries((result.pages ?? []).map((p) => [p.path, p.slug]));
  return (
    <section aria-label="Visual difference" className={styles.section}>
      <div className={styles.head}>
        <span className={styles.title}>Visual difference</span>
        <span className={styles.meta}>perceptual · threshold {threshold}</span>
        <span className={`${styles.score} mono`} data-tone={scoreTone(diff.score, threshold)}>
          {diff.score == null ? '—' : <CountUp value={diff.score} />}
          <small>/100</small>
        </span>
      </div>
      <ul className={styles.pages}>
        {result.fidelity.pages.filter((p) => p.diff).map((p) => {
          const views = VIEW_ORDER.filter((v) => p.views[v]?.diff);
          const worst = views.reduce((a, v) => (a == null || p.views[v].diff.score < p.views[a].diff.score ? v : a), null);
          const slug = slugOf[p.path];
          return (
            <li key={p.path} className={styles.diffPage}>
              <span className={`${styles.path} mono`} title={p.path}>{p.path}</span>
              <BandStrip bands={p.views[worst].diff.bands} label={`Where the ${VIEW_LABEL[worst]} view differs, top to bottom`} />
              <span className={`${styles.pageScore} mono`}>{p.diff.score}</span>
              <span className={styles.links}>
                {slug && views.map((v) => (
                  <a key={v} href={apiUrl(`/projects/${projectId}/recreate/${result.recreateId}/fidelity/${slug}/${v}-diff.webp`)} target="_blank" rel="noopener noreferrer" title={`Heatmap of the ${VIEW_LABEL[v]} view (red = differs)`} data-low={p.views[v].diff.low}>
                    {VIEW_LABEL[v]} {p.views[v].diff.score}
                  </a>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const CAUSE_LABEL = {
  'page-height': 'The page is a different height',
  'missing-element': 'Something the original shows is missing',
  'extra-element': 'Something the original does not show was added',
  'box-out-of-place': 'Something sits in the wrong place',
  pixels: 'The pixels differ, although the layout matches',
  'console-error': 'The copy logged an error',
  'failed-request': 'The copy tried to load something it could not',
  'loop-missing': 'An animation of the original is not repeating in the copy',
  'third-party-frame': 'A frame from another company (a map, a video, a booking widget)',
  'image-content': 'What a picture, video or canvas draws is its own content',
};

/**
 * Every route at every screen size: how tall each side is, how many pixels differ, and whether every element sits
 * where it should. Only the sizes that are not an exact match are listed, with a magnified look at the worst places.
 */
function ExactComparison({ result, projectId }) {
  const exact = result.exact;
  if (!exact?.summary) return null;
  const { summary, limit = 0.5, remaining = [], pages = [] } = exact;
  const check = exact.baseline?.check;
  const url = (slug, file) => apiUrl(`/projects/${projectId}/recreate/${result.recreateId}/exact/${slug}/${file}`);
  const rows = pages.flatMap((p) => p.slots.filter((s) => !s.accepted).map((s) => ({ page: p.page, slug: p.slug, ...s })));
  const noise = Object.entries(exact.noiseFloor ?? {}).filter(([, v]) => v > 0);

  return (
    <section aria-label="Exact comparison" className={styles.section}>
      <div className={styles.head}>
        <span className={styles.title}>Exact comparison</span>
        <span className={styles.meta}>
          {plural(summary.slots, 'size')} across {plural(summary.pages, 'page')} · an exact match is under {limit}% of pixels
        </span>
        <span className={`${styles.score} mono`} data-tone={summary.accepted === summary.slots ? 'ok' : 'warn'}>
          {summary.accepted}<small>/{summary.slots}</small>
        </span>
      </div>
      {check && check.status !== 'fresh' && (
        <p className={styles.note}>
          {check.status === 'stale' ? 'The original has changed since it was measured' : 'The measurement of the original may be out of date'}
          {check.reasons?.length ? `: ${check.reasons.join('; ')}` : ''}. Create the exact copy again to measure it afresh.
        </p>
      )}
      {!rows.length && <p className={styles.note}>Every page matches the original at every size measured.</p>}
      {rows.length > 0 && (
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Size</th>
              <th scope="col">Height</th>
              <th scope="col">Pixels</th>
              <th scope="col">Elements</th>
              <th scope="col">Look</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 40).map((r) => (
              <tr key={`${r.page}-${r.id}`}>
                <td className={`${styles.path} mono`} title={r.page}>{r.page}</td>
                <td className="mono">
                  {r.id}
                  {r.dpr > 1 && <small> ·{r.dpr}x</small>}
                  {r.origin === 'breakpoint' && <small title="One pixel either side of a breakpoint the site itself declares"> ·bp</small>}
                </td>
                <td className="mono" data-ok={r.heightOk}>
                  {r.heightOk ? 'same' : `${r.heightOriginal} → ${r.heightCopy}`}
                </td>
                <td className="mono" data-ok={r.pixelsOk}>{r.diffRaw}%</td>
                <td className="mono" data-ok={r.boxesOk}>
                  {r.boxes
                    ? [
                      r.boxes.missing ? `${r.boxes.missing} missing` : null,
                      r.boxes.extra ? `${r.boxes.extra} extra` : null,
                      r.boxes.paired - r.boxes.within ? `${r.boxes.paired - r.boxes.within} moved` : null,
                    ].filter(Boolean).join(', ') || 'all in place'
                    : '—'}
                </td>
                <td className={styles.links}>
                  {r.map && <a href={url(r.slug, r.map)} target="_blank" rel="noopener noreferrer" title="Where the two differ (red)">map</a>}
                  {(r.crops ?? []).map((c, i) => (
                    <a key={c.file} href={url(r.slug, c.file)} target="_blank" rel="noopener noreferrer" title={`${c.zoom}x zoom: the original above, the copy below`}>
                      zoom {i + 1}
                    </a>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remaining.length > 0 && (
        <ul className={styles.chips} aria-label="Remaining differences">
          {remaining.map((r) => (
            <li key={r.cause} data-kind={r.kind} title={r.kind === 'needs-a-person' ? 'Someone has to decide about this' : 'Something for the tool to fix'}>
              {CAUSE_LABEL[r.cause] ?? r.cause} · {r.count}
            </li>
          ))}
        </ul>
      )}
      {exact.correct && (
        <p className={styles.note}>
          The copy was corrected against the original over{' '}
          {plural(exact.correct.rounds ?? 0, 'round')} across {plural(exact.correct.pages?.length ?? 0, 'page')}:{' '}
          {exact.correct.applied ?? 0} {(exact.correct.applied ?? 0) === 1 ? 'change' : 'changes'} kept,{' '}
          {exact.correct.reverted ?? 0} put back because they did not measure closer
          {exact.correct.scoreBefore != null && exact.correct.scoreAfter != null
            ? ` (match ${exact.correct.scoreBefore} → ${exact.correct.scoreAfter} of 100)`
            : ''}
          {exact.correct.stopped ? `. It stopped: ${exact.correct.stopped}.` : '.'}
        </p>
      )}
      {result.coverage && (
        <p className={styles.note}>
          Of the {plural(result.coverage.visible, 'interactive part')} a visitor can see across{' '}
          {plural(result.coverage.pages, 'page')}, {result.coverage.probed} were examined
          {result.coverage.examined != null ? ` (${result.coverage.examined}%)` : ''} and{' '}
          {result.coverage.understood} turned out to do something.
          {Object.keys(result.coverage.reasons ?? {}).length > 0 && (
            <> The rest were not: {Object.entries(result.coverage.reasons).map(([why, n]) => `${why} (${n})`).join(', ')}.</>
          )}
        </p>
      )}
      {noise.length > 0 && (
        <p className={styles.note}>
          The original differs from itself by up to {Math.max(...noise.map(([, v]) => v))}% between two visits (rotating
          content), so a difference below that says nothing.
        </p>
      )}
    </section>
  );
}

/** The layout between the captured widths: score per sweep width and what the sweep changed. */
function Responsive({ result }) {
  const r = result.responsive;
  const bp = result.generate?.responsive?.breakpoints;
  const changed = ['tablet', 'mobile'].filter((k) => bp?.[k]?.changed);
  const fluid = result.generate?.responsive?.fluid?.adopted;
  return (
    <section aria-label="Responsive layout" className={styles.section}>
      <div className={styles.head}>
        <span className={styles.title}>Between the captured widths</span>
        <span className={styles.meta}>{r.widths.length} widths · threshold {r.threshold}</span>
        <span className={`${styles.score} mono`} data-tone={scoreTone(r.score, r.threshold)}>
          {r.score == null ? '—' : <CountUp value={r.score} />}
          <small>/100</small>
        </span>
      </div>
      <ul className={styles.chips}>
        {r.widths.map((w) => (
          <li key={w} data-tone={scoreTone(r.byWidth[w], r.threshold)} title={`Mean score at ${w} px`}>
            <span className="mono">{w}</span> {r.byWidth[w] ?? '—'}
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        {r.driftCount ? `${r.driftCount} of ${r.measured} page widths drift from the original.` : 'No page width drifts from the original.'}
        {changed.length > 0 && ` Breakpoints adjusted to the original: ${changed.map((k) => `${k === 'mobile' ? 'phone' : k} up to ${Math.round(bp[k].chosen)} px`).join(', ')}.`}
        {fluid && ' Type scales with the screen.'}
      </p>
    </section>
  );
}

const SKIP_REASON = {
  'script-driven': 'driven by script',
  'scroll-linked': 'scroll-linked',
  'pseudo-element': 'on a pseudo-element',
  'no-keyframes': 'without keyframes',
  'url-in-keyframes': 'with an image in the keyframes',
  unmapped: 'inside an inline graphic or on an element that was not recreated',
};

/** What the recreate rebuilt of the original's motion: hover and focus states, scroll reveals, looping animations. */
function Motion({ result }) {
  const m = result.generate.motion;
  const hover = m.hover?.elements ?? 0;
  const focus = m.focus?.elements ?? 0;
  const reveal = m.reveal?.elements ?? 0;
  const loops = (m.loops?.carried ?? 0) + (m.loops?.rebuilt ?? 0);
  if (!hover && !focus && !reveal && !loops && !m.loops?.skipped?.length) return null;
  const notRebuilt = {};
  for (const s of m.loops?.skipped ?? []) notRebuilt[s.reason] = (notRebuilt[s.reason] ?? 0) + 1;
  const timed = m.reveal?.skipped?.timed ?? 0;
  const scripts = result.outputs?.html?.scripts;
  // Effects the original ran with its own script: the copy rebuilds them in CSS and times them itself.
  const scripted = (m.hover?.scripted ?? 0) + (m.focus?.scripted ?? 0);
  return (
    <section aria-label="Motion" className={styles.section}>
      <div className={styles.head}>
        <span className={styles.title}>Motion</span>
        <span className={styles.meta}>captured from the original · {plural(m.pages ?? 0, 'page')}</span>
      </div>
      <ul className={styles.chips}>
        {hover > 0 && <li data-tone="ok" title={`${m.hover.effects} distinct hover effects`}>Hover <span className="mono">{hover}</span></li>}
        {focus > 0 && <li data-tone="ok">Focus <span className="mono">{focus}</span></li>}
        {reveal > 0 && <li data-tone="ok" title={`${m.reveal.effects} distinct reveal effects${m.reveal.replay ? `, ${m.reveal.replay} repeat` : ''}`}>Scroll reveal <span className="mono">{reveal}</span></li>}
        {loops > 0 && <li data-tone="ok" title={`${m.loops.carried} already in the page's CSS, ${m.loops.rebuilt} rebuilt`}>Loops <span className="mono">{loops}</span></li>}
      </ul>
      <p className={styles.note}>
        {scripts ? 'Scroll reveal needs one small generated script (js/motion.js); without script, or with reduced motion, the page shows finished. ' : ''}
        {scripted > 0 && `${plural(scripted, 'effect')} the original played with its own code: rebuilt in plain CSS, over the time it was measured to take. `}
        {Object.keys(notRebuilt).length > 0 && `Not rebuilt: ${Object.entries(notRebuilt).map(([reason, n]) => `${plural(n, 'loop')} ${SKIP_REASON[reason] ?? reason}`).join(', ')}. `}
        {timed > 0 && `${plural(timed, 'timed effect')} (rotating headlines, timers) left as the page's own CSS. `}
      </p>
    </section>
  );
}

const WIDGET_LABEL = { disclosure: 'Menus and panels', tabs: 'Tabs', carousel: 'Sliders', dialog: 'Pop-up windows' };

/** The interactive parts of the original (found by clicking) that work in the copy too. */
function Interactive({ stats }) {
  const kinds = Object.entries(stats.byKind ?? {}).filter(([, n]) => n > 0);
  const notRebuilt = (stats.skipped?.unmapped ?? 0) + (stats.skipped?.scriptBuilt ?? 0) + (stats.skipped?.noPanel ?? 0);
  if (!kinds.length && !notRebuilt) return null;
  return (
    <section aria-label="Interactive parts" className={styles.section}>
      <div className={styles.head}>
        <span className={styles.title}>Interactive parts</span>
        <span className={styles.meta}>found by clicking the original · {plural(stats.pages ?? 0, 'page')}</span>
      </div>
      <ul className={styles.chips}>
        {kinds.map(([kind, n]) => (
          <li key={kind} data-tone="ok">
            {WIDGET_LABEL[kind] ?? kind} <span className="mono">{n}</span>
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        They open, close and switch in the copy the way they did on the original (keyboard and Escape included), driven by the same small generated script.
        {notRebuilt > 0 && ` ${plural(notRebuilt, 'part')} could not be rebuilt (made by the original's own script or not found in the copy).`}
      </p>
    </section>
  );
}

/** Fidelity (overall + per page, flagged below the threshold), visual difference, build verification and warnings. */
export default function RecreateReport({ result, projectId }) {
  const fidelity = result.fidelity;
  const threshold = fidelity?.threshold ?? 80;
  const verify = result.verify;
  const css = result.minify?.css;

  return (
    <div className={styles.card}>
      {fidelity && (
        <section aria-label="Fidelity">
          <div className={styles.head}>
            <span className={styles.title}>Fidelity</span>
            <span className={styles.meta}>vs. the original · threshold {threshold}</span>
            <span className={`${styles.score} mono`} data-tone={scoreTone(fidelity.score, threshold)}>
              {fidelity.score == null ? '—' : <CountUp value={fidelity.score} />}
              <small>/100</small>
            </span>
          </div>
          <ul className={styles.pages}>
            {fidelity.pages.map((p) => {
              const low = p.score != null && p.score < threshold;
              const lowViews = p.lowViews ?? Object.entries(p.views).filter(([, v]) => v.score < threshold).map(([id]) => id);
              return (
                <li key={p.path} className={styles.page}>
                  <span className={`${styles.path} mono`} title={p.path}>{p.path}</span>
                  <span className={styles.bar} aria-hidden="true">
                    <span style={{ width: `${p.score ?? 0}%` }} data-tone={scoreTone(p.score, threshold)} />
                  </span>
                  <span className={`${styles.pageScore} mono`}>{p.score ?? '—'}</span>
                  {low ? (
                    <Badge tone="warn">Below {threshold}</Badge>
                  ) : lowViews.length ? (
                    <Badge tone="warn">{lowViews.map((v) => VIEW_LABEL[v] ?? v).join(', ')} low</Badge>
                  ) : (
                    <Badge tone="ok">OK</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result.exact?.summary && projectId && <ExactComparison result={result} projectId={projectId} />}

      {result.fidelity?.diff?.score != null && projectId && <VisualDiff result={result} projectId={projectId} />}

      {result.responsive?.status === 'done' && <Responsive result={result} />}

      {result.generate?.motion && <Motion result={result} />}
      {result.generate?.widgets && <Interactive stats={result.generate.widgets} />}

      {verify && (
        <section aria-label="Build verification" className={styles.section}>
          <div className={styles.head}>
            <span className={styles.title}>Build &amp; verification</span>
            <span className={styles.meta}>
              {verify.dir}/ · {plural(result.minify?.files ?? 0, 'file')}
              {css?.files > 0 && ` · CSS ${kb(css.bytes)} → ${kb(css.minBytes)}`}
            </span>
          </div>
          <ul className={styles.checks}>
            <CheckRow ok={!verify.brokenLinks.length} label="Internal links" detail={verify.brokenLinks.length ? `${verify.brokenLinks.length} broken` : `${plural(verify.checked.links, 'link')} resolve`} />
            <CheckRow
              ok={!verify.missingAssets.length && !verify.externalAssets.length && !verify.missingFiles.length}
              label="Assets"
              detail={`${plural(verify.checked.assets, 'reference')}, all local`}
            />
            <CheckRow
              ok={!verify.html.errors}
              label="HTML"
              detail={verify.html.valid ? `valid · ${plural(verify.checked.pages, 'page')}` : `${plural(verify.html.warnings, 'warning')}`}
            />
            {result.safety && (
              <CheckRow ok={result.safety.safe} label="Safety" detail={result.outputs?.html?.scripts ? 'only the generated reveal script, no external reference' : 'no script, no external reference'} />
            )}
          </ul>
        </section>
      )}

      {result.warnings?.length > 0 && (
        <ul className={styles.warnings}>
          {result.warnings.map((w) => (
            <li key={w}>
              <AlertTriangle size={12} aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
