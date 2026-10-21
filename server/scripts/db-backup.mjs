// @ts-check
// A dated backup of the database (db/backup.js): read-only on the source, checked before it is reported.
//
// Usage:
//   npm run db:backup -w server                      the configured database (SAS_DATA_DIR) → <data>/backups/app-<time>.db
//   npm run db:backup -w server -- --db <file> --dir <folder>
import { backupDatabase } from '../src/db/backup.js';
import { BACKUPS_DIR, DB_FILE } from '../src/config/paths.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const result = await backupDatabase({ dbFile: arg('db', DB_FILE), dir: arg('dir', BACKUPS_DIR) });
console.log(`Backup written: ${result.file} (${Math.round(result.bytes / 1024)} KB)`);
for (const [table, rows] of Object.entries(result.tables)) console.log(`  ${table}: ${rows} rows`);
