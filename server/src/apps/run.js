// @ts-check
// An app's box (apps/): the person's own Node.js app, built from their repository and run on Remastly's server in docker,
// so the parts of the website only its code can answer (sign-in, its API, the pages after sign-in) keep working once the old
// server is switched off.
//   rapp-<id>                 its own network: it reaches the internet (its database, GitHub), no other box
//   rapp-<id>-files-<when>    a volume with the code and what the build made; a new one for every version
//   rapp-<id>-web             the running app, as the image's own unprivileged user, on 127.0.0.1:<port> only (the sites server
//                             passes it the paths of "Logins and data")
// A new version is installed and built beside the running one, which keeps answering; only then is it swapped in, and when it
// does not answer, the version before is put back.
import { askBox } from '../boxes/box.js';
import { docker, DockerError } from '../boxes/docker.js';

/** The official Node.js image of a version (with the build tools some packages compile with). @param {number} v */
export const nodeImage = (v) => process.env[`SAS_APP_NODE_${v}_IMAGE`] || `node:${v}-bookworm`;
const LABEL = 'remastly.app';
// No process gains privileges after it starts; --init reaps what the app leaves behind and passes on stop signals.
const SAFE = ['--security-opt', 'no-new-privileges', '--init'];
const BUILD_LIMITS = [...SAFE, '--cpus', '2', '--memory', '3g', '--pids-limit', '2048'];
const RUN_LIMITS = [...SAFE, '--cpus', '1', '--memory', '1g', '--pids-limit', '512'];
// What every step sees besides the person's settings: nothing waits for a person at a prompt, no usage report is sent.
const QUIET = { CI: '1', NEXT_TELEMETRY_DISABLED: '1' };

/** The docker names of a website's app. @param {string} projectId */
export function appNames(projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error(`Not a website id: ${projectId}`);
  const n = `rapp-${projectId.replaceAll('-', '').slice(0, 16).toLowerCase()}`;
  return { network: n, web: `${n}-web`, old: `${n}-web-old`, job: `${n}-job`, copy: `${n}-copy` };
}

/** Removes the app and every version's files; nothing there is an error. @param {string} projectId */
export async function removeApp(projectId) {
  const n = appNames(projectId);
  await docker(['rm', '-f', n.web, n.old, n.job, n.copy]).catch(() => {});
  const volumes = await docker(['volume', 'ls', '-q', '--filter', `label=${LABEL}=${projectId}`]).catch(() => '');
  for (const v of volumes.split('\n').filter(Boolean)) await docker(['volume', 'rm', '-f', v]).catch(() => {});
  await docker(['network', 'rm', n.network]).catch(() => {});
}

/** Whether the app is running. @param {string} projectId */
export async function appRunning(projectId) {
  const out = await docker(['inspect', '-f', '{{.State.Running}}', appNames(projectId).web], { timeoutMs: 15_000 }).catch(() => '');
  return out.trim() === 'true';
}

/** The volume a container keeps its files in. @param {string} name */
const volumeOf = async (name) => (await docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', name]).catch(() => '')).trim() || null;

/** `-e NAME` for each setting: the values travel in docker's environment, never as arguments. @param {Record<string, string>} env */
const envArgs = (env) => Object.keys(env).flatMap((k) => ['-e', k]);

/**
 * Waits until the app answers its home page as it will through the sites server (any answer but a server error), up to 2
 * minutes; else says why, with the app's last lines.
 * @param {number} port @param {string} domain @param {string} name
 */
async function waitAnswers(port, domain, name) {
  const until = Date.now() + 120_000;
  let last = 'it did not answer';
  for (;;) {
    if (!(await docker(['inspect', '-f', '{{.State.Running}}', name]).then((o) => o.trim() === 'true', () => false))) {
      const e = new DockerError('The app stopped right after it started.');
      e.tail = await docker(['logs', '--tail', '40', name]).catch((x) => x.tail || '');
      throw e;
    }
    try {
      const res = await askBox(port, domain, '/');
      await res.body.dump();
      if (res.statusCode < 500) return;
      last = `it answered ${res.statusCode}`;
    } catch (err) {
      last = /** @type {Error} */ (err).message;
    }
    if (Date.now() > until) {
      const e = new DockerError(`The app started, but its home page does not work (${last}).`);
      e.tail = await docker(['logs', '--tail', '40', name]).catch((x) => x.tail || '');
      throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Installs, builds and starts one version of the app, and swaps it in for the one running (if any).
 * @param {{
 *   projectId: string, port: number, domain: string, srcDir: string, env: Record<string, string>,
 *   app: Awaited<ReturnType<typeof import('./detect.js').findApp>>,
 *   onStep: (step: 'install' | 'build' | 'start' | 'check') => void,
 * }} o
 */
export async function runApp({ projectId, port, domain, srcDir, app, env, onStep }) {
  const n = appNames(projectId);
  const image = nodeImage(app.node);
  const labels = ['--label', `${LABEL}=${projectId}`];
  const all = { ...env, ...QUIET };
  await docker(['network', 'create', ...labels, n.network]).catch((e) => { if (!/already exists/.test(e.message)) throw e; });
  // Helpers a run that stopped half way left behind.
  await docker(['rm', '-f', n.job, n.copy]).catch(() => {});
  const volume = `${n.network}-files-${Date.now().toString(36)}`;
  await docker(['volume', 'create', ...labels, volume]);
  try {
    onStep('install');
    await docker(['create', '--name', n.copy, '-v', `${volume}:/app`, image, 'true']);
    await docker(['cp', `${srcDir}/.`, `${n.copy}:/app`], { timeoutMs: 10 * 60_000 });
    await docker(['rm', '-f', n.copy]);
    // The files belong to the image's own user ("node"); the app never runs as root.
    await docker(['run', '--rm', '--name', n.job, '-u', '0', '-v', `${volume}:/app`, image, 'chown', '-R', 'node:node', '/app'], { timeoutMs: 10 * 60_000 });
    const job = (command) => docker([
      'run', '--rm', '--name', n.job, '--network', n.network, ...labels, ...BUILD_LIMITS, '-u', 'node', '-w', '/app',
      '-v', `${volume}:/app`, ...envArgs(all), image, 'sh', '-c', command,
    ], { env: all, timeoutMs: 30 * 60_000 });
    await job(app.install).catch((e) => { e.message = `Installing the app's packages failed (${app.install}).`; throw e; });
    if (app.build) {
      onStep('build');
      await job(app.build).catch((e) => { e.message = `Building the app failed (${app.build}).`; throw e; });
    }

    onStep('start');
    const before = await docker(['inspect', '-f', '{{.State.Running}}', n.web]).then(() => true, () => false);
    const beforeVolume = before ? await volumeOf(n.web) : null;
    if (before) {
      await docker(['rm', '-f', n.old]).catch(() => {});
      await docker(['stop', '-t', '10', n.web]);
      await docker(['rename', n.web, n.old]);
    }
    try {
      const run = { ...all, PORT: String(app.port), HOSTNAME: '0.0.0.0', NODE_ENV: 'production' };
      await docker([
        'run', '-d', '--name', n.web, '--network', n.network, ...labels, '--restart', 'unless-stopped', ...RUN_LIMITS,
        '-u', 'node', '-w', '/app', '-v', `${volume}:/app`, '-p', `127.0.0.1:${port}:${app.port}`, ...envArgs(run), image, 'sh', '-c', app.start,
      ], { env: run });
      onStep('check');
      await waitAnswers(port, domain, n.web);
    } catch (e) {
      // The version before answers again, as it did.
      await docker(['rm', '-f', n.web]).catch(() => {});
      if (before) {
        await docker(['rename', n.old, n.web]).catch(() => {});
        await docker(['start', n.web]).catch(() => {});
      }
      throw e;
    }
    if (before) {
      await docker(['rm', '-f', n.old]).catch(() => {});
      if (beforeVolume && beforeVolume !== volume) await docker(['volume', 'rm', '-f', beforeVolume]).catch(() => {});
    }
  } catch (e) {
    await docker(['rm', '-f', n.job, n.copy]).catch(() => {});
    // This version's files go unless the running app is this version.
    if ((await volumeOf(n.web)) !== volume) await docker(['volume', 'rm', '-f', volume]).catch(() => {});
    throw e;
  }
}
