// Small async helpers shared by the audit pipeline.

// Runs fn over items with at most `concurrency` calls in flight. Results keep input order.
export async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Returns a function that queues calls so at most `concurrency` run at once.
export function limiter(concurrency) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    if (waiting.length) waiting.shift()();
  };
  return async (fn) => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Where the time of a step goes: `lap(name)` adds the ms since the previous lap (or the start) to `ms[name]`.
 * Used for the report's per-phase timings (report.phaseMs), so what is worth speeding up can be read from a real run.
 */
export function lapTimer() {
  const ms = {};
  let mark = Date.now();
  return {
    ms,
    lap(name) {
      const now = Date.now();
      ms[name] = (ms[name] ?? 0) + now - mark;
      mark = now;
    },
  };
}

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Same-site comparison that treats www.example.com and example.com as one site.
export const siteHost = (hostname) => hostname.toLowerCase().replace(/^www\./, '');

export function sameSite(a, b) {
  try {
    return siteHost(new URL(a).hostname) === siteHost(new URL(b).hostname);
  } catch {
    return false;
  }
}

// Dedupe key for URLs: no hash, no trailing slash (except the root path).
export function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/**
 * Dedupe key for the pages of one site: `urlKey` without the scheme and with the site host (`www.` dropped), so
 * https://www.example.com/about and http://example.com/about/ are one page (sameSite already treats them as one site;
 * without this the crawl and the recreate visited every page of a site that links both forms twice).
 */
export function pageKey(url) {
  try {
    const u = new URL(urlKey(url));
    return `${siteHost(u.hostname)}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * Stable id of an audit check: its section plus its title as a slug ("seo.meta-description").
 * Items of stored audits that predate the key get the same id from their title (reaudit/compare).
 */
export const itemKey = (section, title) => `${section}.${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** An analyzer row; `count` (affected pages, images, …) is set when the check counts something. */
export const auditItem = (section, status, title, detail, count) => ({
  key: itemKey(section, title),
  status,
  title,
  detail,
  ...(count != null && { count }),
});

// "/a, /b, /c and 4 more"
export function examples(list, max = 3) {
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
}
