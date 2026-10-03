import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import styles from './InfoTip.module.css';

/**
 * A small "i" next to a term: shows a plain-language explanation on hover, keyboard focus or a tap (touch screens).
 * Esc or a click elsewhere closes a tapped-open tip.
 */
export default function InfoTip({ label = 'What does this mean?', children, align = 'center' }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!pinned) return undefined;
    const close = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) setPinned(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [pinned]);

  return (
    <span className={styles.wrap} ref={ref} data-open={pinned || undefined}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <span id={id} role="tooltip" className={styles.tip} data-align={align}>
        {children}
      </span>
    </span>
  );
}
