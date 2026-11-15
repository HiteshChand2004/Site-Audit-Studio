// @ts-check
// Form entries saved by Remastly (Go live, "Form entries"): a live copy's forms that went to the original's own server send
// to Remastly instead (the copy's form guard posts the form to FORM_ENDPOINT in sas-forms.json, which a deploy sets to this
// website's address here), so the old server can be shut down without losing what visitors send.
//
// Kept per website beside its copies, in <projectDir>/forms/: settings.json (the secret part of its address, whether to email)
// and entries.jsonl (one entry per line, newest last). Cleanup never touches that folder, and no database change is needed.
// What is kept of an entry: when, the page it was sent from, and the form's fields in their order. Uploaded files are not
// kept (their names and sizes are), and nothing about the visitor (no IP address, no browser).
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../config/paths.js';

export const FORM_LIMITS = {
  /** The most a form post may be (a form with a file is refused above this: its file is not kept anyway). */
  bodyBytes: 2 * 1024 * 1024,
  fields: 100,
  valueChars: 10_000,
  /** The most entries one website keeps (by file size); past it a post is refused until entries are removed. */
  fileBytes: 20 * 1024 * 1024,
};

const dirOf = (projectId) => path.join(projectDir(projectId), 'forms');
const settingsFile = (projectId) => path.join(dirOf(projectId), 'settings.json');
const entriesFile = (projectId) => path.join(dirOf(projectId), 'entries.jsonl');

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** @param {string} projectId @returns {Promise<{ secret: string, enabled: boolean, email: boolean } | null>} */
export async function readFormSettings(projectId) {
  const s = await readFile(settingsFile(projectId), 'utf8').then(JSON.parse, () => null);
  return s && typeof s.secret === 'string' ? { secret: s.secret, enabled: s.enabled !== false, email: s.email !== false } : null;
}

/**
 * Turns saving on or off, and email on or off. The address's secret is made once and kept, so a site already live keeps
 * sending to the same address after saving is turned off and on again.
 * @param {string} projectId @param {{ enabled?: boolean, email?: boolean }} change
 */
export async function saveFormSettings(projectId, change) {
  const current = await readFormSettings(projectId);
  const next = {
    secret: current?.secret ?? randomBytes(18).toString('base64url'),
    enabled: typeof change.enabled === 'boolean' ? change.enabled : (current?.enabled ?? true),
    email: typeof change.email === 'boolean' ? change.email : (current?.email ?? true),
  };
  await writeAtomic(settingsFile(projectId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The public key of a website's form address: its id and its secret. @param {string} projectId @param {string} secret */
export const formKeyOf = (projectId, secret) => `${projectId}.${secret}`;

/**
 * The website a form key belongs to, when the key is right and saving is on. A wrong secret is refused the same as a
 * missing website (compared in constant time).
 * @param {string} key @returns {Promise<{ projectId: string, settings: { secret: string, enabled: boolean, email: boolean } } | null>}
 */
export async function projectOfFormKey(key) {
  const m = String(key ?? '').match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{16,64})$/i);
  if (!m) return null;
  const settings = await readFormSettings(m[1]);
  if (!settings?.enabled) return null;
  const a = Buffer.from(settings.secret);
  const b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b) ? { projectId: m[1], settings } : null;
}

/**
 * The fields of a form post, from the body as it came: multipart/form-data, the only kind the copy's form guard sends
 * (`new FormData(form)`). Returns null for any other body, or one that cannot be read.
 * @param {Buffer} body @param {string} contentType
 * @returns {{ fields: [string, string][], files: { field: string, name: string, size: number }[] } | null}
 */
export function parseFormBody(body, contentType) {
  if (!/^multipart\/form-data/i.test(String(contentType ?? ''))) return null;
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType))?.slice(1).find(Boolean)?.trim();
  if (!boundary) return null;
  /** @type {[string, string][]} */
  const fields = [];
  /** @type {{ field: string, name: string, size: number }[]} */
  const files = [];
  // Parts sit between "--boundary" lines; the last one is followed by "--boundary--".
  const delimiter = Buffer.from(`--${boundary}`);
  let at = body.indexOf(delimiter);
  if (at < 0) return null;
  while (true) {
    let start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() === '\r\n') start += 2;
    const next = body.indexOf(delimiter, start);
    if (next < 0) return null;
    // A part is its headers, a blank line, then its content up to the line break before the next delimiter.
    const part = body.subarray(start, Math.max(start, next - 2));
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const disposition = /content-disposition:[^\r\n]*/i.exec(part.subarray(0, split).toString('utf8'))?.[0] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const content = part.subarray(split + 4);
      // A file is named, never kept; an empty file input (no file chosen) is skipped.
      if (name !== undefined && filename !== undefined) {
        if (filename || content.length) files.push({ field: name, name: filename, size: content.length });
      } else if (name !== undefined) {
        fields.push([name, content.toString('utf8')]);
      }
    }
    at = next;
  }
  return { fields, files };
}

/** The fields as kept: at most FORM_LIMITS.fields, names and values cut to a sane length. @param {[string, string][]} fields */
const keptFields = (fields) => fields.slice(0, FORM_LIMITS.fields).map(([k, v]) => [String(k).slice(0, 200), String(v).slice(0, FORM_LIMITS.valueChars)]);

/**
 * Keeps one entry. Refuses (returns { full: true }) when the website already keeps FORM_LIMITS.fileBytes of entries.
 * @param {string} projectId
 * @param {{ page: string | null, fields: [string, string][], files: { field: string, name: string, size: number }[] }} e
 */
export async function addEntry(projectId, { page, fields, files }) {
  const file = entriesFile(projectId);
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  if (size >= FORM_LIMITS.fileBytes) return { full: true };
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    page,
    fields: keptFields(fields),
    ...(files.length && { files: files.slice(0, 20) }),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`);
  return { entry };
}

/**
 * Every kept entry, newest first by when it was sent (imported old entries are added after newer ones, so the file's order is
 * not the time order). A line that cannot be read (a crash mid-write) is skipped.
 * @param {string} projectId
 */
export async function listEntries(projectId) {
  const text = await readFile(entriesFile(projectId), 'utf8').catch(() => '');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skipped
    }
  }
  // Stable: entries of the same moment keep the file's order (the later one first).
  return out.reverse().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Removes one entry. @param {string} projectId @param {string} id @returns {Promise<boolean>} whether it was there */
export async function removeEntry(projectId, id) {
  const all = await listEntries(projectId);
  const kept = all.filter((e) => e.id !== id);
  if (kept.length === all.length) return false;
  await writeAtomic(entriesFile(projectId), kept.reverse().map((e) => `${JSON.stringify(e)}\n`).join(''));
  return true;
}

/** A CSV of the entries (one column per field name, in the order they first appear), for a spreadsheet. @param {any[]} entries */
export function entriesCsv(entries) {
  const names = [];
  for (const e of [...entries].reverse()) for (const [k] of e.fields ?? []) if (!names.includes(k)) names.push(k);
  // A cell a spreadsheet would run as a formula (=, +, -, @) is prefixed with ' so it shows as text.
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = [['Received', 'Page', ...names, 'Files'].map(cell).join(',')];
  for (const e of entries) {
    const values = names.map((n) => (e.fields ?? []).filter(([k]) => k === n).map(([, v]) => v).join('; '));
    rows.push([e.at, e.page ?? '', ...values, (e.files ?? []).map((f) => f.name).join('; ')].map(cell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}


/** The same entry, whatever its id: when, where and what (an import of the same file twice adds nothing the second time). */
const sameKey = (e) => JSON.stringify([e.at, e.page ?? null, e.fields]);

/**
 * Keeps old entries brought in from a CSV (forms/importCsv.js), marked with one import id so the whole import can be taken
 * back. Entries already kept (the same time, page and fields) are skipped.
 * @param {string} projectId @param {{ at: string, page: string | null, fields: [string, string][] }[]} list
 * @returns {Promise<{ importId: string, added: number, skipped: number } | { full: true }>}
 */
export async function importEntries(projectId, list) {
  const file = entriesFile(projectId);
  const known = new Set((await listEntries(projectId)).map(sameKey));
  const importId = randomUUID();
  const fresh = [];
  for (const e of list) {
    const entry = {
      at: e.at,
      page: e.page,
      fields: keptFields(e.fields),
    };
    const key = sameKey(entry);
    if (known.has(key)) continue;
    known.add(key);
    fresh.push(JSON.stringify({ id: randomUUID(), ...entry, importId }));
  }
  const text = fresh.map((l) => `${l}\n`).join('');
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  if (size + Buffer.byteLength(text) > FORM_LIMITS.fileBytes) return { full: true };
  if (fresh.length) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, text);
  }
  return { importId, added: fresh.length, skipped: list.length - fresh.length };
}

/** Takes back one import (every entry it added). @param {string} projectId @param {string} importId @returns {Promise<number>} entries removed */
export async function removeImport(projectId, importId) {
  const all = await listEntries(projectId);
  const kept = all.filter((e) => e.importId !== importId);
  if (kept.length !== all.length) await writeAtomic(entriesFile(projectId), kept.reverse().map((e) => `${JSON.stringify(e)}\n`).join(''));
  return all.length - kept.length;
}
