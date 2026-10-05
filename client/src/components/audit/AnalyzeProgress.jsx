import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Alert } from '../common/Surface.jsx';
import StepList from '../common/StepList.jsx';
import { JOB_STEPS, stepTitle } from '../../copy.js';
import styles from './AnalyzeProgress.module.css';

const LABELS = {
  analysis: { running: 'Checking the site', queued: 'Waiting to check the site', failed: 'The check did not finish' },
  recreate: { running: 'Creating the copy', queued: 'Waiting to create the copy', failed: 'The copy could not be finished' },
  reaudit: { running: 'Comparing the copy with the original', queued: 'Waiting to compare the copy', failed: 'The comparison did not finish' },
};

/** "4 min 12 s" since `iso`, updated every second while shown. */
function useElapsed(iso) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

/**
 * Live progress of a background job (check, copy or comparison; fed by the server's event stream), in plain words:
 * what is happening now, a bar with the time so far, and the steps. Or, when it failed, why.
 */
export default function AnalyzeProgress({ analysis, kind = 'analysis', onDismiss }) {
  const labels = LABELS[kind];
  const elapsed = useElapsed(analysis.status === 'failed' ? null : analysis.startedAt);

  if (analysis.status === 'failed') {
    return (
      <Alert
        tone="bad"
        title={labels.failed}
        action={
          <Button variant="ghost" size="sm" icon={X} iconOnly onClick={onDismiss}>
            Close this message
          </Button>
        }
      >
        {analysis.error}
        <p className={styles.after}>Nothing was lost: the last finished result is still there. You can simply start it again.</p>
      </Alert>
    );
  }

  const steps = analysis.steps ?? [];
  const activeIndex = steps.findIndex((s) => s.key === analysis.step);
  const queued = analysis.status === 'queued';
  const pct = analysis.pct ?? 0;
  const list = steps.map((s, i) => ({
    key: s.key,
    title: stepTitle(s.key, s.label),
    explain: JOB_STEPS[s.key]?.explain,
    detail: i === activeIndex ? analysis.message : null,
    state: activeIndex === -1 ? 'pending' : i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
  }));

  return (
    <section className={styles.wrap} aria-live="polite" aria-label={labels.running}>
      <div className={styles.head}>
        <span className={styles.title}>{queued ? labels.queued : labels.running}</span>
        <span className={styles.meta}>
          <strong>{pct} %</strong>
          {elapsed && <span> · running for {elapsed}</span>}
        </span>
      </div>
      <div className={styles.bar} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={labels.running}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {queued && <p className={styles.explain}>Another job is running first (only one runs at a time, to keep the measurements fair). This starts by itself.</p>}
      {analysis.reconnecting && (
        <Alert tone="info" title="The connection to the app's server dropped for a moment">
          Reconnecting… The work goes on in the background.
        </Alert>
      )}
      {list.length > 0 && <StepList steps={list} />}
    </section>
  );
}
