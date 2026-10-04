import { useState } from 'react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Check, ChevronRight, Hand, Minus, RefreshCw, RotateCw, X } from 'lucide-react';
import Badge from '../common/Badge.jsx';
import Button from '../common/Button.jsx';
import styles from './FixReport.module.css';

// Every status the comparison can give a check, in the order rows are listed (server: reaudit/compare/rules.js).
const STATUS = {
  regressed: { icon: ArrowDownRight, label: 'Regressed', chip: 'Regressed' },
  open: { icon: X, label: 'Still open', chip: 'Still open' },
  changed: { icon: Activity, label: 'Changed (noisy locally)', chip: 'Changed' },
  recheck: { icon: RefreshCw, label: 'Recheck (network error)', chip: 'Recheck' },
  improved: { icon: ArrowUpRight, label: 'Improved', chip: 'Improved' },
  fixed: { icon: Check, label: 'Fixed', chip: 'Fixed' },
  manual: { icon: Hand, label: 'Manual rebuild', chip: 'Manual' },
  na: { icon: Minus, label: 'N/A · deploy check', chip: 'N/A' },
  pass: { icon: Check, label: 'Passing', chip: 'Passing' },
};
const CHIPS = ['fixed', 'improved', 'open', 'regressed', 'changed', 'recheck', 'manual', 'na'];
// A category opens on its own when it holds something to act on.
const NEEDS_ACTION = new Set(['regressed', 'open']);

const SCORES = [
  ['performance', 'Performance'],
  ['seo', 'SEO'],
  ['accessibility', 'Accessibility'],
  ['bestPractices', 'Best practices'],
];

const STALE = {
  recreate: 'A newer recreate exists; this checklist is about the previous one. Re-audit to check the latest site.',
  analysis: 'The original site was analyzed again after this recreate; the checklist compares against the earlier analysis. Recreate to compare with the new analysis.',
  stack: 'This checklist audited a different build of the site than the one the project uses now (its stack changed, or its build finished since). Re-audit to check the current one.',
};

const seconds = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const size = (bytes) => (bytes == null ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);
const METRICS = [
  ['lcp', 'LCP', seconds],
  ['tbt', 'TBT', (ms) => (ms == null ? '—' : `${ms} ms`)],
  ['cls', 'CLS', (v) => (v == null ? '—' : String(v))],
  ['pageSize', 'Page size', size],
];

function scoreTone(score) {
  if (score == null) return 'none';
  return score >= 90 ? 'ok' : score >= 50 ? 'warn' : 'bad';
}

function ScoreStrip({ scores, metrics, stackLabel = null }) {
  if (!scores?.before && !scores?.after) return null;
  // Desktop only for now: the computer scores (an older comparison may only have phone scores).
  const device = scores.after?.desktop || scores.before?.desktop ? 'desktop' : 'mobile';
  const before = scores.before?.[device];
  const after = scores.after?.[device];
  const mBefore = metrics?.before?.[device];
  const mAfter = metrics?.after?.[device];
  return (
    <section className={styles.strip} aria-label="Lighthouse scores before and after">
      <div className={styles.stripHead}>
        <span className={styles.stripTitle}>Lighthouse · homepage · {device === 'desktop' ? 'computer' : 'phone'}</span>
      </div>
      <div className={styles.scores}>
        {SCORES.map(([key, label]) => {
          const b = before?.[key] ?? null;
          const a = after?.[key] ?? null;
          const delta = a != null && b != null ? a - b : null;
          return (
            <div key={key} className={styles.scoreCell}>
              <span className={styles.scoreLabel}>
                {label}
                {key === 'performance' && <sup title="Measured on a local preview with simulated throttling">*</sup>}
              </span>
              <span className={`${styles.scoreValues} mono`}>
                <span data-tone={scoreTone(b)}>{b ?? '—'}</span>
                <span className={styles.arrow} aria-hidden="true">→</span>
                <strong data-tone={scoreTone(a)}>{a ?? '—'}</strong>
              </span>
              {delta != null && delta !== 0 && (
                <span className={`${styles.delta} mono`} data-dir={delta > 0 ? 'up' : 'down'}>
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {(mBefore || mAfter) && (
        <p className={`${styles.metrics} mono`}>
          {METRICS.map(([key, label, fmt]) => (
            <span key={key}>
              {label} {fmt(mBefore?.[key])} → {fmt(mAfter?.[key])}
            </span>
          ))}
        </p>
      )}
      <p className={styles.footnote}>
        * The recreated site is measured on a local preview; confirm performance after deploying.
        {stackLabel && ` Audited build: ${stackLabel}. Its JavaScript runtime is part of these numbers; the “JavaScript shipped” row shows the cost.`}
      </p>
    </section>
  );
}

function StatusMark({ status }) {
  const { icon: Icon, label } = STATUS[status] ?? STATUS.open;
  return (
    <span className={styles.mark} data-status={status} role="img" aria-label={label}>
      <Icon size={11} strokeWidth={3} />
    </span>
  );
}

function Side({ label, side }) {
  if (!side) return null;
  return (
    <div className={styles.side}>
      <dt>{label}</dt>
      <dd>{side.detail || (side.status === 'pass' ? 'Passes' : side.status)}</dd>
    </div>
  );
}

function LinkList({ title, links }) {
  if (!links?.length) return null;
  return (
    <div className={styles.links}>
      <span>{title}</span>
      <ul>
        {links.slice(0, 20).map((l) => (
          <li key={l.url} className="mono">
            {l.url}
            {l.status != null && <span className={styles.linkStatus}> · {l.status}</span>}
          </li>
        ))}
        {links.length > 20 && <li>…and {links.length - 20} more</li>}
      </ul>
    </div>
  );
}

function Evidence({ evidence }) {
  if (!evidence?.length) return null;
  return (
    <ul className={styles.evidence}>
      {evidence.map((e, i) =>
        e.fix ? (
          <li key={e.fix}>
            Recreate fix: {e.title}
            {e.count != null && ` (${e.count})`}
            {e.open > 0 && ` · ${e.open} left for review`}
          </li>
        ) : (
          <li key={`auto-${i}`}>
            {e.autoGenerated} auto-generated {e.autoGenerated === 1 ? 'value' : 'values'} ({e.fields.join(', ')})
            {e.examples?.[0] && (
              <>
                , e.g. <q>{e.examples[0].value}</q>
              </>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function Row({ item }) {
  const meta = STATUS[item.status] ?? STATUS.open;
  return (
    <li className={styles.row} data-status={item.status}>
      <details>
        <summary>
          <StatusMark status={item.status} />
          <span className={styles.rowTitle}>{item.title}</span>
          {item.review && <Badge tone="warn">Review</Badge>}
          <span className={styles.rowTag}>{item.statusLabel ?? meta.label}</span>
          <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
        </summary>
        <div className={styles.rowBody}>
          {item.status === 'manual' ? (
            <p className={styles.detail}>{item.detail}</p>
          ) : (
            <dl className={styles.sides}>
              <Side label="Before" side={item.before} />
              <Side label="Now" side={item.after} />
            </dl>
          )}
          <LinkList title="Fixed" links={item.links?.fixed} />
          <LinkList title="Still broken" links={item.links?.open} />
          <LinkList title="New" links={item.links?.new} />
          <LinkList title="Could not be reached on this run" links={item.links?.recheck} />
          <Evidence evidence={item.evidence} />
          {item.review && <p className={styles.review}>Text was generated from the page; check that it reads right.</p>}
          {item.note && <p className={styles.note}>{item.note}</p>}
          {item.helpUrl && (
            <a className={styles.help} href={item.helpUrl} target="_blank" rel="noopener noreferrer">
              How to fix
            </a>
          )}
        </div>
      </details>
    </li>
  );
}

function Category({ category, items, filter }) {
  const shown = items.filter((i) => (filter ? i.status === filter : i.status !== 'pass'));
  const passing = filter ? [] : items.filter((i) => i.status === 'pass');
  if (!shown.length && !passing.length) return null;
  const counts = CHIPS.map((s) => [s, items.filter((i) => i.status === s).length]).filter(([, n]) => n);
  const open = Boolean(filter) || items.some((i) => NEEDS_ACTION.has(i.status));
  return (
    <details className={styles.category} open={open}>
      <summary>
        <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
        <span className={styles.categoryLabel}>{category.label}</span>
        <span className={styles.categoryCounts}>
          {counts.map(([s, n]) => (
            <span key={s} data-status={s}>
              {n} {STATUS[s].chip.toLowerCase()}
            </span>
          ))}
          {!counts.length && <span data-status="pass">all passing</span>}
        </span>
      </summary>
      <ul className={styles.rows}>
        {shown.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </ul>
      {passing.length > 0 && (
        <details className={styles.passing}>
          <summary>Passing on both sides ({passing.length})</summary>
          <ul className={styles.rows}>
            {passing.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

/**
 * The real fix checklist (audit.recreate when it is not the sample): the original analysis compared with
 * a re-audit of the recreated site. Score strip, status chips (they filter the rows), category sections.
 */
export default function FixReport({ data, busy, onReaudit }) {
  const [filter, setFilter] = useState(null);
  const { summary = {}, items = [], categories = [], scope, notes = [] } = data;
  const compared = scope?.pages?.length ?? 0;
  const outOfScope = scope?.outOfScope?.length ?? 0;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <span className={styles.title}>
            Original vs recreated{data.stackLabel && <Badge tone={data.stack === 'html' ? 'neutral' : 'accent'}>{data.stackLabel}</Badge>}
          </span>
          <span className={styles.meta}>
            Re-audited {data.reauditedAt ? new Date(data.reauditedAt).toLocaleString() : '—'}
            {compared > 0 && ` · ${compared} ${compared === 1 ? 'page' : 'pages'} compared`}
            {outOfScope > 0 && ` · ${outOfScope} not recreated`}
          </span>
        </div>
        <Button size="sm" icon={RotateCw} onClick={onReaudit} disabled={busy} title={busy ? 'A job is running' : 'Audit the recreated site again'}>
          Re-audit
        </Button>
      </div>

      {data.stale && (
        <div className={styles.banner} data-tone="warn" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          <div>
            {data.staleReasons.map((r) => (
              <p key={r}>{STALE[r] ?? r}</p>
            ))}
          </div>
        </div>
      )}
      {data.lastError && (
        <div className={styles.banner} data-tone="bad" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          <p>The latest re-audit failed: {data.lastError} The checklist below is from the previous run.</p>
        </div>
      )}

      <ScoreStrip scores={data.scores} metrics={data.metrics} stackLabel={data.stack && data.stack !== 'html' ? data.stackLabel : null} />

      <div className={styles.chips} role="group" aria-label="Filter by status">
        {CHIPS.map((s) =>
          summary[s] ? (
            <button
              key={s}
              type="button"
              className={styles.chip}
              data-status={s}
              aria-pressed={filter === s}
              onClick={() => setFilter(filter === s ? null : s)}
            >
              <StatusMark status={s} />
              <span className="mono">{summary[s]}</span> {STATUS[s].chip}
            </button>
          ) : null,
        )}
        {filter && (
          <button type="button" className={styles.clear} onClick={() => setFilter(null)}>
            Show all
          </button>
        )}
      </div>

      {/* Remounted per filter so each section opens or closes for it. */}
      <div key={filter ?? 'all'} className={styles.categories}>
        {categories.map((c) => (
          <Category key={c.id} category={c} items={items.filter((i) => i.category === c.id)} filter={filter} />
        ))}
      </div>

      {notes.length > 0 && (
        <ul className={styles.notes}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
