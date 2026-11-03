// @ts-check
// The one folder a build's agent may touch, and the file tool it works through. The agent gets the Anthropic-defined text
// editor (view / create / str_replace / insert): every path it sends is untrusted model output, so it is resolved inside the
// site folder and refused when it would leave it (.., absolute paths, backslashes, NUL, encoded traversal), and only text
// files of the kinds a website needs, within WORKSPACE_LIMITS, can be written. Nothing here runs a command or reaches the
// network.
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_LIMITS = { files: 150, fileBytes: 300 * 1024, totalBytes: 4 * 1024 * 1024, viewChars: 60000 };
const TEXT_FILE = /\.(html?|css|m?js|json|svg|txt|xml|webmanifest|md)$/i;

export class ToolError extends Error {}

/** All files under a folder, as paths relative to it with forward slashes, sorted. */
export async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)).replaceAll('\\', '/'))
    .sort();
}

/**
 * A path from the agent as a file inside the site folder, or a ToolError. A leading slash means the site's root, as the
 * agent reads its own project ("/index.html" = "index.html").
 * @param {string} root  the site folder (absolute)
 * @param {unknown} input
 */
export async function resolveInside(root, input) {
  if (typeof input !== 'string') throw new ToolError('path must be text.');
  let rel = input.trim();
  if (/%2e|%2f|%5c/i.test(rel) || rel.includes('\0') || rel.includes('\\')) throw new ToolError(`Not a valid path: ${input}`);
  rel = rel.replace(/^\/+/, '').replace(/^site\//, '');
  const norm = path.posix.normalize(rel || '.');
  if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm) || /^[a-z]:/i.test(norm)) throw new ToolError(`The path leaves the project folder: ${input}`);
  const target = path.resolve(root, norm);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ToolError(`The path leaves the project folder: ${input}`);
  // The folder that would hold it must really be inside the root (no link leading out).
  const realRoot = await realpath(root);
  let probe = target;
  while (probe !== root && !(await stat(probe).then(() => true, () => false))) probe = path.dirname(probe);
  const realProbe = await realpath(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new ToolError(`The path leaves the project folder: ${input}`);
  return { abs: target, rel: relative.replaceAll('\\', '/') || '.' };
}

const numbered = (/** @type {string} */ text, start = 1) => text.split('\n').map((line, i) => `${String(i + start).padStart(6)}\t${line}`).join('\n');

/**
 * Runs one text-editor command inside the site folder; returns the text Claude reads back. Errors are ToolErrors with a
 * message Claude can act on.
 * @param {string} root
 * @param {any} input  { command, path, file_text?, old_str?, new_str?, insert_line?, insert_text?, view_range? }
 * @returns {Promise<{ text: string, changed?: { path: string, action: 'created' | 'edited' } }>}
 */
export async function runEditor(root, input) {
  const command = input?.command;
  if (!['view', 'create', 'str_replace', 'insert'].includes(command)) throw new ToolError(`Unknown command: ${command}. Use view, create, str_replace or insert.`);
  const { abs, rel } = await resolveInside(root, input.path ?? '.');
  const info = await stat(abs).catch(() => null);

  if (command === 'view') {
    if (!info || info.isDirectory()) {
      const files = (await listFiles(root)).filter((f) => rel === '.' || f === rel || f.startsWith(`${rel}/`));
      if (!info && rel !== '.') throw new ToolError(`No such file or folder: ${rel}`);
      return { text: files.length ? `Files in ${rel === '.' ? 'the project' : rel}:\n${files.join('\n')}` : 'The project is empty.' };
    }
    const text = await readFile(abs, 'utf8');
    const lines = text.split('\n');
    const [from, to] = Array.isArray(input.view_range) ? input.view_range : [1, -1];
    const start = Math.max(1, Number(from) || 1);
    const end = Number(to) === -1 || !Number(to) ? lines.length : Math.min(lines.length, Number(to));
    const shown = numbered(lines.slice(start - 1, end).join('\n'), start);
    return { text: shown.length > WORKSPACE_LIMITS.viewChars ? `${shown.slice(0, WORKSPACE_LIMITS.viewChars)}\n… (cut: view a smaller range)` : shown };
  }

  if (rel === '.' || info?.isDirectory()) throw new ToolError(`${rel} is a folder, not a file.`);

  if (command === 'create') {
    if (typeof input.file_text !== 'string') throw new ToolError('create needs file_text.');
    if (!TEXT_FILE.test(rel)) throw new ToolError(`Only text files a website needs can be written (.html, .css, .js, .svg, .json, .txt, .xml, .webmanifest, .md): ${rel}`);
    await checkRoom(root, rel, Buffer.byteLength(input.file_text), Boolean(info));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.file_text);
    return { text: `${info ? 'Overwrote' : 'Created'} ${rel}.`, changed: { path: rel, action: info ? 'edited' : 'created' } };
  }

  if (!info) throw new ToolError(`No such file: ${rel}. Create it first.`);
  const current = await readFile(abs, 'utf8');
  let next;
  if (command === 'str_replace') {
    if (typeof input.old_str !== 'string' || !input.old_str) throw new ToolError('str_replace needs old_str.');
    const count = current.split(input.old_str).length - 1;
    if (count === 0) throw new ToolError(`old_str was not found in ${rel}. View the file and copy the text exactly.`);
    if (count > 1) throw new ToolError(`old_str appears ${count} times in ${rel}; include more surrounding text so it is unique.`);
    next = current.replace(input.old_str, () => String(input.new_str ?? ''));
  } else {
    const insertText = input.insert_text ?? input.new_str;
    if (typeof insertText !== 'string') throw new ToolError('insert needs insert_text.');
    const lines = current.split('\n');
    const at = Number(input.insert_line);
    if (!Number.isInteger(at) || at < 0 || at > lines.length) throw new ToolError(`insert_line must be between 0 and ${lines.length}.`);
    lines.splice(at, 0, insertText);
    next = lines.join('\n');
  }
  await checkRoom(root, rel, Buffer.byteLength(next), true);
  await writeFile(abs, next);
  return { text: `Edited ${rel}.`, changed: { path: rel, action: 'edited' } };
}

/** Refuses a write that would pass WORKSPACE_LIMITS. */
async function checkRoom(root, rel, bytes, exists) {
  if (bytes > WORKSPACE_LIMITS.fileBytes) throw new ToolError(`${rel} would be ${Math.round(bytes / 1024)} KB; one file may be at most ${WORKSPACE_LIMITS.fileBytes / 1024} KB. Split it.`);
  const files = await listFiles(root);
  if (!exists && files.length >= WORKSPACE_LIMITS.files) throw new ToolError(`The project already has ${files.length} files, the most allowed.`);
  let total = bytes;
  for (const f of files) if (f !== rel) total += (await stat(path.join(root, f))).size;
  if (total > WORKSPACE_LIMITS.totalBytes) throw new ToolError(`The project would pass ${WORKSPACE_LIMITS.totalBytes / 1024 / 1024} MB of text. Keep files lean.`);
}
