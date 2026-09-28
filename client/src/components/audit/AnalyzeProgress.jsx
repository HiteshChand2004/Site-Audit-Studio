import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import Button from '../common/Button.jsx';
import styles from './AnalyzeProgress.module.css';

// Live progress of an Analyze job (fed by SSE), or its failure message.
export default function AnalyzeProgress({ analysis, onDismiss }) {
  if (analysis.status === 'failed') {
    return (
      <div className={styles.failed} role="alert">
        <AlertCircle size={15} aria-hidden="true" />
        <div className={styles.failedText}>
          <strong>Analysis failed</strong>
          <span>{analysis.error}</span>
        </div>
        <Button variant="ghost" size="sm" icon={X} iconOnly onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }

  const steps = analysis.steps ?? [];
  const activeIndex = steps.findIndex((s) => s.key === analysis.step);

  return (
    <div className={styles.wrap} aria-live="polite">
      <div className={styles.head}>
        <span className={styles.title}>
          <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          {analysis.status === 'queued' ? 'Queued' : 'Analyzing'}
        </span>
        <span className={`${styles.pct} mono`}>{analysis.pct ?? 0}%</span>
      </div>
      <div className={styles.bar} role="progressbar" aria-valuenow={analysis.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${analysis.pct ?? 0}%` }} />
      </div>
      {analysis.message && <p className={styles.message}>{analysis.message}</p>}
      <ol className={styles.steps}>
        {steps.map((s, i) => {
          const state = activeIndex === -1 ? 'pending' : i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
          return (
            <li key={s.key} data-state={state}>
              <span className={styles.marker} aria-hidden="true">
                {state === 'done' && <Check size={10} strokeWidth={3} />}
                {state === 'active' && <Loader2 size={10} strokeWidth={3} className={styles.spin} />}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
