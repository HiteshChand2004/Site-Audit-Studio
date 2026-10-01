// A small in-memory rate limiter for the form endpoint: at most `max` accepted requests per key (the client's
// address) in a window. One process only; put a shared limiter (or your host's) in front when you scale out.

export function createLimiter({ windowMs = 60 * 60 * 1000, max = 20, now = Date.now } = {}) {
  const hits = new Map(); // key → timestamps inside the window

  const prune = (t) => {
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((s) => t - s < windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  };

  return {
    /** @returns {{ ok: boolean, retryAfter: number }} retryAfter in seconds when not ok */
    take(key) {
      const t = now();
      if (hits.size > 10000) prune(t);
      const stamps = (hits.get(key) ?? []).filter((s) => t - s < windowMs);
      if (stamps.length >= max) {
        hits.set(key, stamps);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((stamps[0] + windowMs - t) / 1000)) };
      }
      stamps.push(t);
      hits.set(key, stamps);
      return { ok: true, retryAfter: 0 };
    },
  };
}
