// How much the machine can do at once. Browser work (Analyze, Recreate, Re-audit) is fastest when independent pages / widths /
// views run side by side, but every Chromium context needs memory: on a machine that has run out of it (several browsers,
// an editor, other apps) more parallelism makes everything slower and makes loads time out. So the amount of parallel work is
// chosen from the memory that is available right now.
//
// The numbers are deliberately lenient: the operating system reports less than it can really hand out (caches, compressed
// pages), and running fewer things at once has a price of its own (measured on an 8 GB machine with about 1 GB available: two
// views at a time instead of four made the capture of six pages take 212 s instead of about 120 s, with no gain). Work is only
// cut back when memory is really exhausted (a few hundred MB), the state in which loads start to time out.
import os from 'node:os';

const MB = 1024 * 1024;
// Memory left alone for the rest of the machine.
const KEEP_FREE_MB = 300;
/** Memory one loaded page (a browser context) is counted with. */
export const PAGE_MB = 150;

/**
 * Memory that can be used without swapping, in MB. Windows and Linux report the available memory (free + reclaimable).
 * macOS only reports untouched pages, a number that is small on a healthy machine and says nothing: there the answer is
 * "unknown" (Infinity), so nothing is cut back.
 */
export const freeMemoryMB = () => (process.platform === 'darwin' ? Infinity : os.freemem() / MB);

/**
 * A hard cap on the browser contexts any step runs at once, from SAS_MAX_PARALLEL (server/.env, a whole number 1–8). For a machine
 * whose free memory looks fine on paper but loads still time out (8 GB with other apps open): the cap wins over every step's own
 * minimum, so 1 means strictly one page at a time. Unset or out of range = no cap (the memory rule below decides).
 */
export function maxParallel(env = process.env) {
  const n = Number(env.SAS_MAX_PARALLEL);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : Infinity;
}

/**
 * How many units of work (a browser context, a page) to run at once.
 * @param {{ perUnitMB?: number, max?: number, min?: number, keepFreeMB?: number, free?: number, cap?: number }} [o]
 *   perUnitMB: memory one unit needs; keepFreeMB: memory that must stay free for the rest of the machine; free, cap: overrides (tests)
 * @returns {number} between `min` and `max`, and never above SAS_MAX_PARALLEL (which may go below `min`, but not below 1 unless `min` is 0)
 */
export function parallelism({ perUnitMB = PAGE_MB, max = 4, min = 1, keepFreeMB = KEEP_FREE_MB, free = freeMemoryMB(), cap = maxParallel() } = {}) {
  const fit = free === Infinity ? max : Math.floor((free - keepFreeMB) / perUnitMB);
  const n = Math.max(min, Math.min(max, Number.isFinite(fit) ? fit : min));
  return Math.min(n, Math.max(cap, Math.min(min, 1)));
}
