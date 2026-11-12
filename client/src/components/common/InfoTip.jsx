import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import styles from './InfoTip.module.css';

// The tip's widest (InfoTip.module.css max-width) and the room it keeps from the edge of the area it shows in.
const TIP_WIDTH = 280;
const EDGE = 8;

/**
 * Which way the tip opens so it stays inside the area that would cut it off (the nearest scrolling box, else the window):
 * the asked side when it fits, else another that fits, else the side with the most room, narrower to fit there.
 */
function placeTip(wrap, align) {
  let left = 0;
  let right = window.innerWidth;
  for (let a = wrap.parentElement; a; a = a.parentElement) {
    if (getComputedStyle(a).overflowX !== 'visible') {
      const r = a.getBoundingClientRect();
      left = Math.max(left, r.left);
      right = Math.min(right, r.right);
      break;
    }
  }
  const r = wrap.getBoundingClientRect();
  const mid = r.left + r.width / 2;
  // How wide the tip can be on each side and stay inside.
  const room = {
    center: 2 * Math.min(mid - left - EDGE, right - EDGE - mid),
    start: right - EDGE - (r.left - 6),
    end: r.right + 6 - (left + EDGE),
  };
  const side = [align, 'center', 'end', 'start'].find((s) => room[s] >= TIP_WIDTH)
    ?? Object.keys(room).reduce((a, b) => (room[b] > room[a] ? b : a));
  return { side, width: Math.max(120, Math.min(TIP_WIDTH, Math.floor(room[side]))) };
}

/**
 * A small "i" next to a term: shows a plain-language explanation on hover, keyboard focus or a tap (touch screens).
 * Esc or a click elsewhere closes a tapped-open tip. It opens toward the inside of the window, so a tip next to the right
 * edge (a narrow or split window) is never cut off.
 */
export default function InfoTip({ label = 'What does this mean?', children, align = 'center' }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState({ side: align, width: TIP_WIDTH });
  const ref = useRef(null);
  const measure = () => {
    if (ref.current) setPlace(placeTip(ref.current, align));
  };

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
    <span className={styles.wrap} ref={ref} data-open={pinned || undefined} onPointerEnter={measure} onFocus={measure}>
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={(e) => {
          e.stopPropagation();
          measure();
          setPinned((p) => !p);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <span id={id} role="tooltip" className={styles.tip} data-align={place.side} style={{ maxWidth: place.width }}>
        {children}
      </span>
    </span>
  );
}
