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
 * While `enabled`, scrolling either element scrolls the other to the same share of its own height
 * (the two panels have different content lengths, so pixels would drift apart). When turned on, the
 * second element is aligned to the first. `key` rebinds the listeners when the elements are replaced.
 * @param {import('react').RefObject<HTMLElement>} aRef
 * @param {import('react').RefObject<HTMLElement>} bRef
 */
export function useSyncScroll(aRef, bRef, enabled, key) {
  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!enabled || !a || !b) return undefined;
    // The panel the user is scrolling; scroll events of the other one are our own updates.
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
        // Let the follower's own scroll event pass before either panel may lead again.
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
  }, [aRef, bRef, enabled, key]);
}
