import { Check, Hand, X } from 'lucide-react';
import styles from './FixChecklist.module.css';

const META = {
  fixed: { icon: Check, label: 'Fixed' },
  open: { icon: X, label: 'Still open' },
  manual: { icon: Hand, label: 'Manual' },
};

export default function FixChecklist({ items }) {
  const fixed = items.filter((i) => i.status === 'fixed').length;
  const pct = Math.round((fixed / items.length) * 100);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>Fix checklist</span>
        <span className={`${styles.count} mono`}>
          {fixed}/{items.length} fixed
        </span>
      </div>
      <div className={styles.progress} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ul className={styles.list}>
        {items.map((it) => {
          const { icon: Icon, label } = META[it.status];
          return (
            <li key={it.title} className={styles.item} data-status={it.status}>
              <span className={styles.mark} aria-label={label}>
                <Icon size={11} strokeWidth={3} />
              </span>
              <span className={styles.text}>{it.title}</span>
              {it.status !== 'fixed' && <span className={styles.tag}>{label}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
