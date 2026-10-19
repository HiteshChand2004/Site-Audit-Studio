'use client';

import { useEffect } from 'react';

const MAX_X = 5; // px of magnetic pull, horizontally
const MAX_Y = 4; // and vertically

/**
 * One pointer listener for the whole site (mouse and trackpad only, never under reduced motion):
 * - primary buttons lean a few pixels toward the cursor (--mx/--my, eased by the button's transform transition);
 * - hover cards move their radial glow to the cursor (--gx/--gy, offsets from the card centre).
 * Everything it writes ends up in a transform, so it stays on the compositor.
 */
export function PointerEffects() {
  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!fine.matches || reduced.matches) return;

    let frame = 0;
    let last: PointerEvent | null = null;
    let btn: HTMLElement | null = null;
    let card: HTMLElement | null = null;

    const clear = (el: HTMLElement | null, a: string, b: string) => {
      el?.style.removeProperty(a);
      el?.style.removeProperty(b);
    };

    const update = () => {
      frame = 0;
      const e = last;
      if (!e) return;
      const target = e.target instanceof Element ? e.target : null;

      const nextBtn = target?.closest<HTMLElement>('.btn--primary:not(:disabled)') ?? null;
      if (nextBtn !== btn) {
        clear(btn, '--mx', '--my');
        btn = nextBtn;
      }
      if (btn) {
        const r = btn.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        btn.style.setProperty('--mx', `${(Math.max(-1, Math.min(1, dx)) * MAX_X).toFixed(2)}px`);
        btn.style.setProperty('--my', `${(Math.max(-1, Math.min(1, dy)) * MAX_Y).toFixed(2)}px`);
      }

      const nextCard = target?.closest<HTMLElement>('.card--hover') ?? null;
      if (nextCard !== card) card = nextCard;
      if (card) {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--gx', `${(e.clientX - r.left - r.width / 2).toFixed(1)}px`);
        card.style.setProperty('--gy', `${(e.clientY - r.top - r.height / 2).toFixed(1)}px`);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      last = e;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onLeave = () => {
      clear(btn, '--mx', '--my');
      btn = null;
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      onLeave();
    };
  }, []);

  return null;
}
