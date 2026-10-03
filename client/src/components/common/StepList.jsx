import { StatusIcon } from './Score.jsx';
import styles from './StepList.module.css';

/**
 * What a job is doing, in plain words: a vertical list of steps, each done / active / pending / failed, with a
 * one-line explanation under the active one.
 * steps: [{ key, title, explain?, state: 'done'|'active'|'pending'|'failed', detail? }]
 */
export default function StepList({ steps }) {
  return (
    <ol className={styles.list}>
      {steps.map((s) => (
        <li key={s.key} className={styles.item} data-state={s.state}>
          <StatusIcon tone={s.state === 'done' ? 'done' : s.state === 'active' ? 'running' : s.state === 'failed' ? 'bad' : 'pending'} size={22} />
          <div className={styles.text}>
            <span className={styles.title}>{s.title}</span>
            {s.state === 'active' && (s.detail || s.explain) && <span className={styles.explain}>{s.detail || s.explain}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
