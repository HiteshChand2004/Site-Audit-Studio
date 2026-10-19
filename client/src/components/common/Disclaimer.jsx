import { ShieldCheck } from 'lucide-react';
import styles from './Disclaimer.module.css';

const FULL = 'Use Audit and Recreate only on company-owned or authorized websites.';

/**
 * The permanent authorization note, at the foot of the sidebar: a short line (the whole sentence on hover and for screen
 * readers); in the collapsed rail only its shield.
 */
export default function Disclaimer({ compact = false }) {
  return (
    <p className={styles.note} data-compact={compact} role="note" title={FULL}>
      <ShieldCheck size={14} aria-hidden="true" />
      <span className={styles.hidden}>{FULL}</span>
      {!compact && (
        <span aria-hidden="true">
          Authorized websites only
        </span>
      )}
    </p>
  );
}
