/** How long each part of a job took (ms), to find what to make faster. Measures only; changes nothing. */
export function partClock(now = Date.now) {
  const parts = {};
  const began = now();
  let current = null;
  let since = began;
  return {
    /** Ends the part running now (if any) and starts `name` (null: none). */
    start(name) {
      const t = now();
      if (current) parts[current] = (parts[current] ?? 0) + (t - since);
      current = name;
      since = t;
    },
    /** Every part's ms, plus `total` (from the start of the clock). */
    done() {
      this.start(null);
      return { ...parts, total: now() - began };
    },
  };
}
