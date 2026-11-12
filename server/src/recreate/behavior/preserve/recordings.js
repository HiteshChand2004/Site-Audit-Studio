// What an as-is copy recorded of the original while it captured the pages: each page's snapshots (<view>.json), the animation,
// hover and click recordings (motion.json, <view>-motion.json, <view>-clicks.json …), the pictures and the network record. A
// converted copy (React + Vite, Next.js, MERN) rebuilds the original's animations from them once the original's framework code
// is taken out, so they must travel with the copy: a repack (another stack, the new address, the approved changes) starts from
// an earlier job, and that job's folder is removed once newer copies replace it. Before, a repack kept only the pictures, so a
// copy repacked twice had nothing left to rebuild from.
//
// The files are hard-linked (copied where links are not possible): no extra disk space, and the new job stays complete when the
// old one is removed.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { linkTree } from '../../replay.js';
import { motionFile } from '../../capture/index.js';
import { slugFor } from '../../discover.js';

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

/**
 * Which pages have their recordings in a job folder: the desktop snapshot and the desktop animation recording are what a
 * rebuild needs at the least.
 * @param {string} dir  the job folder
 * @param {{ outPath: string }[]} pages
 * @returns {Promise<{ pages: number, recorded: number, missing: string[] }>}  missing: the outPaths with no recording
 */
export async function recordingsOf(dir, pages) {
  const missing = [];
  for (const p of pages) {
    const pageDir = path.join(dir, 'capture', slugFor(p.outPath));
    const ok = (await isFile(path.join(pageDir, 'desktop.json'))) && (await isFile(path.join(pageDir, motionFile('desktop'))));
    if (!ok) missing.push(p.outPath);
  }
  return { pages: pages.length, recorded: pages.length - missing.length, missing };
}

/**
 * The earlier job's capture folder, carried into this job (hard links). Nothing is carried when the earlier job has none
 * (an older repack, made before the recordings travelled): `recorded` says so, and the stack is packaged as before.
 * @returns {Promise<{ from: string, files: number, pages: number, recorded: number, missing: string[] }>}
 */
export async function carryRecordings(fromDir, dir, pages) {
  const from = path.join(fromDir, 'capture');
  const files = (await isDir(from)) && (await readdir(from)).length ? await linkTree(from, path.join(dir, 'capture')) : 0;
  return { from: path.basename(fromDir), files, ...(await recordingsOf(dir, pages)) };
}
