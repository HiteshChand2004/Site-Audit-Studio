// The test suites of the permanence rules (CLONER_SPEC "Regression suite", agreed with the user 2026-10-15):
//   node scripts/test-suite.mjs precommit   every source file parses + the unit tests, under two minutes (the git hook)
//   node scripts/test-suite.mjs fixtures    every fixture in all four stacks (before a step's final commit)
// A fixture that fails blocks the commit. Files run two at a time: the machine this was written on has little memory.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Unit tests with no browser pipeline run: seconds. */
export const FAST = [
  'recreate-animation-rules', 'recreate-framer-appear', 'detect-libraries', 'behavior-scripts', 'detection', 'analyzers',
  'recreate-fixers', 'reaudit-compare', 'recreate-corpus', 'http-headers', 'recreate-video-clock', 'recreate-asis-versions', 'reaudit-loops-pairing',
];
/** Fixtures: a page through the real pipeline, compared with the original in a browser (their app-stack parts build the
 * three app stacks with the real toolchains unless SAS_SKIP_APP_STACKS=1). */
export const FIXTURES = [
  'recreate-animation-lab', 'recreate-gsap', 'recreate-framer-appear-e2e', 'recreate-lift', 'recreate-hittest', 'recreate-visibility', 'recreate-video-tier',
  'recreate-framer-patterns', 'recreate-clicks', 'reaudit-clicks', 'recreate-hover-toggle', 'recreate-motion-calm',
];

const suite = process.argv[2];
if (!['precommit', 'fixtures'].includes(suite)) {
  console.error('Usage: node scripts/test-suite.mjs <precommit|fixtures>');
  process.exit(2);
}
// The hook stays under two minutes (user, 2026-10-15): every source file must parse, then the unit tests. The fixtures in
// all four stacks run with `npm run test:fixtures` at the end of each step and before any merge.
if (suite === 'precommit') {
  const { readdir } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const sources = (await readdir(path.join(SERVER, 'src'), { recursive: true }))
    .filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join('src', f));
  const bad = sources.filter((f) => spawnSync(process.execPath, ['--check', f], { cwd: SERVER }).status !== 0);
  if (bad.length) {
    console.error(`Syntax errors in:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`${sources.length} source files parse.`);
}
const files = (suite === 'precommit' ? FAST : FIXTURES).map((f) => `test/${f}.test.js`);
const env = {
  ...process.env,
  SAS_KEEP_AWAKE: '0',
  SAS_NETWORK_WATCH: '0',
  NODE_TEST_CONCURRENCY: process.env.NODE_TEST_CONCURRENCY ?? '2',
  ...(suite === 'precommit' && { SAS_SKIP_APP_STACKS: '1' }),
};
const child = spawn(process.execPath, ['test/run-tests.js', `--test-concurrency=${env.NODE_TEST_CONCURRENCY}`, ...files], { cwd: SERVER, stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 1));
