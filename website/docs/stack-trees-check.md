# Stack file trees and run commands: site vs. the tool

Checked against the packaging code in `Website-Audit-exact/server/src` (read-only). No page was edited.
The site shows these in `components/home/StackTabs.tsx` (`STACKS[].tree` and `.run`).

## The tool produces two kinds of download

The tool has two modes, and they produce different zips. The site's trees match neither exactly.

- **As-is copy** ("Copy my site", the most recent mode; the makememo and nyaayai runs use it). The copy keeps the original's own files and names. Code: `recreate/behavior/preserve/pack.js` (react / next / mern), `stage.js` (html), zip via `recreate/export/zip.js → planProjectZip`.
- **Rebuilt copy** (older "exact" and plain runs). The pages are rebuilt as clean code. Code: `recreate/emit/{html,react,next,mern}`, zip via `zip.js → planZip`.

Every zip is `<site>-<stack>/…` (`zipBaseName`) and always has `RECREATE-REPORT.md` and `DEPLOY.md`, plus `KNOWN-ISSUES.md` only when something is open (`export/notes.js`). Never in a zip: `node_modules`, `.next`, `.ssr`, and a top-level `dist/` or `out/` (but an as-is MERN keeps `client/dist/`).

## 1. Plain HTML

| | |
| --- | --- |
| **Site shows** | `index.html`, `about.html`, `assets/` → `css/styles.css`, `js/main.js`, `images/`; `.nojekyll`. Run: `npx serve .` |
| **Tool actually produces (rebuilt copy)** | `README.md`, `DEPLOY.md`, `RECREATE-REPORT.md`, `site/` (the pages at their original paths, e.g. `index.html`, `about/index.html` or `about.html`; `css/site.css`; `js/motion.js` only if the page needs it; `assets/` for images, fonts, media; `sitemap.xml`, `robots.txt`), `unminified/` (readable copies of CSS/JS). Source: `export/zip.js` header, `emit/css.js` (`CSS_FILE = css/site.css`), `emit/motionScript.js` (`js/motion.js`), `emit/html.js`. |
| **Tool actually produces (as-is copy)** | The original's own layout at the folder root: `index.html`, other pages, the original's folders (e.g. `_next/`), icons / `site.webmanifest`, `robots.txt`, `sw.js` (service worker), `sas-forms.json`, `README.md`, `.nojekyll`. Seen on disk: `data/projects/93e23afa…/recreate/1b8faa9e…/stacks/html`. Source: `stage.js`, `complete.js:277` (`.nojekyll`). |
| **Run command** | `DEPLOY.md` (`copy/deploy.js`): "open a terminal in the copy folder and run `npx serve .`", not by double-clicking. The rebuilt-copy `README.md` says `npx serve site` (because the files are in `site/`). So `npx serve .` is right for the as-is copy, and for a rebuilt copy only from inside `site/`. |
| **Action needed** | **Update.** `css/styles.css`, `js/main.js`, `images/` and `about.html` are invented names: the real names are `css/site.css`, `js/motion.js`, `assets/`, and the original's page names. `.nojekyll` is real but only in the as-is copy. Suggest showing the as-is shape (or a neutral one) and `npx serve .`. |

## 2. React + Vite

| | |
| --- | --- |
| **Site shows** | `index.html`, `package.json`, `vite.config.js`, `public/`, `src/` → `main.jsx`, `App.jsx`. Run: `npm run dev` |
| **Tool produces (rebuilt copy)** | `package.json`, `vite.config.js`, `index.html`, `README.md`, `.gitignore`, `scripts/prerender.mjs`, `public/` (assets, `sitemap.xml`, `robots.txt`, `js/motion.js`), `src/` → `main.jsx`, `entry-server.jsx`, `pages.js`, `page-meta.json`, `pages/<Page>.jsx` (one per page), `components/*.jsx`, `styles/site.css`, and `anim/`, `SiteAnimations.jsx` etc. when the page needs them. Source: `emit/react/scaffold.js`, `emit/react/index.js`. Scripts: `dev`, `build`, `preview`. |
| **Tool produces (as-is copy)** | `package.json`, `vite.config.js`, `src/entry.js` (an empty module), `public/` (the whole copy), `_headers`, `README.md`. Scripts: **`build` and `preview` only**. Source: `pack.js` (react-vite branch). |
| **Run command** | Rebuilt: `npm install`, `npm run dev` (also `npm run build`, `npm run preview`). As-is: `npm install`, `npm run preview` → http://localhost:4173, `npm run build` → `dist/`. |
| **Inconsistency inside the tool** | For the as-is copy, `DEPLOY.md` says `npm run dev`, but the generated `package.json` has no `dev` script (the README mentions `npm run dev` too). So `npm run dev` fails on an as-is React copy. Worth telling the tool's owner (you). |
| **Action needed** | **Update.** `App.jsx` does not exist (pages are `src/pages/<Page>.jsx`). Add or swap in `pages/`, `components/`, `styles/site.css`. `main.jsx` and `vite.config.js` are correct for the rebuilt copy. `npm run dev` is correct only for the rebuilt copy. |

## 3. Next.js

| | |
| --- | --- |
| **Site shows** | `package.json`, `next.config.js`, `public/`, `app/` → `layout.tsx`, `page.tsx`, `about/page.tsx`. Run: `npm run dev` |
| **Tool produces (rebuilt copy)** | `package.json`, `next.config.mjs`, `jsconfig.json`, `.gitignore`, `README.md`, `public/` (assets, `sitemap.xml`, `robots.txt`, `_redirects` when URLs change), `vercel.json` (when URLs change), `app/<group>/layout.jsx`, `app/<route>/page.jsx` + `page.css`, `app/site.css`, `components/*.jsx`, `anim/` when needed. It is a **static export** (`output: 'export'`), JavaScript (`.jsx`), not TypeScript. Scripts: `dev`, `build`, `serve`. Source: `emit/next/index.js`. |
| **Tool produces (as-is copy)** | `package.json`, `next.config.mjs`, `app/layout.jsx`, `app/not-found.jsx`, `public/` (the whole copy; the original's `_next` is moved to `public/next-assets`), `README.md`. Scripts: **`build` and `start` only.** Source: `pack.js` (nextjs branch). |
| **Run command** | Rebuilt: `npm install`, `npm run dev` (`npm run build` → `out/`). As-is: `npm install`, `npm run build`, `npm run start` → http://localhost:3000. |
| **Inconsistency inside the tool** | As-is Next.js has no `dev` script, but `DEPLOY.md` tells the user `npm run dev`. |
| **Action needed** | **Update.** `next.config.js` → `next.config.mjs`; `layout.tsx` / `page.tsx` → `.jsx`; the `about/page.tsx` example is right in spirit (routes are `app/<route>/page.jsx`). Pick which mode to show and its run command. |

## 4. MERN

| | |
| --- | --- |
| **Site shows** | `package.json`, `client/` → `src/App.jsx`, `server/` → `server.js`, `models/Message.js`. Run: `npm run build && npm start` |
| **Tool produces (rebuilt copy)** | Root: `package.json`, `.gitignore`, `README.md`, `docker-compose.yml`. `client/` = the whole React + Vite project from section 2. `server/`: `package.json`, `forms.json`, `.env.example`, `.gitignore`, `src/{app,forms,index,limiter,store}.js`, `test/*.test.js`. Source: `emit/mern/index.js` and `emit/mern/template/`. |
| **Tool produces (as-is copy)** | `package.json`, `README.md`, `server/src/{app,forms,index,limiter,store}.js`, `server/forms.json`, `server/site.json`, `client/dist/` (the copy). Source: `pack.js` (mern branch). |
| **Run command** | Rebuilt: `npm run install:all`, `npm run build`, `npm start` → http://localhost:3000. Forms need `MONGODB_URI`; without it the site runs and the form endpoint answers 503. As-is: `npm install`, `npm start` (nothing to build). |
| **Inconsistency inside the tool** | `DEPLOY.md` tells the as-is MERN user to run `npm run install:all`, but the as-is `package.json` has no such script (it needs plain `npm install`). |
| **Action needed** | **Update.** There is no `server.js`, no `models/` folder (no Mongoose model: it uses the `mongodb` driver in `server/src/store.js`), and no `src/App.jsx` at `client/` level for the rebuilt copy (it is `client/src/pages/<Page>.jsx`). `npm run build && npm start` is only half right: install first with `npm run install:all`. |

## Summary

| Stack | Tree on the site | Run on the site | Action |
| --- | --- | --- | --- |
| HTML | invented file names | `npx serve .` is right for the as-is copy | update tree |
| React + Vite | `App.jsx` does not exist | `npm run dev` right for rebuilt, not as-is | update tree and run |
| Next.js | `.js` / `.tsx` names wrong | `npm run dev` right for rebuilt, not as-is | update tree and run |
| MERN | `server.js`, `models/Message.js`, `src/App.jsx` do not exist | missing `install:all` | update tree and run |

Decision needed from you: show the **rebuilt copy** shape, the **as-is copy** shape, or a neutral top-level sketch (folder names only). I'd lean towards the as-is copy since that is the current mode, but it has less to show (the copy itself under `public/`).

## Appendix: `public/images/*` usage

Searched `app/`, `components/`, `lib/`, `next.config.mjs`, `_legacy/` and the repo root. Nothing deleted.

| File | Referenced by |
| --- | --- |
| `screens/check.webp`, `screens/compare.webp`, `screens/create.webp`, `screens/results.webp` | nothing in code (only listed in `README.md`). **Unreferenced.** |
| `sites/collateral-copy-home.webp`, `sites/collateral-original-home.webp` | only `_legacy/home-page.tsx.txt` (old page, lines 226 and 231) and `README.md`. **Not used by the live site.** |
| `sites/marquee-collateral.webp`, `marquee-indikaai.webp`, `marquee-nyaayai.webp`, `marquee-panscience.webp`, `marquee-parchaa.webp` | nothing in code (only `README.md`). **Unreferenced.** |
| `sites/nyaayai-copy-home.webp`, `sites/nyaayai-original-home.webp` | nothing in code (only `README.md`). **Unreferenced.** |

All 13 files are unused by the current site. Two are referenced by `_legacy/` only.
