// Build + verification of a generated MERN project (the emitter's `build` hook).
//   client/  the same build and checks as the React + Vite stack (safety, links, assets, equivalence with the HTML build,
//            hydration); the form wiring (action/method) is the one difference the equivalence ignores
//   server/  the generated server tests, run with the pinned toolchain: validation, the store with a stand-in MongoDB
//            driver, the app (headers, forms, errors, limits) and, against the client's build, every page and every form
//            of forms.json on the page it names
import path from 'node:path';
import { RecreateError } from '../../errors.js';
import { runToolchain } from '../../build/toolchain.js';
import { buildReact } from '../react/build.js';

const TOOLCHAIN = 'mern';

function parseTests(output) {
  const n = (key) => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(output)?.[1] ?? 0);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped') };
}

/**
 * @param {{ dir: string, ir: object, out: { formIr: object, forms: object[], skippedForms: object[] }, assets: string[], report: object,
 *   htmlDist: string, signal?: AbortSignal, progress?: (fraction: number, message?: string) => void }} o
 */
export async function buildMern({ dir, out, assets, report, htmlDist, signal, progress = () => {} }) {
  const client = await buildReact({
    dir: path.join(dir, 'client'),
    ir: out.formIr,
    assets,
    report,
    htmlDist,
    signal,
    toolchain: TOOLCHAIN,
    sigOptions: { ignoreFormActions: true },
    progress: (f, message) => progress(f * 0.85, message),
  });

  progress(0.88, 'Running the server tests');
  let ran;
  try {
    ran = await runToolchain({
      dir: path.join(dir, 'server'),
      toolchain: TOOLCHAIN,
      timeoutMs: 120000,
      signal,
      steps: [{ label: 'The server tests', args: ['--test'], keepOutput: true }],
    });
  } catch (err) {
    throw new RecreateError(`${err.message} The MERN project was not kept.`);
  }
  const tests = parseTests(ran.steps[0].output ?? '');
  if (tests.fail || !tests.pass) throw new RecreateError(`The server tests did not pass (${tests.pass} of ${tests.tests}); the MERN project was not kept.`);
  progress(1, 'MERN project verified');

  const warnings = [...client.warnings];
  if (out.skippedForms.length) {
    warnings.push(`${out.skippedForms.length} ${out.skippedForms.length === 1 ? 'form was' : 'forms were'} left as ${out.skippedForms.length === 1 ? 'it is' : 'they are'} (${[...new Set(out.skippedForms.map((s) => s.reason))].join('; ')}).`);
  }
  warnings.push(out.forms.length
    ? `${out.forms.length} ${out.forms.length === 1 ? 'form stores' : 'forms store'} submissions in MongoDB (set MONGODB_URI); notification e-mails are not included.`
    : 'The site has no form that collects text; the server only serves the site.');
  return {
    ...client,
    dist: 'client/dist',
    server: { tests: { ...tests, ms: ran.steps[0].ms } },
    forms: { stored: out.forms.map((f) => ({ id: f.id, page: f.page, fields: f.fields.length })), skipped: out.skippedForms },
    warnings,
  };
}
