import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up from 0 when it appears (and from the old value when it changes). Other values are shown as they are. */
export default function CountUp({ value, duration = 900 }) {
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const [shown, setShown] = useState(numeric && !reduced() ? 0 : value);
  const from = useRef(0);

  useEffect(() => {
    if (!numeric || reduced()) {
      setShown(value);
      return undefined;
    }
    const start = performance.now();
    const origin = from.current;
    let frame;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(origin + (value - origin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, numeric, duration]);

  return <>{shown}</>;
}
