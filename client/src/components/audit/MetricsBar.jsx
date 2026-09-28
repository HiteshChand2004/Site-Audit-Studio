import { useState } from 'react';
import styles from './MetricsBar.module.css';

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
// Lighthouse can fail on a site; its metrics are then null and render as a dash.
const show = (v, fmt) => (v == null ? '—' : fmt(v));
const toneOf = (v, fn) => (v == null ? 'none' : fn(v));

// Lighthouse thresholds (good / needs-improvement)
const grade = {
  loadTime: (v) => (v <= 3000 ? 'ok' : v <= 5000 ? 'warn' : 'bad'),
  lcp: (v) => (v <= 2500 ? 'ok' : v <= 4000 ? 'warn' : 'bad'),
  tbt: (v) => (v <= 200 ? 'ok' : v <= 600 ? 'warn' : 'bad'),
  pageSize: (v) => (v <= 1.6 * 1024 * 1024 ? 'ok' : v <= 4 * 1024 * 1024 ? 'warn' : 'bad'),
};
const scoreTone = (s) => (s >= 90 ? 'ok' : s >= 50 ? 'warn' : 'bad');

const HINTS = {
  'Load time': 'Time to Interactive (Lighthouse). Good ≤ 3s, poor > 5s',
  LCP: 'Largest Contentful Paint. Good ≤ 2.5s, poor > 4s',
  TBT: 'Total Blocking Time. Good ≤ 200ms, poor > 600ms',
  'Page size': 'Total transfer size of the homepage. Good ≤ 1.6 MB, poor > 4 MB',
};

const EMPTY = { loadTime: null, lcp: null, tbt: null, pageSize: null };

const SCORE_LABELS = [
  ['performance', 'Perf'],
  ['seo', 'SEO'],
  ['accessibility', 'A11y'],
  ['bestPractices', 'Best'],
];

function Ring({ value, label }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className={styles.ring} data-tone={value == null ? 'none' : scoreTone(value)}>
      <svg viewBox="0 0 36 36" width="40" height="40" aria-hidden="true">
        <circle cx="18" cy="18" r={r} className={styles.track} />
        <circle
          cx="18"
          cy="18"
          r={r}
          className={styles.arc}
          strokeDasharray={`${((value ?? 0) / 100) * c} ${c}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className={`${styles.ringValue} mono`}>{value ?? '—'}</span>
      <span className={styles.ringLabel}>{label}</span>
    </div>
  );
}

/**
 * Lighthouse metrics and scores for one device. `metricsByDevice` holds both runs; audits from
 * before it existed only have the mobile `metrics`. The device can be controlled by the parent
 * (it follows the preview's viewport) or left to this component.
 */
export default function MetricsBar({ metrics: mobileOnly, metricsByDevice, scores, device: controlled, onDeviceChange }) {
  const [ownDevice, setOwnDevice] = useState('mobile');
  const device = controlled ?? ownDevice;
  const setDevice = onDeviceChange ?? setOwnDevice;
  const metrics = metricsByDevice?.[device] ?? (device === 'mobile' ? mobileOnly : null) ?? EMPTY;
  const noDesktop = device === 'desktop' && !metricsByDevice;
  const items = [
    ['Load time', show(metrics.loadTime, fmtMs), toneOf(metrics.loadTime, grade.loadTime)],
    ['LCP', show(metrics.lcp, fmtMs), toneOf(metrics.lcp, grade.lcp)],
    ['TBT', show(metrics.tbt, fmtMs), toneOf(metrics.tbt, grade.tbt)],
    ['Page size', show(metrics.pageSize, fmtBytes), toneOf(metrics.pageSize, grade.pageSize)],
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.metrics}>
        {items.map(([label, value, tone]) => (
          <div key={label} className={styles.metric} title={HINTS[label]}>
            <span className={styles.label}>
              <span className={styles.dot} data-tone={tone} aria-hidden="true" />
              {label}
            </span>
            <span className={`${styles.value} mono`}>{value}</span>
          </div>
        ))}
      </div>
      {noDesktop && <p className={styles.note}>Desktop metrics are available for analyses run after this update. Run Analyze again to see them.</p>}
      <div className={styles.scores}>
        <div className={styles.toggle} role="group" aria-label="Device">
          {['mobile', 'desktop'].map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
              {d === 'mobile' ? 'Mobile' : 'Desktop'}
            </button>
          ))}
        </div>
        <div className={styles.rings}>
          {scores[device] ? (
            SCORE_LABELS.map(([key, label]) => <Ring key={key} value={scores[device][key]} label={label} />)
          ) : (
            <span className={styles.noScores}>Lighthouse did not finish for {device}.</span>
          )}
        </div>
      </div>
    </div>
  );
}
