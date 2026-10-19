// The server log for unresolved pages ("Copy my site", docs/COPY-MY-SITE.md §1h). One JSON line per open item, in
// <dir>/copy-issues.log, for the admin to review. Writing never fails a copy: a log that cannot be written is reported
// to the console and the copy goes on.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { issueRecord } from './deploy.js';

export const LOG_FILE = 'copy-issues.log';

/**
 * @param {string} dir   the folder the log lives in (the data folder in production, a temp folder in tests)
 * @returns {(entry: object) => Promise<void>}
 */
export function issueLogger(dir) {
  const file = path.join(dir, LOG_FILE);
  return async (entry) => {
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${issueRecord(entry)}\n`);
    } catch (err) {
      console.error(`[copy] could not write ${LOG_FILE}: ${err.message}`);
    }
  };
}
