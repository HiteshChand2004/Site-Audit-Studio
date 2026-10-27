'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Small CSS-animated visuals ([data-loop]) only run while they are on screen: this sets data-play on them when
 * visible and removes it when not (theme.css pauses every animation inside a [data-loop] without data-play).
 */
export function InViewPlay() {
  const pathname = usePathname();

  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-loop]'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => (el.dataset.play = ''));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting) el.dataset.play = '';
          else delete el.dataset.play;
        }
      },
      { rootMargin: '80px 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);

  return null;
}
