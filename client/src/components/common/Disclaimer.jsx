import { ShieldCheck } from 'lucide-react';
import styles from './Disclaimer.module.css';

export default function Disclaimer() {
  return (
    <p
      className={styles.bar}
      role="note"
      title="Audit aur Recreate sirf company ki apni ya authorized websites par use karein."
    >
      <ShieldCheck size={14} aria-hidden="true" />
      <span>
        Audit aur Recreate sirf company ki apni ya authorized websites par use karein.
      </span>
    </p>
  );
}
