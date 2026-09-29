// `npm test` entry point. Creates one OS temp folder for the whole run, runs `node --test` with
// SAS_TEST_ROOT pointing at it (test/setup-data-dir.js gives each test file its own data dir inside it),
// and deletes the folder once every test process has exited, so no SQLite file is still open.
// Extra arguments replace the default file glob, e.g. `npm test -w server -- test/crawl.test.js`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'sas-test-'));
const files = process.argv.slice(2);

const child = spawn(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--import', './test/setup-data-dir.js',
    '--test',
    ...(files.length ? files : ['test/**/*.test.js']),
  ],
  { cwd: serverDir, stdio: 'inherit', env: { ...process.env, SAS_TEST_ROOT: root } },
);

child.on('close', (code, signal) => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`Could not delete the test data folder ${root}: ${err.message}`);
  }
  process.exit(signal ? 1 : code ?? 1);
});
