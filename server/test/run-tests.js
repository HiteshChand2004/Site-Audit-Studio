// `npm test` entry point. Creates one OS temp folder for the whole run, runs `node --test` with
// SAS_TEST_ROOT pointing at it (test/setup-data-dir.js gives each test file its own data dir inside it),
// and deletes the folder once every test process has exited, so no SQLite file is still open.
// Extra arguments replace the default file glob, e.g. `npm test -w server -- test/crawl.test.js`; they run in one process
// as before.
// The default run splits the files in two: the test files that launch a browser (detected from their source) run ONE
// AT A TIME, because several Chromium-heavy files at once starve each other on a laptop-sized machine and fail on
// timing; every other file runs in parallel, as before. Set SAS_TEST_BROWSER_CONCURRENCY=N to change the browser group's
// concurrency (default 1). Nothing else changes: no timeouts, no expectations.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'sas-test-'));
const args = process.argv.slice(2);

/** Every *.test.js under test/, relative to the server folder. */
function allTestFiles(dir = path.join(serverDir, 'test'), prefix = 'test') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return allTestFiles(path.join(dir, entry.name), `${prefix}/${entry.name}`);
    return entry.name.endsWith('.test.js') ? [`${prefix}/${entry.name}`] : [];
  });
}

/** A module that uses a browser: its source names Playwright or Chromium, or it imports one that does (followed through src/). */
const usesBrowser = (() => {
  const memo = new Map();
  const visit = (/** @type {string} */ file, depth) => {
    if (memo.has(file)) return memo.get(file);
    memo.set(file, false);
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    let yes = /from\s+['"]playwright['"]|require\(['"]playwright['"]\)|chromium\.launch|from\s+['"]playwright-core['"]/.test(text);
    if (!yes && depth < 8) {
      for (const m of text.matchAll(/(?:import|export)[^'"`]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        const target = path.resolve(path.dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`);
        if (visit(target, depth + 1)) {
          yes = true;
          break;
        }
      }
    }
    memo.set(file, yes);
    return yes;
  };
  return (/** @type {string} */ file) => visit(path.join(serverDir, file), 0);
})();
const launchesBrowser = usesBrowser;

/** Runs `node --test` on these files with the given extra options; resolves with the exit code. */
function runGroup(files, options) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--import', './test/setup-data-dir.js',
        '--test',
        ...options,
        ...files,
      ],
      { cwd: serverDir, stdio: 'inherit', env: { ...process.env, SAS_TEST_ROOT: root } },
    );
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function main() {
  if (args.length) return runGroup(args, []);
  const files = allTestFiles();
  const browser = files.filter(launchesBrowser);
  const others = files.filter((f) => !browser.includes(f));
  const concurrency = String(Math.max(1, Number(process.env.SAS_TEST_BROWSER_CONCURRENCY) || 1));
  console.log(`[run-tests] ${browser.length} browser test files one at a time (concurrency ${concurrency}), ${others.length} in parallel`);
  const first = browser.length ? await runGroup(browser, [`--test-concurrency=${concurrency}`]) : 0;
  const second = others.length ? await runGroup(others, []) : 0;
  return first || second;
}

const code = await main();
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (err) {
  console.warn(`Could not delete the test data folder ${root}: ${err.message}`);
}
process.exit(code);
