import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './SectionCard.module.css';

export default function SectionCard({ icon: Icon, title, meta, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={14} className={styles.chevron} data-open={open} aria-hidden="true" />
        {Icon && <Icon size={15} className={styles.icon} aria-hidden="true" />}
        <span className={styles.title}>{title}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </section>
  );
}
