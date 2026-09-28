import styles from './Badge.module.css';

export default function Badge({ tone = 'neutral', dot = false, mono = false, children, className = '' }) {
  return (
    <span className={[styles.badge, styles[tone], mono && 'mono', className].filter(Boolean).join(' ')}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
