import { AlertTriangle, Check, X } from 'lucide-react';
import { plainWarning } from '../../copy.js';
import styles from './RecreateReport.module.css';

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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

/** Motion, interactive parts, build verification and warnings. How the copy looks is said by one warning (copy.js lookWarning). */
export default function RecreateReport({ result }) {
  const verify = result.verify;
  const warnings = (result.warnings ?? []).map(plainWarning).filter(Boolean);
  const css = result.minify?.css;

  return (
    <div className={styles.card}>
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

      {warnings.length > 0 && (
        <ul className={styles.warnings}>
          {warnings.map((w) => (
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
