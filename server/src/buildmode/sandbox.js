// @ts-check
// The sandbox a build of the agent's code runs in. A Next.js build runs the site's own components in Node to write every page
// (static export), so code a model wrote runs on this server: it must not read the server's secrets or the owners' data, write
// outside its project, reach the network, or start programs. macOS has an OS sandbox every process of the build inherits
// (sandbox-exec, Seatbelt); Node's own permission model cannot hold a Next.js build, which needs child processes, and a child
// process escapes it. Where no sandbox exists, a build that runs the site's code is refused (stacks.js).
//
// The rules, last match wins: the network is closed (local sockets stay, for the build's own workers); nothing is written but
// the project and the build's temporary folder; no file under the users' folders, the app's repository or its data folder is
// read except the project, its toolchain and the repository's installed packages (directories can still be listed, so module
// resolution walking up the tree works); only Node and the toolchain's own binaries (esbuild) can be started. A run of our own
// fixed code (the MERN server's tests) may also use this computer's own network (`loopback`), never anything beyond it.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SERVER_DIR } from '../config/paths.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const REPO_DIR = path.resolve(SERVER_DIR, '..');

const PROFILE = `(version 1)
(allow default)
(deny network*)
(allow network* (local unix))
(deny file-write*)
(allow file-write* (subpath (param "PROJECT")) (subpath (param "TMP")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "REPO")) (subpath (param "DATA")))
(allow file-read-data (subpath (param "PROJECT")) (subpath (param "TMP")) (subpath (param "TOOLCHAIN")) (subpath (param "MODULES")))
(deny process-exec)
(allow process-exec (literal (param "NODE")) (subpath (param "TOOLCHAIN")))
`;

/** Whether builds can be sandboxed on this computer. */
export const sandboxAvailable = () => process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

const real = (/** @type {string} */ p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const LOOPBACK = `(allow network-bind network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
`;

/**
 * The sandbox for one build, as runToolchain takes it, or null where there is none.
 * @param {{ project: string, tmp: string, toolchain: string, loopback?: boolean }} o  absolute folders: the project (written), its
 *   temporary folder, and the toolchain folder (read: its node_modules is linked into the project); loopback: never for code a
 *   model wrote
 */
export function buildSandbox({ project, tmp, toolchain, loopback = false }) {
  if (!sandboxAvailable()) return null;
  const params = {
    PROJECT: real(project),
    TMP: real(tmp),
    TOOLCHAIN: real(toolchain),
    MODULES: real(path.join(REPO_DIR, 'node_modules')),
    REPO: real(REPO_DIR),
    DATA: real(DATA_DIR),
    NODE: real(process.execPath),
  };
  return {
    command: SANDBOX_EXEC,
    args: ['-p', loopback ? PROFILE + LOOPBACK : PROFILE, ...Object.entries(params).flatMap(([k, v]) => ['-D', `${k}=${v}`])],
    env: { TMPDIR: params.TMP },
  };
}
