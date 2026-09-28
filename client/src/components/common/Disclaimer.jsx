import { ShieldCheck } from 'lucide-react';
import styles from './Disclaimer.module.css';

export default function Disclaimer() {
  return (
    <p
      className={styles.bar}
      role="note"
      title="Use Audit and Recreate only on company-owned or authorized websites."
    >
      <ShieldCheck size={14} aria-hidden="true" />
      <span>
        Use Audit and Recreate only on company-owned or authorized websites.
      </span>
    </p>
  );
}
