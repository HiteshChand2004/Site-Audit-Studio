# Tool bug: as-is copies ship a DEPLOY.md that names scripts the package.json does not have

For the other Claude Code session (the one that owns `Website-Audit-exact`). Found by reading the code only: nothing was run, and nothing inside `Website-Audit-exact` was edited. All paths below are under `server/src/`.

## Where each file is generated

- **`DEPLOY.md`** (every download, every stack): `copy/deploy.js` → `deployMd()`. The run instructions come from the `STACK_FACTS` table in that file (`run:` arrays, lines 6, 12, 17, 22). It is called from `recreate/export/notes.js:17` (`notesEntries`), which `recreate/export/zip.js` calls for both zip kinds (lines 145 and 197). `deployMd` receives only `stack`, so it cannot tell an as-is copy from a rebuilt one.
- **`package.json` of an as-is copy:** `recreate/behavior/preserve/pack.js` → `packLifted()`: react-vite at line 141, nextjs at line 172, mern at line 233.
- **`package.json` of a rebuilt copy:** react-vite `recreate/emit/react/scaffold.js:26`, nextjs `recreate/emit/next/index.js:195`, mern `recreate/emit/mern/index.js:70` (root) and `:62` (server).

## The mismatch per stack

| Stack | `DEPLOY.md` says (`STACK_FACTS`) | As-is `package.json` scripts | Rebuilt `package.json` scripts | Result |
| --- | --- | --- | --- | --- |
| React + Vite | `npm install`, then `npm run dev`; real files via `npm run build` → `dist/` | `build`, `preview` only | `dev`, `build`, `preview` | **As-is: `npm run dev` fails** (missing script). `build` → `dist/` is right. |
| Next.js | `npm install`, then `npm run dev`; real files via `npm run build` → `out/` | `build`, `start` only | `dev`, `build`, `serve` | **As-is: `npm run dev` fails.** Also no `out/` is produced: the as-is config has no `output: 'export'`, the copy lives in `public/` and is served by `next start`. |
| MERN | `npm run install:all`, then `npm start` | `start` only | root has `install:all`, `build`, `start`, `dev:client`, `dev:server`, `test` | **As-is: `npm run install:all` fails.** Plain `npm install` is what it needs. `npm start` is right. |
| Plain HTML | `npx serve .` | no `package.json` | no `package.json` | fine (for a rebuilt copy, run it from inside `site/`) |

The generated `README.md` of the as-is React copy has the same problem: `pack.js` (react-vite branch, `run:` text) says "`npm run dev` serves the same folder for editing", but no `dev` script exists. The as-is README for the other stacks gives the correct commands (`npm run preview`; `npm run build` + `npm run start`; `npm start`), so the README and `DEPLOY.md` contradict each other inside the same zip.

## Smallest generic fix

Either of these works; the first is the smaller:

1. **Add the missing script names to the as-is `package.json` files in `pack.js`** (three one-line additions):
   - react-vite: `dev: 'vite'`. The generated `vite.config.js` has `publicDir: 'public'`, so `vite` serves the copy.
   - nextjs: `dev: 'next dev'`.
   - mern: `'install:all': 'npm install'`.
   Then fix the one remaining wrong sentence: `STACK_FACTS.nextjs.run` says the built files are in `out/`, which is true only for a rebuilt copy.
2. **Make `deployMd` mode-aware:** pass `mode` (`report.outputs?.[stack]?.mode`, i.e. `'as-is'` or not) from `notes.js` and give `STACK_FACTS` an as-is variant of `run:` (react: `npm run preview`; next: `npm run build`, `npm run start`; mern: `npm install`, `npm start`). This changes the docs instead of the scripts, and it leaves the README consistent with `DEPLOY.md`.

Caveat: I have not run either fix. Whether `next dev` serves the as-is copy's `public/` rewrites correctly in development (fix 1, Next.js) should be tested before relying on it; fix 2 avoids that question.

A cheap guard against this class of bug: a test that reads every `npm run <x>` named in `STACK_FACTS` and each generated README and asserts `<x>` exists in that stack's generated `package.json` scripts, for both modes.
