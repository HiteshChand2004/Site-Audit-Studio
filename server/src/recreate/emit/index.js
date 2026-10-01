// Emitter registry: one entry per output stack. Every emitter works from the saved IR only
// (ir/site.json + the assets of the recreate), never from the original site, and contains no
// site-specific code.
//
// Emitter contract:
//   id, label            the stack id (as stored in projects.stack) and its name
//   status               'ready' (can emit) | 'planned' (listed, not built yet)
//   toolchain            id of the build toolchain in server/toolchains/, or null
//   scripts              true when the output runs JavaScript (its preview needs a script CSP)
//   assetsTarget         folder of the project that holds the assets ("assets", "public/assets", …)
//   emit(ir, opts)       → { files: Map<path, string>, assets: Set<file> }  (pure, synchronous)
//   build?(o)            optional async step after the files are written (install-free build, verify)
//                        → extra fields merged into the stack's report entry; may throw RecreateError
//   `html` is built by the Recreate pipeline itself (dist/); it is the reference every other stack is
//   measured against.
import { emitSite } from './html.js';
import { buildReact } from './react/build.js';
import { emitReact } from './react/index.js';

const registry = new Map();

export function registerEmitter(def) {
  registry.set(def.id, Object.freeze({ toolchain: null, scripts: false, assetsTarget: 'assets', ...def }));
}
/** For tests: removes an emitter again. */
export const unregisterEmitter = (id) => registry.delete(id);

export const getEmitter = (id) => registry.get(id) ?? null;
export const stackIds = () => [...registry.keys()];
export const isReadyStack = (id) => getEmitter(id)?.status === 'ready';

/** Public description of every stack (no functions). */
export const listStacks = () => [...registry.values()].map(({ id, label, status, toolchain, scripts }) => ({ id, label, status, toolchain, scripts }));

registerEmitter({ id: 'html', label: 'Plain HTML / CSS / JS', status: 'ready', emit: emitSite });
registerEmitter({ id: 'react-vite', label: 'React + Vite', status: 'ready', toolchain: 'react-vite', scripts: true, assetsTarget: 'public/assets', emit: emitReact, build: buildReact });
registerEmitter({ id: 'nextjs', label: 'Next.js', status: 'planned', toolchain: 'next', scripts: true, assetsTarget: 'public/assets' });
registerEmitter({ id: 'mern', label: 'MERN', status: 'planned', toolchain: 'react-vite', scripts: true, assetsTarget: 'client/public/assets' });
