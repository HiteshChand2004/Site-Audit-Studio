// The test suites of the permanence rules (CLONER_SPEC "Regression suite", agreed with the user 2026-10-15):
//   node scripts/test-suite.mjs precommit   fast unit tests + the fixtures in the plain-HTML stack (the git hook)
//   node scripts/test-suite.mjs fixtures    every fixture in all four stacks (before a step's final commit)
// A fixture that fails blocks the commit. Files run two at a time: the machine this was written on has little memory.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Unit tests with no browser pipeline run: seconds. */
export const FAST = [
  'recreate-animation-rules', 'recreate-framer-appear', 'detect-libraries', 'behavior-scripts', 'detection', 'analyzers',
  'recreate-fixers', 'reaudit-compare', 'recreate-corpus',
];
/** Fixtures: a page through the real pipeline, compared with the original in a browser (their app-stack parts build the
 * three app stacks with the real toolchains unless SAS_SKIP_APP_STACKS=1). */
export const FIXTURES = [
  'recreate-animation-lab', 'recreate-gsap', 'recreate-framer-appear-e2e', 'recreate-lift', 'recreate-hittest',
];

const suite = process.argv[2];
if (!['precommit', 'fixtures'].includes(suite)) {
  console.error('Usage: node scripts/test-suite.mjs <precommit|fixtures>');
  process.exit(2);
}
const files = (suite === 'precommit' ? [...FAST, ...FIXTURES] : [...FIXTURES]).map((f) => `test/${f}.test.js`);
const env = {
  ...process.env,
  SAS_KEEP_AWAKE: '0',
  SAS_NETWORK_WATCH: '0',
  NODE_TEST_CONCURRENCY: process.env.NODE_TEST_CONCURRENCY ?? '2',
  ...(suite === 'precommit' && { SAS_SKIP_APP_STACKS: '1' }),
};
const child = spawn(process.execPath, ['test/run-tests.js', `--test-concurrency=${env.NODE_TEST_CONCURRENCY}`, ...files], { cwd: SERVER, stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 1));
