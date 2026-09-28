import { useState } from 'react';
import styles from './MetricsBar.module.css';

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// Lighthouse thresholds (good / needs-improvement)
const grade = {
  loadTime: (v) => (v <= 3000 ? 'ok' : v <= 5000 ? 'warn' : 'bad'),
  lcp: (v) => (v <= 2500 ? 'ok' : v <= 4000 ? 'warn' : 'bad'),
  tbt: (v) => (v <= 200 ? 'ok' : v <= 600 ? 'warn' : 'bad'),
  pageSize: (v) => (v <= 1.6 * 1024 * 1024 ? 'ok' : v <= 4 * 1024 * 1024 ? 'warn' : 'bad'),
};
const scoreTone = (s) => (s >= 90 ? 'ok' : s >= 50 ? 'warn' : 'bad');

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
    <div className={styles.ring} data-tone={scoreTone(value)}>
      <svg viewBox="0 0 36 36" width="40" height="40" aria-hidden="true">
        <circle cx="18" cy="18" r={r} className={styles.track} />
        <circle
          cx="18"
          cy="18"
          r={r}
          className={styles.arc}
          strokeDasharray={`${(value / 100) * c} ${c}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className={`${styles.ringValue} mono`}>{value}</span>
      <span className={styles.ringLabel}>{label}</span>
    </div>
  );
}

export default function MetricsBar({ metrics, scores }) {
  const [device, setDevice] = useState('mobile');
  const items = [
    ['Load time', fmtMs(metrics.loadTime), grade.loadTime(metrics.loadTime)],
    ['LCP', fmtMs(metrics.lcp), grade.lcp(metrics.lcp)],
    ['TBT', fmtMs(metrics.tbt), grade.tbt(metrics.tbt)],
    ['Page size', fmtBytes(metrics.pageSize), grade.pageSize(metrics.pageSize)],
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.metrics}>
        {items.map(([label, value, tone]) => (
          <div key={label} className={styles.metric}>
            <span className={styles.label}>
              <span className={styles.dot} data-tone={tone} aria-hidden="true" />
              {label}
            </span>
            <span className={`${styles.value} mono`}>{value}</span>
          </div>
        ))}
      </div>
      <div className={styles.scores}>
        <div className={styles.toggle} role="group" aria-label="Device">
          {['mobile', 'desktop'].map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
              {d === 'mobile' ? 'Mobile' : 'Desktop'}
            </button>
          ))}
        </div>
        <div className={styles.rings}>
          {SCORE_LABELS.map(([key, label]) => (
            <Ring key={key} value={scores[device][key]} label={label} />
          ))}
        </div>
      </div>
    </div>
  );
}
