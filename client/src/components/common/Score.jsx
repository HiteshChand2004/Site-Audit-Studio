import { AlertTriangle, Check, CircleDashed, Info, Loader2, Minus, X } from 'lucide-react';
import { rating } from '../../copy.js';
import CountUp from './CountUp.jsx';
import styles from './Score.module.css';

/**
 * A 0–100 score as a ring that fills up, the number in the middle and its rating in words under it
 * ("Good", "Needs work", "Poor"). size: 'md' (cards) | 'sm' (rows).
 */
export function ScoreRing({ score, size = 'md', showRating = true, label }) {
  const r = rating(score);
  const value = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className={styles.ring} data-size={size} data-tone={r.tone} role="img" aria-label={`${label ? `${label}: ` : ''}${score ?? 'not measured'}${score != null ? ' out of 100' : ''}, ${r.label}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className={styles.track} cx="18" cy="18" r="15.9155" />
        {score != null && <circle className={styles.fill} cx="18" cy="18" r="15.9155" strokeDasharray={`${value} 100`} />}
      </svg>
      <span className={styles.value}>{score == null ? '–' : <CountUp value={score} />}</span>
      {showRating && <span className={styles.rating}>{r.label}</span>}
    </div>
  );
}

const ICONS = {
  ok: Check,
  done: Check,
  warn: AlertTriangle,
  bad: X,
  info: Info,
  neutral: Minus,
  running: Loader2,
  pending: CircleDashed,
};

/** A small round status mark: ok | warn | bad | info | neutral | running | pending | done. */
export function StatusIcon({ tone = 'neutral', size = 20, label }) {
  const Icon = ICONS[tone] ?? Minus;
  return (
    <span className={styles.status} data-tone={tone} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <Icon size={Math.round(size * 0.6)} strokeWidth={2.5} />
    </span>
  );
}

/** A pill with the rating of a score, or any tone + text. */
export function Pill({ tone = 'neutral', children }) {
  return (
    <span className={styles.pill} data-tone={tone}>
      {children}
    </span>
  );
}
