import { useEffect } from 'react';

// Share of the way down (0–1) an element is scrolled.
const progress = (el) => {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
};

const follow = (from, to) => {
  to.scrollTop = progress(from) * (to.scrollHeight - to.clientHeight);
};

/**
 * While `enabled`, scrolling either element scrolls the other to the same share of its own height,
 * so both show the same part of the page even when they are drawn at different sizes. When turned
 * on (or when an element is replaced), the second element is aligned to the first.
 * @param {HTMLElement|null} a  the OLD scroller (the screenshot)
 * @param {HTMLElement|null} b  the NEW scroller (the recreated page at full height)
 */
export function useSyncScroll(a, b, enabled) {
  useEffect(() => {
    if (!enabled || !a || !b) return undefined;
    // The element the user is scrolling; scroll events of the other one are our own updates.
    let leader = null;
    let frame = 0;
    let release = 0;
    const onScroll = (from, to) => () => {
      if (leader && leader !== from) return;
      leader = from;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(release);
      frame = requestAnimationFrame(() => {
        follow(from, to);
        // Let the follower's own scroll event pass before either element may lead again.
        release = requestAnimationFrame(() => {
          leader = null;
        });
      });
    };
    const onA = onScroll(a, b);
    const onB = onScroll(b, a);
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    follow(a, b);
    return () => {
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(release);
    };
  }, [a, b, enabled]);
}
