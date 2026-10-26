import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './Details.module.css';

/**
 * "Show details": the one fold every screen uses for what most people do not need (expert terms, raw values, long
 * lists). Closed by default; the button says what it does next ("Show details" / "Hide details").
 */
export default function Details({ label = 'details', defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={styles.details}>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={14} className={styles.chevron} data-open={open} aria-hidden="true" />
        {open ? 'Hide' : 'Show'} {label}
      </button>
      {open && (
        <div id={id} className={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
}
