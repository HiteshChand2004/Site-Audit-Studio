// Preloaded into every test file process (node --import, see test/run-tests.js) so tests never touch
// the real data/app.db: each file gets its own data dir, with its own database, inside SAS_TEST_ROOT.
// run-tests.js deletes the root after all test processes have exited (on Windows an open SQLite file
// cannot be deleted, so the processes that use it cannot clean up after themselves).
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.env.SAS_TEST_ROOT;
if (!root) {
  console.warn('SAS_TEST_ROOT is not set; run tests with "npm test -w server" so the temp data is deleted afterwards.');
}
process.env.SAS_DATA_DIR = mkdtempSync(path.join(root || os.tmpdir(), root ? 'file-' : 'sas-test-'));
// Jobs in tests never ask the machine to stay awake (keep-awake.test.js turns it on where it tests it).
process.env.SAS_KEEP_AWAKE ??= '0';
// Jobs in tests never poll DNS for outages (interruptions.test.js passes its own checks).
process.env.SAS_NETWORK_WATCH ??= '0';
