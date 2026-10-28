'use client';

import { useEffect, useRef } from 'react';

/**
 * A figure that counts up once when it scrolls into view. The server renders the final value (so nothing is missing
 * without JavaScript or under reduced motion); the count only plays on the client. The width is reserved from the final
 * value, so nothing around it moves. `to` is shown exactly as given: the animation passes through other numbers, the
 * end state is always the stored figure.
 */
export function Count({ to, className }: { to: string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = el.current;
    if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!/^[0-9.]+$/.test(to)) return;
    const target = parseFloat(to);
    const decimals = (to.split('.')[1] ?? '').length;
    let frame = 0;
    node.textContent = (0).toFixed(decimals);
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / 1300);
          const eased = 1 - Math.pow(1 - t, 3);
          node.textContent = t < 1 ? (target * eased).toFixed(decimals) : to;
          if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      },
      { threshold: 0.6 },
    );
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [to]);

  return (
    <span ref={el} className={className} style={{ display: 'inline-block', minWidth: `${to.length}ch`, fontVariantNumeric: 'tabular-nums' }}>
      {to}
    </span>
  );
}
