// Downloads started ahead of the walk that uses them. The lift and the referenced-file pass go through a page's files one
// at a time, in an order that decides names, the file list and what is written (and later steps read what earlier ones
// wrote), so the walk itself stays as it is. What a walk will certainly download is known before it starts; those downloads
// are started here, AT_ONCE at a time, and the walk takes each answer at the very place it would have asked for it. A file
// the walk asks for that was not started ahead is fetched then, as before. Same requests, same answers, same order of use:
// only the waiting overlaps.

/** Downloads in flight at once: the asset step's own number (assets/index.js), which real sites have taken. */
export const AT_ONCE = 6;

/**
 * @param {(url: string, opts: object) => Promise<any>} fetchImpl  the download function the walk uses (downloadAsset)
 * @param {{ atOnce?: number }} [o]
 */
export function createPrefetch(fetchImpl, { atOnce = AT_ONCE } = {}) {
  /** key → the downloads started (or queued) for it, oldest first; each is taken once. */
  const ahead = new Map();
  const queue = [];
  const all = [];
  let running = 0;

  const pump = () => {
    while (running < atOnce && queue.length) queue.shift().start();
  };
  const entryFor = (url, opts) => {
    let started = null;
    const entry = {
      started: false,
      start() {
        if (entry.started) return started;
        entry.started = true;
        running++;
        started = Promise.resolve().then(() => fetchImpl(url, opts)).finally(() => {
          running--;
          pump();
        });
        all.push(started.catch(() => {}));
        return started;
      },
    };
    return entry;
  };

  return {
    /** Starts (or queues) a download the walk will ask for with the same key. One call = one download, taken once. */
    ahead(key, url, opts) {
      const entry = entryFor(url, opts);
      if (!ahead.has(key)) ahead.set(key, []);
      ahead.get(key).push(entry);
      queue.push(entry);
      pump();
    },
    /** The answer to a download the walk asks for now: the oldest one started ahead for the key, else a download now. */
    take(key, url, opts) {
      const list = ahead.get(key);
      const entry = list?.shift();
      if (!entry) return fetchImpl(url, opts);
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      return entry.start();
    },
    /** Waits for every download started, taken or not: nothing still writes into a folder the caller then removes. */
    async settle() {
      queue.length = 0;
      await Promise.all(all);
    },
  };
}
