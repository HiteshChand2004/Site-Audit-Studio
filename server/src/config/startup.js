// @ts-check
// Imported first by src/index.js: modules are evaluated in import order, so this runs before anything opens the database. A setting
// the server must not start with (config/index.js startupProblems) stops it here, with the reason, and nothing is touched.
import { startupNotices, startupProblems } from './index.js';

const problems = startupProblems();
if (problems.length) {
  for (const p of problems) console.error(`Not starting: ${p}`);
  process.exit(1);
}
for (const line of startupNotices()) console.warn(line);
