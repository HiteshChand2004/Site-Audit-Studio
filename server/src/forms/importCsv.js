// @ts-check
// Old form entries brought into Remastly from a CSV (Form entries → "Import old entries"): what Webflow, Framer, a form
// service or the old site's own database exports, so the entries from before the move are kept with the new ones and the
// old place can be shut down.
//
// The first row names the columns. A column whose name says it is the date (Date, Submitted at, created_at…) becomes the
// entry's time when its values read as dates; one that says it is the page (Page, URL…) becomes its page. Every other column is
// a field, in the file's order. Nothing is guessed beyond that: a value that does not read as a date stays a field, so no data
// is lost.

export const IMPORT_LIMITS = { bytes: 5 * 1024 * 1024, rows: 20_000 };

const DATE_NAMES = /^(date|time|timestamp|created|created[ _]?at|created[ _]?on|submitted|submitted[ _]?at|submission[ _]?date|received|received[ _]?at|sent[ _]?at|date[ _]?submitted)$/i;
const PAGE_NAMES = /^(page|page[ _]?url|url|page[ _]?path|source[ _]?url)$/i;

/**
 * Rows of a CSV (RFC 4180: quoted cells may hold the separator, quotes as "" and line breaks). The separator is a comma, or
 * a semicolon when the first line has semicolons and no comma (a spreadsheet saved in a language that writes 1,5 for 1.5).
 * @param {string} text @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // Blank lines (a trailing line break, an empty line between rows) are not rows.
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * Entries from a CSV's rows, ready to keep. `now` = the time given to an entry whose date could not be read.
 * @param {string[][]} rows @param {{ now?: string }} [o]
 * @returns {{ entries: { at: string, page: string | null, fields: [string, string][] }[], dateColumn: string | null, pageColumn: string | null } | { error: string }}
 */
export function entriesFromRows(rows, { now = new Date().toISOString() } = {}) {
  if (rows.length < 2) return { error: 'The file has no entries: it needs a first row with the column names and at least one row below it.' };
  if (rows.length - 1 > IMPORT_LIMITS.rows) return { error: `The file has ${rows.length - 1} rows; at most ${IMPORT_LIMITS.rows} can be imported at once. Split it into smaller files.` };
  const header = rows[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const body = rows.slice(1);
  // The date column only counts when most of its filled values read as dates (a "Date" field a visitor typed may not).
  const dateAt = header.findIndex((h, i) => DATE_NAMES.test(h) && mostlyDates(body.map((r) => r[i] ?? '')));
  const pageAt = header.findIndex((h) => PAGE_NAMES.test(h));
  const entries = body.map((r) => {
    const when = dateAt >= 0 ? toIso(r[dateAt]) : null;
    /** @type {[string, string][]} */
    const fields = [];
    header.forEach((h, i) => {
      const v = (r[i] ?? '').trim();
      // The date and page columns become the entry's time and page; a date that did not read stays a field.
      if (i === pageAt || (i === dateAt && when)) return;
      if (v) fields.push([h, v]);
    });
    return { at: when ?? now, page: pageAt >= 0 ? (r[pageAt] ?? '').trim() || null : null, fields };
  }).filter((e) => e.fields.length);
  if (!entries.length) return { error: 'Every row of the file is empty.' };
  return { entries, dateColumn: dateAt >= 0 ? header[dateAt] : null, pageColumn: pageAt >= 0 ? header[pageAt] : null };
}

/**
 * The time as ISO, or null when it is not a date that reads one way only: 2026-11-15 (with or without a time) or one with the
 * month in letters (15 Nov 2026, Nov 15, 2026 10:30). 03/04/2026 is 3 April in India and March 4 in the US, so a date written
 * with slashes is not read (it stays a field, as written).
 * @param {string} v @returns {string | null}
 */
function toIso(v) {
  const s = String(v ?? '').trim();
  const unambiguous = /^\d{4}-\d{2}-\d{2}/.test(s) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(s);
  if (!unambiguous) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** @param {string[]} values */
function mostlyDates(values) {
  const filled = values.filter((v) => v.trim());
  return filled.length > 0 && filled.filter((v) => toIso(v)).length >= filled.length * 0.8;
}
