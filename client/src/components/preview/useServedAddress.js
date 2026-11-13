import { useEffect, useState } from 'react';

/** Tries before an address is given up on (waits 1, 2, 4, 8 s between them, ~15 s in all). */
const TRIES = 5;

/**
 * An address the API hands out for a preview (the live original, an as-is copy), kept current. Previews live only as long as
 * the API process, so one failed ask (the API restarting, briefly busy) must not leave the screen stuck, and an address from
 * before a restart is dead: it is asked for again while it fails, whenever the tab comes back, and when `retry` is called.
 * @param {(() => Promise<string>) | null} ask  resolves with the address; null = nothing to ask for
 * @param {unknown[]} deps  what the address depends on
 * @returns {{ url: string | null, error: string | null, retry: () => void }}
 */
export function useServedAddress(ask, deps) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!ask) return undefined;
    let alive = true;
    let timer = 0;
    const once = (attempt = 0) => ask().then((u) => {
      if (!alive) return;
      // The same address again keeps the frame as it is (no reload); a new one (after a restart) replaces it.
      setUrl((old) => (old === u ? old : u));
      setError(null);
    }).catch((err) => {
      if (!alive) return;
      if (attempt < TRIES - 1) timer = setTimeout(() => once(attempt + 1), 1000 * 2 ** attempt);
      else setError(err?.message || 'The app could not open it.');
    });
    once();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      once();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [...deps, round]);
  return { url, error, retry: () => setRound((n) => n + 1) };
}
