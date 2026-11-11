// @ts-check
// Source code from a public GitHub repository, for build mode's code input. One archive download through the SSRF-guarded fetch
// (GitHub's API answers with a redirect to its archive host; every hop is checked), unpacked in memory: a tar.gz read with
// node:zlib and a small tar reader, no new dependency and nothing written to disk. Only text files that are source are kept
// (no dependencies, build output, images, fonts or lockfiles), within GITHUB_LIMITS.
import { gunzipSync } from 'node:zlib';
import { guardedFetch } from '../audit/http.js';
import { ContextError } from './context.js';

export const GITHUB_LIMITS = { archiveBytes: 30 * 1024 * 1024, files: 3000, bytes: 10 * 1024 * 1024 };
const TIMEOUT_MS = 60000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.cache|\.vercel|vendor)(\/|$)/;
export const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)$|\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|rar|7z|exe|dll|so|dylib|map|min\.js)$/i;

/**
 * owner / repo (and a branch or tag from a /tree/<ref> address) from a GitHub address; null when it is not one.
 * @param {unknown} url
 */
export function parseGithubUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const [owner, rawRepo, kind, ...rest] = u.pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo, ref: kind === 'tree' && rest.length ? rest.join('/') : null };
}

/** The NUL-terminated text of a tar header field. */
const field = (/** @type {Buffer} */ b, /** @type {number} */ start, /** @type {number} */ len) => {
  const raw = b.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString('utf8');
};

/**
 * The regular files of a tar archive as { path, data }. Long names come from pax ('x') or GNU ('L') records.
 * @param {Buffer} tar
 */
export function readTar(tar) {
  /** @type {{ path: string, data: Buffer }[]} */
  const files = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      longName = path ? path[1] : null;
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    longName = null;
    if (type === '0' || type === '\0') files.push({ path: name, data: Buffer.from(body) });
  }
  return files;
}

/** Reads a response body, refusing once it passes `max` bytes. */
async function readCapped(/** @type {Response} */ res, /** @type {number} */ max) {
  const chunks = [];
  let total = 0;
  // @ts-ignore a web ReadableStream is async-iterable in Node
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > max) {
      await res.body?.cancel().catch(() => {});
      throw new ContextError(`The repository archive is larger than ${Math.round(max / 1024 / 1024)} MB.`, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a public repository and returns its source text files, paths relative to the repository root.
 * @param {{ url: string, ref?: string }} github
 * @param {{ fetch?: typeof guardedFetch }} [deps]  tests pass a stand-in
 * @returns {Promise<{ files: { path: string, content: string }[], repo: string, ref: string | null, skipped: number }>}
 */
export async function fetchGithubRepo(github, { fetch = guardedFetch } = {}) {
  const parsed = parseGithubUrl(github?.url);
  if (!parsed) throw new ContextError('Give a GitHub repository address like https://github.com/owner/repo.');
  const ref = (typeof github.ref === 'string' && github.ref.trim()) || parsed.ref;
  if (ref && !/^[\w./-]{1,200}$/.test(ref)) throw new ContextError('That branch or tag name is not valid.');
  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball${ref ? `/${ref.split('/').map(encodeURIComponent).join('/')}` : ''}`;
  const hop = await fetch(api, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/vnd.github+json' } });
  if (!hop.res) throw new ContextError(`GitHub could not be reached (${hop.error ?? 'network error'}).`, 502);
  const { res } = hop;
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw new ContextError(`Repository ${parsed.owner}/${parsed.repo}${ref ? ` at ${ref}` : ''} was not found. Only public repositories can be read for now.`, 404);
    if (res.status === 403 || res.status === 429) throw new ContextError('GitHub is limiting requests from this computer; try again in a few minutes.', 429);
    throw new ContextError(`GitHub answered ${res.status}.`, 502);
  }
  const archive = await readCapped(res, GITHUB_LIMITS.archiveBytes);
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  } catch {
    throw new ContextError('The repository archive could not be unpacked (or is over 200 MB unpacked).', 502);
  }
  const files = [];
  let skipped = 0;
  let bytes = 0;
  for (const entry of readTar(tar)) {
    // Every path starts with GitHub's "<owner>-<repo>-<sha>/" folder.
    const path = entry.path.split('/').slice(1).join('/');
    if (!path || path.split('/').includes('..') || SKIP_DIRS.test(path) || SKIP_FILES.test(path) || entry.data.includes(0)) {
      skipped++;
      continue;
    }
    bytes += entry.data.length;
    if (files.length + 1 > GITHUB_LIMITS.files || bytes > GITHUB_LIMITS.bytes) {
      throw new ContextError(`This repository has more source than build mode reads (${GITHUB_LIMITS.files} files, ${GITHUB_LIMITS.bytes / 1024 / 1024} MB of text).`, 413);
    }
    files.push({ path, content: entry.data.toString('utf8') });
  }
  if (!files.length) throw new ContextError('No source files were found in that repository.');
  return { files, repo: `${parsed.owner}/${parsed.repo}`, ref, skipped };
}
