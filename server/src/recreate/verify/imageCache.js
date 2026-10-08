// Decoded, scaled screenshots of the original, shared by every comparison of a job. The fidelity check, the breakpoint
// check (refine.js) and the responsive step compare many renders of the copy with the same few screenshots of the original
// (capture/<slug>/…webp), and each comparison decoded and scaled that file again (a 1440 × 8000 WebP takes ~50–150 ms).
// Now a file is decoded once per scale; the result is the same pixels, so every score stays exactly the same.
// Files given by path are kept keyed by path, size
// and modification time (a file written again is read again), within a memory bound (least recently used dropped first),
// and emptied once no comparison used it for a while (the server process does not keep the memory between jobs).
// A screenshot of the copy arrives as a buffer: its decodes are kept with the buffer itself (a WeakMap), so the comparisons of
// one render share them and they go when the buffer does.
// SAS_COPY_OPT_IMAGE_CACHE=0 (or SAS_COPY_OPTIMIZE=0): every call decodes the file, as before.
import { stat } from 'node:fs/promises';
import { optimized } from '../optimize.js';

const MAX_BYTES = 256 * 1024 * 1024;
const entries = new Map(); // key → { promise, bytes }
let total = 0;
const stats = { hits: 0, misses: 0 };
const buffers = new WeakMap(); // Buffer → Map(variant → promise)
const IDLE_MS = 120000;
let idle = null;
const touch = () => {
  clearTimeout(idle);
  idle = setTimeout(() => { entries.clear(); total = 0; }, IDLE_MS);
  idle.unref?.();
};

const trim = () => {
  for (const [key, e] of entries) {
    if (total <= MAX_BYTES) break;
    entries.delete(key);
    total -= e.bytes;
  }
};

/**
 * `decode(input)` for `input` (a path or a buffer), cached per path when the cache is on. `variant` names how it is decoded
 * (scale, blur…), so one file can be kept at several scales. The value must be treated as read-only by the caller.
 * @template T
 * @param {string|Buffer} input
 * @param {string} variant
 * @param {(input: string|Buffer) => Promise<T & { data: Buffer }>} decode
 * @returns {Promise<T>}
 */
export async function decodeCached(input, variant, decode) {
  if (!optimized('IMAGE_CACHE')) return decode(input);
  if (Buffer.isBuffer(input)) {
    let own = buffers.get(input);
    if (!own) buffers.set(input, (own = new Map()));
    if (own.has(variant)) {
      stats.hits++;
      return own.get(variant);
    }
    stats.misses++;
    const promise = decode(input);
    own.set(variant, promise);
    promise.catch(() => own.delete(variant));
    return promise;
  }
  if (typeof input !== 'string') return decode(input);
  const info = await stat(input).catch(() => null);
  if (!info) return decode(input); // let the decoder report the missing file as before
  const key = `${input}|${info.size}|${info.mtimeMs}|${variant}`;
  touch();
  const hit = entries.get(key);
  if (hit) {
    stats.hits++;
    // Most recently used last.
    entries.delete(key);
    entries.set(key, hit);
    return hit.promise;
  }
  stats.misses++;
  const entry = { promise: decode(input), bytes: 0 };
  entries.set(key, entry);
  try {
    const value = await entry.promise;
    if (entries.get(key) === entry) {
      entry.bytes = value?.data?.length ?? 0;
      total += entry.bytes;
      trim();
    }
    return value;
  } catch (err) {
    // A failed decode is not kept: the next call tries the file again.
    if (entries.get(key) === entry) entries.delete(key);
    throw err;
  }
}

/** Hits and misses so far (tests, diagnostics). */
export const imageCacheStats = () => ({ ...stats, entries: entries.size, bytes: total });

/** Empties the cache (tests; a job never needs it: keys change with the files). */
export function clearImageCache() {
  entries.clear();
  total = 0;
  stats.hits = 0;
  stats.misses = 0;
}
