'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Scroll reveals, played once. Nothing is hidden before this runs: elements already on screen simply stay as they are,
 * and only elements below the fold are "armed" (data-armed, which the CSS hides) and shown when they first scroll into
 * view, so a slow script never leaves content invisible. `[data-reveal]` animates the element itself; `[data-stagger]`
 * animates its children one after another (this sets --i on each child). `data-dir` picks the direction and distance.
 * Under reduced motion nothing is armed. Only transform and opacity ever change.
 */
export default function RevealObserver() {
  const pathname = usePathname();

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in), [data-stagger]:not(.is-in)'));
    document.querySelectorAll<HTMLElement>('[data-stagger]').forEach((c) => Array.from(c.children).forEach((ch, i) => (ch as HTMLElement).style.setProperty('--i', String(i))));
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const vh = window.innerHeight;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.92 && r.bottom > 0) {
        el.classList.add('is-in');
      } else {
        el.setAttribute('data-armed', '');
        io.observe(el);
      }
    }
    return () => io.disconnect();
  }, [pathname]);

  return null;
}
