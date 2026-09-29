import { AlertTriangle, Check, X } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import styles from './RecreateReport.module.css';

const VIEW_LABEL = { desktop: 'desktop', tablet: 'tablet', mobile: 'phone' };

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

/** Fidelity (overall + per page, flagged below the threshold), build verification and warnings. */
export default function RecreateReport({ result }) {
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
              {fidelity.score ?? '—'}
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
              <CheckRow ok={result.safety.safe} label="Safety" detail="no script, no external reference" />
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
