// What the app knows about the builds of a recreate. A recreate always has the plain-HTML build (`html`); a project
// whose stack is an app (React + Vite, Next.js, MERN) also gets that stack's own build from the saved IR, queued right
// after the recreate. `result.outputs[stack]` is { status: 'ready' | 'failed', dir, dist, pages, … } once it exists.
import { stackById } from './constants.js';

// A recreate made for an app stack is still building its output this long after it started (recreate budget + build).
const BUILDING_MS = 25 * 60 * 1000;

/** The outputs of a recreate result; reports from before Phase 6 only have their own plain-HTML build. */
export const outputsOf = (result) => result?.outputs ?? { [result?.stack ?? 'html']: { status: 'ready', dir: 'dist' } };

/** 'ready' | 'failed' | 'building' (queued after the recreate) | 'none' (never built for this recreate). */
export function outputState(result, stack, now = Date.now()) {
  if (!result) return 'none';
  if (stack === 'html') return 'ready';
  const out = outputsOf(result)[stack];
  if (out) return out.status === 'ready' ? 'ready' : 'failed';
  const age = now - new Date(result.createdAt).getTime();
  return result.stack === stack && age < BUILDING_MS ? 'building' : 'none';
}

/** The build the preview shows: the project's stack when it is ready, the plain-HTML build otherwise (as the server picks it). */
export const shownStack = (result, projectStack) => (outputState(result, projectStack) === 'ready' ? projectStack : 'html');

/** One page of a build: where it is served ("/about/") and its file, by its path in the original site. */
export function pageOf(result, stack, outPath) {
  const found = outputsOf(result)[stack]?.pages?.find((p) => p.outPath === outPath);
  const file = found?.file ?? outPath;
  return { file, path: found?.path ?? `/${file.replace(/(^|\/)index\.html$/, '$1')}` };
}

export const stackName = (id) => stackById(id).name;
