import { useEffect } from 'react';

/**
 * Something "Scrolling together" can move: where it stands as a share of the way down (0–1), a way to move it there, and
 * a way to hear the person scroll it. `listen(onMove, onReady)` returns its own undo; `onReady` asks to be aligned again
 * (a frame that has just loaded a page).
 * @typedef {{ read: () => number, write: (share: number) => void, listen: (onMove: (share: number) => void, onReady: () => void) => () => void }} Scroller
 */

/** A scrollable box of the app (the picture of a page). */
function boxScroller(el) {
  const room = () => el.scrollHeight - el.clientHeight;
  return {
    read: () => (room() > 0 ? el.scrollTop / room() : 0),
    write: (share) => { el.scrollTop = share * room(); },
    listen: (onMove) => {
      const on = () => onMove(room() > 0 ? el.scrollTop / room() : 0);
      el.addEventListener('scroll', on, { passive: true });
      return () => el.removeEventListener('scroll', on);
    },
  };
}

/**
 * The copy's live frame, at its own window height. It is another origin (sandboxed), so it is moved and heard through the
 * preview's script (server/src/recreate/previewShim.js): `{ sasPreview: 1, scrollTo }` in, `{ sasPreview: 1, token, scroll }` out.
 * @param {HTMLIFrameElement} frame
 * @param {string} token  the preview's token: only its reports are listened to
 * @returns {Scroller}
 */
export function frameScroller(frame, token) {
  let last = 0;
  return {
    read: () => last,
    write: (share) => {
      last = share;
      try { frame.contentWindow?.postMessage({ sasPreview: 1, scrollTo: share }, '*'); } catch { /* the frame is gone */ }
    },
    listen: (onMove, onReady) => {
      const onMessage = (e) => {
        const d = e.data;
        if (e.source !== frame.contentWindow || e.origin !== 'null' || !d || d.sasPreview !== 1 || d.token !== token) return;
        if (typeof d.scroll === 'number' && d.scroll >= 0 && d.scroll <= 1) {
          last = d.scroll;
          onMove(d.scroll);
        } else if (typeof d.height === 'number') {
          // The page has drawn (or grown): put it where the other side stands.
          onReady();
        }
      };
      window.addEventListener('message', onMessage);
      frame.addEventListener('load', onReady);
      return () => {
        window.removeEventListener('message', onMessage);
        frame.removeEventListener('load', onReady);
      };
    },
  };
}

const asScroller = (x) => (x && typeof x.listen === 'function' ? x : x ? boxScroller(x) : null);

/** A move this close to what was just written to a side is that side echoing the write, not the person scrolling it. */
const ECHO = 0.002;

/**
 * While `enabled`, scrolling either side scrolls the other to the same share of its own height, so both show the same part
 * of the page even when they are drawn at different sizes. When turned on (or when a side is replaced or reloads), the
 * second side is aligned to the first.
 * @param {HTMLElement|Scroller|null} a  the original (its picture)
 * @param {HTMLElement|Scroller|null} b  the copy (its picture, or its live frame)
 */
export function useSyncScroll(a, b, enabled) {
  useEffect(() => {
    const A = asScroller(a);
    const B = asScroller(b);
    if (!enabled || !A || !B) return undefined;
    // What was last written to each side: its own scroll report of that value is not a move of the person.
    const written = new Map();
    let frame = 0;
    const move = (from, to) => (share) => {
      const mine = written.get(from);
      if (mine != null && Math.abs(share - mine) < ECHO) return;
      written.delete(from);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        written.set(to, share);
        to.write(share);
      });
    };
    const align = () => {
      const share = A.read();
      written.set(B, share);
      B.write(share);
    };
    const offA = A.listen(move(A, B), () => {});
    const offB = B.listen(move(B, A), align);
    align();
    return () => {
      offA();
      offB();
      cancelAnimationFrame(frame);
    };
  }, [a, b, enabled]);
}
