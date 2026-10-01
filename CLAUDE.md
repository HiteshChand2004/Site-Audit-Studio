# Site Audit Studio — Website Audit & Recreate Platform

Internal tool that keeps all company websites in one place, audits them, and automatically
recreates an improved version in a chosen stack. For company-owned or authorized sites only.

## Layout (3 columns)
- **Sidebar**: "New Project" button + saved websites list. Clicking one loads it into the OLD panel.
- **OLD panel**: URL + Analyze → original site preview (sandboxed iframe, or the Analyze screenshot
  when framing is blocked; Live/Shot toggle, 1440/768/375 viewports) → performance metrics → audit report (tech stack + confidence, weaknesses,
  SEO, AEO, meta/sitemap/robots, broken links, a11y, "manual rebuild needed") → Recreate + stack settings.
- **NEW panel**: preview of the recreated site (own localhost port) → fix checklist
  (fixed / still open / manual) → Download .zip.

## Tech stack
- Client: React 19 + Vite 6, Zustand, lucide-react, CSS Modules + tokens (`client/src/styles/tokens.css`).
  Port **5173**; `/api` is proxied to 4000.
- Server: Express 5 (ESM, `"type": "module"`). Port **4000**.
- DB: SQLite via Node's built-in **`node:sqlite`** (`DatabaseSync`). No native build, so it's safe on Windows.
  Needs Node ≥ 22.13. The ExperimentalWarning is silenced with `--disable-warning=ExperimentalWarning`.
- Analyze (Phase 2): playwright (Chromium), lighthouse + chrome-launcher (run in a forked worker), @axe-core/playwright, cheerio, robots-parser.
- Preview + security (Phase 3): sharp (WebP screenshots), undici (fetch with a connect-time SSRF check).
- Recreate build (4a.5): esbuild (CSS/JS minification of the `dist/` production build).
- Recreate verify (4a.6): html-validate (standard + document presets, offline) for the generated HTML.
- Planned (Phase 4+): archiver, get-port, execa.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project CRUD (SQLite), stack modal, dummy audit | ✅ Done |
| 2 | Analyze job + SSE progress: Lighthouse (mobile+desktop), stack detection, crawler (broken links, sitemap, robots, meta), SEO, AEO, axe a11y, manual-rebuild detector | ✅ Done |
| 3 | OLD preview: frame check (XFO + CSP3 frame-ancestors), sandboxed iframe, screenshots 1440/768/375 (fold + full, WebP, keep latest 3), per-device metrics, SSRF guard | ✅ Done |
| 3b | Live view (CDP screencast, view + scroll + click, no keyboard) — deferred by the user | ⏳ Later |
| 4a | Recreate → plain HTML: page discovery (sitemap, limit), Playwright capture, local assets, IR, variant merge, semantic classes, fixers, build + verify, preview | ✅ Done (verified on real sites) |
| 4b | Motion + responsive fidelity: hover, scroll reveal, continuous animations, widget JS, visual diff score | ⏳ |
| 5 | Re-audit of the NEW site → real fix checklist (OLD vs NEW), sitemap/robots emitter | ✅ Done (verified on real sites; merged into `phase-4a` (99ebc2f)) |
| 5b | Full PreviewManager (several previews on 5100–5199) — deferred by the user | ⏳ Later |
| 6 | React+Vite / Next.js / MERN emitters + Download zip | ⏳ |

**Current status: Phase 5 COMPLETE, merged into `phase-4a` (99ebc2f)** (never pushed). Phases 1, 2, 3 and 4a are done
and merged on `phase-4a`.
5.1 re-audit job foundation ✅ · 5.2 comparator + sitemap/robots emitter ✅ · 5.3 API + `audit.recreate` contract ✅ ·
5.4 UI ✅ · 5.5 real-site verification + docs ✅. Phase 4b (motion + responsive fidelity) stays planned. Same workflow: one step at a time, WIP
commit, wait for the user's "next"; never push; while the user tests, work in a git worktree and merge only when asked.

### Phase 6 plan (approved) — branch `phase-6`

Stack emitters (React+Vite, Next.js, MERN) + Download zip. The plain-HTML pipeline stays the reference (fit pass, `dist/`, fidelity);
stack emitters run after it from the saved IR (`ir/site.json`), general, no site-specific code. Decisions: toolchains in
`server/toolchains/` installed on demand; React/Next hydrate (checklist shows the JS cost honestly); MERN v1 has a form endpoint +
Mongo; export to another stack from the saved IR without recapture; order 6.1 first.

| Step | Scope | Status |
|---|---|---|
| 6.1 | Download zip for HTML (`recreate/export/zip.js`, `GET …/recreate/:recreateId/download`, UI button) | ✅ WIP |
| 6.2 | Foundation: emitter registry, shared IR walker, stack in job/report, export from saved IR, toolchain setup | ✅ WIP |
| 6.3 | React+Vite | ✅ WIP |
| 6.4 | Next.js | ✅ WIP |
| 6.5 | MERN | ⏳ |
| 6.6 | Re-audit (target-stack-aware runtime rows) + UI | ⏳ |
| 6.7 | Real-site verification + docs | ⏳ |

6.1 details: zip streamed on demand (archiver, nothing stored or buffered); layout `<host>-<stack>/{README.md, RECREATE-REPORT.md,
site/ (= dist/), unminified/ (readable css/js that differ from dist)}`; never capture/, fidelity/, ir/, report.json, dotfiles or links.
Limits 350 MB / 5000 files (413 before the first byte); webp/png/woff2/mp4… stored, the rest deflated. Only a recreate with
`report.safety.safe` and the stack it was built for (`?stack=` must match). HEAD plans without streaming: the app checks with HEAD
first and shows `X-Download-Error`. Test: `recreate-export.test.js`.

6.2 details (foundation, no new stack yet — `html` is the only `ready` emitter):
- **Emitter registry** (`recreate/emit/index.js`): one entry per stack id (`html`, `react-vite`, `nextjs`, `mern`; the last three
  `status: 'planned'`): `{ id, label, status, toolchain, scripts, assetsTarget, emit(ir, opts) → { files: Map, assets: Set }, build?(o) }`.
  `projects.js STACKS` and the Recreate route gate (`isReadyStack`) come from it; `GET /api/stacks` lists them with
  `toolchainInstalled` (+ the `setup` command). The client still has its own `RECREATE_STACKS` (switched over in 6.6).
- **Shared IR walker** (`emit/walk.js`): `refValue` (resolves `{asset,page,anchor,live,external}` through the emitter's
  `refs`: `assetHref`, `pageHref`, `stylesheetHref`, `useAsset`), `describeNode` (text / svg / element as plain data),
  `headTags` (the head as ordered tag descriptors), `safeJsonLd`, `relativeRefs`. `emit/html.js` only serialises them;
  its output is byte-identical to before (checked on 8 saved real IRs, with and without measurement ids).
  `emit/write.js writeProject` (was `generate.js writeSite`) writes files + hard-linked assets to `assetsTarget`.
- **Report**: `report.stack` = the project's stack; `report.outputs[stackId] = { status:'ready', dir, … }` (`html` → `dist`, set by
  the build step; others by an export). Reports from before 6.2 count as `{ [stack]: dist }` (`reportOutputs`). The download
  route accepts any stack that has a ready output (the zip itself is still HTML only: `planZip`).
- **Export without recapture** (`recreate/export/fromIr.js`, `POST /api/projects/:id/recreate/:recreateId/export { stack }`):
  reads `ir/site.json` + `assets/manifest.json`, `emitter.emit` → `stacks/<stack>.tmp` → optional `emitter.build` → renamed to
  `stacks/<stack>/`; `report.outputs[stack]` is written to the DB row and `report.json`. Idempotent (existing output returned,
  200 vs 201), under the global job lock, 409 for a planned stack or a missing toolchain, 404 when the IR/assets were pruned,
  nothing left behind on a failed build. Lives inside the recreate folder, so retention covers it.
- **Toolchains** (`server/toolchains/<id>/package.json`, own `node_modules`, gitignored): pinned `react-vite` (vite 6.3.5,
  plugin-react 4.5.0, react/react-dom 19.1.0) and `next` (next 15.3.3 + react 19.1.0). `npm run setup:toolchains -w server -- react-vite`
  installs on demand (`--ignore-scripts`); no argument lists the status. `src/toolchains/index.js toolchainStatus(id)`.
  Tests: `recreate-stacks.test.js` (registry, walker, golden HTML, writeProject, toolchain, export route with fake emitters).

6.3 details (React + Vite, `status: 'ready'`, `scripts: true`, toolchain `react-vite`):
- **Emitter** (`recreate/emit/react/`): `jsx.js` (IR → JSX: React prop names, boolean attrs, `defaultValue`/`defaultChecked` instead of
  controlled inputs, `style` strings → objects, text and attribute values written as JS strings whenever JSX would change them,
  adjacent text merged, inline SVG = its own `<svg>` with props + `dangerouslySetInnerHTML`, no wrapper), `components.js` (element subtrees
  identical on ≥ 2 pages and ≥ 6 nodes → one shared component; structural signature, maximal subtrees, named from the semantic class),
  `scaffold.js` (package.json pinned from the toolchain, vite.config, dev shell, `src/pages.js` route table, `main.jsx`, `entry-server.jsx`,
  `scripts/prerender.mjs`, README), `index.js` (`emitReact`). URLs are **root-relative** (`/assets/…`, `/about/`): deploy at a domain root.
  `npm run build` = `vite build` + `vite build --ssr` + prerender: every page is written as HTML at its original path (`dist/about/index.html`),
  then hydrated by `src/main.jsx` (no top-level await: a page chunk imports the shared chunk, awaiting it there deadlocks). Page `<head>`s
  come from `headTags` as `src/page-meta.json`; `#root { display: contents }` keeps the wrapper out of the layout; React 19's preload hints for
  high-priority images are stripped from the markup (the `fetchpriority` attribute stays).
- **Build** (`build/toolchain.js runToolchain`): junction `node_modules` → `server/toolchains/react-vite/node_modules`, `node vite.js` as a child process
  (minimal env, 4-minute limit, output tail in the error), junction removed with `rmdir` (never recursive into the toolchain). No download, no scripts.
- **Verification** (`emit/react/build.js buildReact`, the emitter's `build` hook): (1) `scanProject` on the code around the pages; (2) build;
  (3) **safety v2** `scanSite(dist, { app: true })`: only `<script type=module src=/_app/*.js>` and `modulepreload` of `/_app` are allowed, JS must not use
  eval / new Function / document.write / importScripts / XHR / WebSocket / EventSource / sendBeacon / fetch / import() of another origin
  (page and component chunks carry the site's own text and are skipped: they are covered by the DOM equivalence with the scanned HTML build);
  (4) `verifySite(dist)`; (5) **equivalence with the plain-HTML build** (`verify/equivalence.js`): DOM signature (URLs resolved, whitespace between
  elements ignored) must be equal on every page, full-page screenshots ≥ 0.97 similar on all three views (lazy images loaded first), and with JS on the
  pages must hydrate without errors and without DOM change (a hydration problem is a **warning**: React renders the page again). DOM or visual
  difference = emitter mistake = the export fails and is recorded as `outputs[stack] = { status: 'failed', error }`.
- **Fidelity**: not measured a second time; `outputs[stack].fidelity = { score: <the HTML build's>, basis: 'equivalent-to-html' }` (the equivalence is the proof).
  Output entry also has `build` (steps, JS/CSS bytes + gzip), `safety`, `verify`, `equivalence`, `hydration`, `warnings`, `dist: 'dist'`.
- **Wiring**: Recreate with a non-HTML project stack queues `exportStack` right after the job (`recreate/jobs.js queueStackExport`; a failure never
  discards the recreate) and moves the project's preview onto the stack build. The preview serves the project's stack output when ready, else
  `dist` (`routes/recreate.js latestBuild`); `previewHeaders({ scripts })` adds `script-src 'self'` and `info.scripts` tells the app to frame it with
  `allow-scripts`; `startPreview` is keyed by recreate + folder + script policy. The re-audit still audits the HTML build (6.6 makes it stack-aware).
  The download zip of a stack = the project source (no `dist`, `.ssr`, `node_modules`) + `RECREATE-REPORT.md` with a build section. Client:
  `RECREATE_STACKS` now has `react-vite`.
- Verified on saved IRs of real sites (all DOM-equal, visual 1.0, hydration clean): panscience.xyz (Next.js, 2 shared components, JS 98 KB gz),
  parchaa.com (Framer, 6 components, 97 KB gz), a clone (42 components, 107 KB gz), the fixture. Tests: `recreate-react.test.js` (JSX, components,
  project files, app safety, preview CSP, project zip, a real build with form/SVG/entity/srcset constructs, a deliberate emitter bug is caught).

6.4 details (Next.js, `status: 'ready'`, `scripts: 'inline'`, toolchain `next` = next 15.5.27 + react 19.1.9; 15.3.3 was dropped: flagged vulnerable, CVE-2025-66478):
- **Emitter** (`recreate/emit/next/`): App Router, `output: 'export'`, `trailingSlash: true` (every page is `<route>/index.html`, so plain static servers, the
  preview and the verification work unchanged). `index.js emitNext`: pages `app/<group>/<route>/page.jsx`, shared components `components/*.jsx`
  (same `findShared`, imported as `@/components/…` via jsconfig), `app/site.css` imported by each root layout, plain `<a>` links (no client router).
  **Root layouts**: no `app/layout`; one route group `(site)`, `(site-2)`… per distinct `<html lang class>` + `<body class>` (a plain site gets one).
  **Head**: each page writes `<title>/<meta>/<link>` and its JSON-LD as elements (React hoists them into `<head>`; JSON-LD stays in `<body>`); charset
  and viewport are left to Next. Bare attributes (`crossorigin`) are written as `""`, or hydration adds a duplicate preload.
- **URL changes** (`next/routes.js`): `about.html` → `/about/`, `blog/first-post.html` → `/blog/first-post/`; folder pages and `/` keep theirs. Segments are made
  router-safe (no leading `_`/`.`, brackets, parentheses, spaces); route collisions get `-2`. `outputs.nextjs.urlChanges = [{ from, to }]` + a warning;
  `public/_redirects` (Netlify, Cloudflare Pages) and `vercel.json` (redirects + trailingSlash) are shipped only when something moved; canonical, `og:url` and
  `sitemap.xml` use the new URLs (`robots.txt`, `llms.txt`, JSON-LD are copied as they are). README lists the moves.
- **Build** (`next/build.js buildNext`): `next build` with the pinned toolchain (6-minute limit; env `NEXT_TELEMETRY_DISABLED`, `NEXT_IGNORE_INCORRECT_LOCKFILE` so it never
  patches the repository's lockfile), `.next` removed, output `out/` (`outputs.nextjs.dist = 'out'`). Same stages as React: source scan, build, safety, `verifySite`,
  equivalence + hydration; pages that moved are compared at their new URL and the HTML build's links are read through the same move (`urlMap`).
- **Safety profile `next`** (`verify/appProfiles.js`, `scanSite(dir, { app: 'next' })`): allowed `<script src=/_next/static/…js>` (no `type`) and inline
  `self.__next_f.push(<JSON array>)` data pushes (the argument must parse as a JSON array); everything else is a finding. JS sink scan: same ban list except
  `fetch()` and `XMLHttpRequest` (Next's own client router and polyfills; the exported pages use plain `<a>`); `chunks/app/*` (page content) skipped.
  `scanProject` now also covers `app/` layouts and root config, never `page.jsx` / `components/`.
- **Preview**: `scripts: 'inline'` — each HTML response gets `script-src 'self' 'sha256-…'` for exactly its inline scripts (`recreate/inlineScripts.js`), never
  `'unsafe-inline'`. `info.scripts` stays boolean for the app (it frames the preview with `allow-scripts`).
- **Equivalence changes**: the DOM signature ignores `<script>` (Next's data pushes sit in `<body>`), `next-route-announcer` and an empty `div[hidden]`; JSON-LD is read
  from the whole document; `/x/` and `/x/index.html` are one URL; hydration is detected on `#root` or the `document`. Zip: `out`, `.next` are never included.
- Verified on saved IRs: fixture (4 URL moves, DOM 6/6, hydration clean), panscience.xyz (Next.js → Next.js, 0 moves, 2 shared components); JS is ~243 KB gzip for
  Next vs ~98 KB for React + Vite (the framework runtime): the re-audit (6.6) will report it. Tests: `recreate-next.test.js`.

### Phase 5 final summary
After every successful Recreate the server audits the recreated site again (same Analyze pipeline on its `dist/`, served
on a throwaway loopback port) and compares it check by check with the analysis the recreate was built from. The NEW
panel shows the result as the **fix checklist**: Lighthouse scores before → after, status chips (fixed, improved, still
open, regressed, changed, manual, N/A), category sections with before / now, the recreate's evidence and review flags
for auto-generated text. Only recreated pages are compared; deploy-dependent checks are N/A; CPU-timing audits never
count as regressions; links that fail only at network level are "recheck". Every recreate now also ships `sitemap.xml` +
`robots.txt`, and a copy of the original `llms.txt` when the site publishes one. A Re-audit button re-runs it; stale
results (newer recreate / newer analysis) are flagged. Everything is general: no site- or platform-specific code.

**Real-site verification (5.5, authorized sites, API on a temp data dir, default page limit):**
| Site | Platform | Fidelity | Checklist | Lighthouse (mobile) before → after | Notes |
|---|---|---|---|---|---|
| parchaa.com | Framer | 89 | 48 rows: 13 fixed, 1 improved, 13 open, 1 regressed, 2 manual, 4 N/A | perf 51 → 70, SEO 92 → 100, a11y 89 → 91 | Framer + GTM runtime gone; headings (23 skipped levels, several h1) fixed; link names fixed (review); regression: unused CSS (shared stylesheet, deferred); no llms.txt on the original → still open |
| panscience.xyz | Next.js | 80 | 38 rows: 6 fixed, 5 open, 3 regressed, 1 recheck, 3 N/A | perf 83 → 83, SEO 100 → 100, a11y 91 → 91 | Next.js runtime gone; broken link unlinked; llms.txt copied (passes on both); regressions: render-blocking + unused CSS (shared stylesheet, deferred), colour contrast 14 → 27 elements; recheck: medium.com refused the connection on one run |
| Recreate fixture | — | 98 | 35 rows | SEO 100 → 100 | |
| Seeded Analyze fixture | — | 98 | 33 rows: 11 fixed | SEO 83 → 100, a11y 86 → 100 | real regression: render-blocking CSS/font preload |

**Found by the checklist and fixed in 5.5 (general):** the broken-links fixer left `<a>` without `href` (Lighthouse
"Links are not crawlable", panscience SEO 100 → 92). Unlinked links now become a `<span>` with the same text/class/id and
no link-only attribute (`href`, `target`, `rel`, `hreflang`, `download`, `ping`, `referrerpolicy`, `type`, `aria-label`);
the `a` reset already rendered them like parent text, so the look is unchanged (panscience fidelity 80 → 80, SEO back to 100).

**Decisions from 5.5 real-site verification (approved by the user, implemented):**
1. **llms.txt copied**: discovery reads the original `/llms.txt` (`fetchLlmsTxt`, SSRF-guarded, soft 404 ignored, 256 KB
   limit: a file that reaches it is never copied cut — `report.warnings` asks to copy it by hand) and
   `ir/crawlFiles.js` ships it as it is in `ir.files` (so every stack emitter gets it). `report.fixes` `crawl-files` lists
   it ("…, llms.txt copied"); it is the evidence of `aeo.llms-txt`.
2. **More affected at the same severity = regressed**: `classify` returns `regressed` when the rank is equal and the
   count grew (e.g. colour contrast 14 → 27 elements), `improved` when it shrank.
3. **Network-level link failures = recheck**: a NEW-only broken link whose result is `REFUSED`, `DNS` or `TIMEOUT`
   (`NETWORK_FAILURES`) goes to a `links.broken-recheck` row, status **`recheck`** ("Links to recheck", `RECHECK_NOTE`),
   never `regressed`; HTTP errors stay in `links.broken-new` (regressed). `recheck` is counted in `summary.recheck`, left
   out of the 3-status list, shown with its own chip and link list in the UI.
4. **Deferred to a later phase**: one shared `css/site.css` for every page causes Lighthouse "Reduce unused CSS" and
   render-blocking regressions (parchaa, panscience, seeded fixture). A per-page / critical-CSS split is planned later;
   until then the checklist reports these honestly as regressions.

### Phase 5 plan (approved)
The fix checklist = the same Analyze pipeline run again on the recreated site (NEW), compared item by item with the
analysis the recreate was built from (OLD). Nothing hardcoded, and **nothing site-specific**: the comparator, the page
mapping and the sitemap/robots emitter work from general data only (the recreate report, analyzer keys, URL paths);
real sites (parchaa.com, panscience.xyz, …) are verification sites, never targets of special-case code.

| Step | Scope | Status |
|---|---|---|
| 5.1 Job foundation | `reaudits` table, JobManager, routes + SSE, throwaway server on `dist/`, internal net policy, `runAnalysis` options, auto-trigger after Recreate, retention | ✅ WIP |
| 5.2 Comparator + sitemap/robots emitter | stable analyzer `key`s, page mapping OLD URL → NEW path, OLD re-scored on the recreated pages only, category matchers, classification, `report.fixes` evidence; `sitemap.xml` + `robots.txt` in the recreate (target_domain or original origin) | ✅ WIP |
| 5.3 API + contract | real `audit.recreate` (additive: checklist, summary, scores before/after, stale) | ✅ WIP |
| 5.4 UI | score strip before → after, summary chips, category accordions, progress, Re-audit button, states | ✅ WIP |
| 5.5 Verification + docs | fixture + real sites through the UI | ✅ |

Decisions (approved by the user):
- **Trigger**: automatic after every successful Recreate (a separate job queued from the Recreate job's `after` hook, so a
  failed re-audit never discards a recreate) **plus** a manual Re-audit button (retry, or after the recreate/analysis changed).
- **Statuses**: ✓ fixed · ◐ improved · ✗ still open · ↓ regressed (new in NEW) · ~ changed (CPU timing, noisy locally) · ⟳ recheck (network-level link failure) · ⚠ manual (never ✓) ·
  n/a (deploy check: not measurable on a local preview, e.g. HTTPS, TTFB). Items passing on both sides are grouped.
- **Scope matching**: only pages recreated on both sides are compared; OLD issues on pages that were not recreated are
  "out of scope", never "fixed". OLD is re-scored with the same analyzers on its saved per-page facts (`crawl.json`).
- **Matching**: SEO/AEO/crawl by stable item key; axe by rule id + count (class names change, so no selector matching);
  broken links by normalized URL; Lighthouse by category score and by failing audit id; manual from OLD `manualRebuild`
  + the recreate's "Manual rebuild needed". Performance is labelled "measured on local preview, simulated throttling".
- **sitemap.xml / robots.txt**: a small emitter in the recreate (target_domain or original origin).
- **Job lock**: Analyze, Recreate and Re-audit share the one global lock (all drive Chromium; parallel Lighthouse runs
  distort each other). One re-audit per project at a time; the 5-minute Analyze budget.
- **Full PreviewManager**: deferred (Phase 5b); the re-audit uses its own throwaway server.

5.1 details (`server/src/reaudit/`, `routes/reaudit.js`):
- `runReaudit` serves the recreate's `dist/` through the preview handler (`servePreview`, CSP/Host checks included) on a
  throwaway 127.0.0.1 port — never the app's active preview, which moves when another project is selected — and runs
  `runAnalysis` with `createNetPolicy({ internalPorts: [thatPort], allowLoopback: <user flag> })`: only that port is
  reachable on loopback, everything else keeps the user SSRF policy (Lighthouse Chrome reaches it through the egress
  proxy, `<-loopback>`). Steps: `serve` + the Analyze steps without `screenshots` (the recreate has fidelity shots).
  Stack detection runs (5.2 can check that no platform runtime is left).
- `runAnalysis` options (Analyze never sets them): `url`, `outDir`, `skip` (step keys, no error), `seedUrls` (crawled
  first, before the homepage links — the recreated pages from the report, so unlinked pages are audited and the page
  limit (= recreated page count) is never spent on a broken internal link).
- Storage: raw results in `recreate/<recreateId>/reaudit/<reauditId>/` (crawl, axe, Lighthouse), never in `audit/`;
  the latest completed re-audit per recreate is kept (after hook), a removed recreate takes its re-audits with it.
  `reaudits` row: `recreate_id`, `analysis_id` (the OLD analysis from the recreate report), `result_json` =
  `{ reauditId, recreateId, analysisId, origin, pages, reauditedAt, audit }` (`audit` without the sample `recreate`).
- The JobManager `after` hook now also gets `payload`. Tests leave Lighthouse out via `JOB_OPTIONS.skip` / `skip`.
- Fixture end-to-end (API on a temp data dir): Analyze → Recreate (fidelity 98) → auto re-audit in ~25 s with Lighthouse:
  6/6 pages, 11 links, 0 broken, axe clean, Lighthouse 100/92/100/100, stack Custom/Unknown; expected open items for
  5.2: HTTPS (n/a on preview), sitemap.xml/robots.txt 404 (emitter in 5.2).

5.2 details (`server/src/reaudit/compare/{index,scope,rules}.js`, `recreate/ir/crawlFiles.js`):
- **Re-audit step `compare`** (last step): loads OLD (`analyses` row of `report.analysisId` + `audit/<analysisId>/`
  crawl.json, lighthouse-*.json) and NEW (the re-audit audit + its folder), `compareAudits()` → `result.checklist`.
  A missing OLD analysis fails the job ("Run Analyze and Recreate again").
- **Scope** (`scope.js`): each recreate report page (original URL + outPath) is paired with its OLD and NEW crawl page
  (`normUrl`: host without www, no protocol/hash/trailing slash). Both sides are re-scored with the same analyzers
  (`analyzeSeo`, `crawlErrorsItem`, `analyzeAeo`, `analyzeCrawl`) on the paired pages only → `scope.mode: 'pages'`;
  `scope.outOfScope` = OLD pages not recreated, `missingInNew/Old` = recreated pages one crawl missed. Without both
  crawls or the homepage pair → `mode: 'site'` (stored rows compared, with a note). A check the re-score cannot repeat
  (older analyses have no `renderedTextLength`) keeps its stored row. NEW URLs map back to the original
  (`toOriginalUrl`: recreated page → its original URL, other preview paths → original origin).
- **Analyzer keys**: SEO/AEO items carry `key` (`itemKey(section, title)`, e.g. `seo.meta-description`; stored audits
  without keys get the same id from their title) and `count` (affected pages/images/places). Multi-problem checks list
  `parts` (Title tag and Meta description: `missing` / `duplicate` / `length`; Headings: `none` / `many`), and the
  checklist compares **part by part** (`seo.title-tag.missing`, …) so a fix is never hidden behind an older problem.
  `crawl.metaTags.count` = missing tags. All additive.
- **Rows**: SEO/AEO by key or part; crawl files (`crawl.sitemap|robots|meta-tags`); axe by rule id + count (critical /
  serious = fail); broken links: OLD broken links found on paired pages vs NEW broken links (`links.broken` with
  `links.fixed/open`, plus `links.broken-new` = regressed, and since 5.5 `links.broken-recheck` = recheck for new
  network-level failures); Lighthouse **performance + best-practices** audits (worst of
  mobile/desktop, by score; binary/numeric/metricSavings only; `metrics`/`hidden` groups left to the score strip; its
  SEO/a11y audits repeat our own checks), rows only when failing on a side; platforms: every OLD `techStack` id (not
  `custom`) → "No <name> runtime or CDN left" (fixed when NEW no longer detects it); manual: OLD `manualRebuild` +
  `report.manual` (status `manual`, never fixed).
- **Classification** (`rules.js classify`): rank pass 0 / warn 1 / fail 2 (Lighthouse: ≥0.9 / ≥0.5 / else). fixed =
  was failing, passes now; improved = lower rank, or same rank with a lower count / score +0.05; open = still failing;
  regressed = passed before, got worse in rank, or same rank with a higher count (5.5); pass = passes on both; na = `DEPLOY_CHECKS` (HTTPS, text compression,
  cache TTL, HTTP/2, server response time, redirects, CSP/HSTS/COOP/XFO, bf-cache — preview headers decide them) or not
  measured on NEW. Performance rows carry "Measured on a local preview with simulated throttling".
- **Evidence** (`rules.js EVIDENCE`): check key → our fixer ids (`report.fixes`) and auto-generated fields
  (`report.autoGenerated`); a fixed/improved row with auto-generated values gets `review: true`.
- Checklist JSON: `{ version, comparedAt, analysisId, recreateId, scope, summary{regressed,open,improved,fixed,manual,na,
  pass,total}, scores{before,after}, metrics{before,after}, categories[{id,label}], items[{ key, category, title, status,
  before{status,detail,count?,score?}, after{…}, note?, evidence?, review?, links?, helpUrl? }], notes[] }`; items sorted by
  category (performance, seo, aeo, accessibility, links, crawl, best-practices, platform, manual) then status.
- **sitemap.xml / robots.txt** (`ir/crawlFiles.js`, in `prepareSite` after the heads → `ir.files`, so every stack
  emitter gets them): sitemap = recreated pages without noindex at `baseUrl` (canonical when it is on that origin), no
  invented lastmod/priority; robots.txt = `Allow: /` (or `Disallow: /` when the original blocked everything) + the
  original's AI-crawler blocks (from discovery's `robots`) + `Sitemap: <baseUrl>/sitemap.xml`. Reported in
  `report.fixes` (`crawl-files`) and `report.autoGenerated` (`sitemap.xml`, `robots.txt`).
- **Re-audit fidelity to the future site**: `runAnalysis({ deployOrigin })` reads sitemaps that robots.txt lists at the
  site's future home (`report.baseUrl`) from the build instead (never fetched from the live site). The re-audit's
  throwaway server adds `connect-src 'self'` (`servePreview({ connectSelf })`): Lighthouse reads robots.txt from inside
  the page, and the site has no script. The app preview keeps the strict CSP.
- Analyze's `crawl.json` also stores `renderedTextLength` (for the "Content without JavaScript" re-score).
- Verified through the API (temp data dir): Recreate fixture → 35 rows (fixed 10, improved 2, open 5, manual 4, n/a 4;
  title/description length problems of the original correctly still open; Lighthouse SEO 100 → 100 after the CSP fix);
  seeded Analyze fixture → 33 rows (fixed 11 incl. axe image-alt, sitemap, robots, broken links; Lighthouse SEO 83 → 100,
  a11y 86 → 100; one real regression: render-blocking CSS/font preload ~70 ms). Tests: `reaudit.test.js` (a real
  analysis of a local "original" + a recreated build → checklist), `reaudit-compare.test.js` (rules, scope, emitter).

5.3 details (`server/src/reaudit/contract.js`, `routes/projects.js`):
- `GET /api/projects/:id/audit` builds `audit.recreate` **at read time** (`recreateSection`) from the latest completed
  re-audit of the project, the latest completed recreate and the running re-audit job; stored analyses keep the sample
  they were written with (`assembleAudit` unchanged). Never-analyzed projects keep the whole dummy audit.
- **Real** (a re-audit finished): `{ isDummy: false, status: 'done'|'queued'|'running' (a re-run), reauditId, recreateId,
  analysisId, reauditedAt, stale, staleReasons, job, lastError, checklist, version, summary, scores, metrics, categories,
  items, scope, notes }`. `staleReasons`: `'recreate'` (a newer completed recreate exists) and/or `'analysis'` (the audit
  shown is newer than the analysis the checklist compared against). `lastError`: the latest attempt failed after the
  result (the last good checklist stays). `job`: `{ id, status, step, pct, message }` of a queued/running re-audit.
- `checklist` keeps the **original 3-status contract** (`fixed` / `open` / `manual`, + `key`, `detail` = NEW detail):
  improved and regressed are `open`, pass and n/a are left out (`legacyChecklist`). The full statuses are in `items`.
- **Sample** (no re-audit finished): the dummy checklist with `isDummy: true` plus `status` (`not-started` | `queued` |
  `running` | `failed`), `recreateId` (latest completed recreate or null: a run is possible), `job`, `lastError`.
- Client compatibility only (the real UI is 5.4): `FixChecklist` survives an empty list and keys rows by `key`; the
  "Sample checklist" note shows only when `audit.recreate.isDummy`.
- Verified through the API on the Recreate fixture: after Analyze → sample `not-started`; during the auto re-audit →
  sample `running` with job progress; after → real, 35 rows, legacy list 21 rows, not stale.
- **CPU-timing noise (decision: option 1, approved)**: right after a Recreate, "Minimize main-thread work" measured 5.2 s on
  the NEW site (regressed); a re-run seconds later passed on both sides. Rule (`rules.js isCpuTiming`, general, no audit
  ids): a Lighthouse audit whose `numericUnit` is `millisecond` and whose details are not an `opportunity` reports a
  measured CPU duration (today: main-thread work, JS boot-up time). When such a row would be `regressed` it becomes
  **`changed`** ("noisy locally", `NOISY_NOTE`), counted in `summary.changed`, left out of the 3-status list. Improvements
  keep their status. Status order: regressed, open, changed, recheck, improved, fixed, manual, na, pass.

5.4 details (client):
- Store (`useProjects.js`): third job kind `reaudit` (`reaudits` state, `startReaudit` / `getCurrentReaudit` /
  `subscribeReaudit` in `api/client.js`, same SSE + reconnect). When a Recreate finishes, `followReaudit` attaches to the
  re-audit the server queued and reloads the audit; a re-audit that ends (done or failed) reloads the audit.
  `reaudit(id)` starts one (409 → follow the running one). Project selection reattaches to running re-audits too.
- NEW panel "Fix checklist" section: re-audit progress (`AnalyzeProgress kind="reaudit"`, "Re-auditing the recreated
  site", failure + dismiss). **Sample** (`isDummy`): when a recreate exists and no re-audit runs, a CTA "No fix checklist
  for this recreate yet" (+ last error) with **Re-audit now**; then the labelled sample list. **Real**: `FixReport`.
- `components/recreate/FixReport.jsx`: header "Original vs recreated" (re-audit time, pages compared, pages not
  recreated) + **Re-audit** button (disabled while a Recreate or Re-audit of the project runs); stale banner (one line per
  `staleReasons`) and last-error banner; **score strip** (Lighthouse homepage, Mobile/Desktop toggle, before → after per
  category with ± delta, LCP/TBT/CLS/page size before → after, local-preview footnote); **status chips** with counts
  (fixed, improved, still open, regressed, changed, manual, N/A) that filter the rows (aria-pressed, "Show all");
  **category sections** (`<details>`, counts per status in the header, open by default when they hold open/regressed
  rows or match the filter), rows as `<details>`: status mark, title, "Review" badge (auto-generated values), status
  label; expanded: Before / Now, broken-link lists (fixed / still broken / new), recreate evidence (fixer + count,
  auto-generated values with an example), review hint, note, axe "How to fix" link; "Passing on both sides (N)" group
  per category; notes. Tokens only; keyboard focus rings; 2-column score grid under 560 px.
- Verified in the real app (worktree client on a scratch Vite config → worktree API, temp data, Playwright screenshots):
  sample before Recreate; Recreate clicked in the UI → auto re-audit progress → checklist (fixture: 9 fixed, 1 improved,
  6 open, 4 manual, 4 N/A); manual Re-audit from the card (button disabled while it runs); rows expanded (evidence,
  broken-link lists, the auto-generated description flagged for review); "Fixed" filter; stale banner after a new Analyze.

### Phase 4a final summary
From a completed Analyze, **Recreate** produces a clean static HTML/CSS copy of an authorized site:
1. **Job foundation**: SSE progress, one job at a time (shared lock with Analyze), 10-minute budget, nothing kept on
   failure (tmp → final workspace), the latest 2 recreates kept.
2. **Discovery + capture**: homepage + up to N pages (login/cart/checkout/account/admin skipped and reported), each
   captured at 1440/768/375.
3. **Assets**: every image, font, icon and media file downloaded locally, SSRF-guarded; no links back to platform CDNs;
   files that could not be downloaded are reported, never linked live.
4. **Rebuild (IR + emitter)**: builder Desktop/Tablet/Phone copies merged into one responsive layout, readable semantic
   class names instead of builder names, missing titles/descriptions filled from the page and marked "auto-generated",
   forms go to "Manual rebuild needed".
5. **Fixes + safety**: alt text, accessible names, heading order, broken links, image loading, fonts; WordPress content
   from its REST API when reachable; SVG and HTML sanitized so no script remains; minified `dist/`.
6. **Build check, fidelity threshold, live preview**: atomic `dist/` build, safety gate, verification (files, links,
   assets, HTML), fidelity per page and overall with a threshold of 80, a static preview on 5100–5199 shown in the NEW
   panel with a fidelity + verification report card.
7. **Real-site fixes (4a.7)**: scroll-reveal content captured in its revealed state, same-origin `@font-face`, builder
   flex/grid sizing, wheel-driven capture scroll, srcset per view, robust navigation waits, a 7-minute inspect limit with
   a 2.5-minute reserve, SSE ping + reconnect. All fixes are general (no per-site code).
8. **Compare UI**: collapsible sidebar; Sync scroll (OLD screenshot + NEW full-height page scroll together, with a hint
   that it works in Shot mode only); the OLD preview follows the NEW page picker (per-page Recreate capture shots);
   the dev runner restarts the API only on real source changes and never during a job.

**Real-site verification (authorized sites, through the UI):**
| Site | Platform | Fidelity | Notes |
|---|---|---|---|
| parchaa.com | Framer | **88–89** / 100 (was 55) | 10/10 pages; homepage 68 → 84; /contact and /platform captured within the time limit |
| panscience.xyz | Next.js | **80** / 100 (was 75) | all images on /media |
| Framer test site | Framer | 97–98 / 100 | |
| Fixture (`fixtures/recreate-site`) | — | 98 / 100 | 28 links / 27 assets / 6 pages valid |

Known open items (not blockers): parchaa /solutions mobile (view alignment mixes list items across breakpoints),
panscience /ventures tablet/desktop drift.

Output stack is plain HTML only for now; the fix checklist stays sample data until Phase 5; Download waits for Phase 6.

### Phase 4a progress
| Step | Status | Commits | Summary |
|---|---|---|---|
| 4a.1 Job foundation | ✅ Done | `64a559f`, `6464957` | Recreate job + SSE progress, global one-job lock shared with Analyze, 10-min budget (`SAS_RECREATE_MINUTES`), tmp → final workspace with keep-latest-2 retention, stale-analysis warning, `recreate_pages`/`target_domain` settings, Recreate button. Tests run on a temp DB per test file (`test/run-tests.js`), never `data/app.db`. |
| 4a.2 Discovery + capture | ✅ Done | `385c00d` | `discover.js` (homepage → homepage links → sitemap → crawl, limit, skip reasons, links-to-live), `capture/` (DOM + computed-style diffs, pseudo-elements, SVG, head, tokens, fonts, resources, fold/full WebP at 1440/768/375), `inspect.js` = step 1; `fixtures/recreate-site` + `recreate-capture.test.js`. |
| 4a.3 Assets | ✅ Done | `26bfff5` | Images, icons, fonts and media downloaded into `assets/` (no platform CDN links left; skipped files are reported, never linked live). SSRF guard on every download: URL precheck + connect-time IP check on every redirect hop (defeats DNS rebinding) via `guardedFetch` in `http.js`. Dedupe by URL and by content hash (sha256). Per-file size/time limits by kind plus a per-recreate budget (800 files, 300 MB). Cross-origin stylesheets downloaded and parsed (@font-face, @keyframes, @import). Modules: `assets/{index,collect,css,download,cdn}.js`; fixture `/cdn/` second origin + `recreate-assets.test.js`. SVG files are sanitized at the end of this step since 4a.5. |
| 4a.4 IR + HTML emitter | ✅ Done | `1bdd007` | Fixture fidelity **99/100** (every page 96–100). `ir/` (tree: view alignment, **responsive merge** of builder Desktop/Tablet/Phone copies into one element with base + tablet/mobile media queries, wrapper cleanup; styles: one class per distinct style, sizes restored from captured boxes; names: **semantic classes**, original names only when human-written, never builder/hashed/utility names; head: original tags kept, missing ones **auto-filled from the page and listed in `report.autoGenerated`**, missing `lang` reported not guessed; links: recreated pages relative, others live + reported), `emit/` (pages at original paths, `css/site.css`, **assets linked by relative local paths**, hard-linked files), `ir/site.json`. **Forms** keep markup, lose `action`, go to **Manual rebuild needed**. Generate step = IR + emit + fit pass; build step = basic fidelity (`verify/`). Fixture `work.html` + `recreate-generate.test.js`. Inline SVG is sanitized in the IR build since 4a.5. |
| 4a.5 Fixers + WP REST | ✅ Done | `f21f10d`, `813dd37` | **SVG sanitizer** (`fixers/svg.js`, allowlist rewrite) on every downloaded SVG file (assets step) and every inline SVG (IR build); HTML attribute guard (`fixers/html.js`); JSON-LD re-serialized; **safety gate** (`verify/safety.js`) re-parses `site/` and `dist/` and fails the job on any finding. Fixers (`fixers/`): alt text, accessible names, heading hierarchy, broken links, LCP `fetchpriority` + lazy loading, `font-display: swap`, font preloads → `report.fixes` + `report.autoGenerated`. **WordPress REST** (`fixers/wordpress.js`): clean text + head fields, IR `pages[].content`, post/page totals. **Production build** `dist/` (esbuild-minified CSS/JS, `build/minify.js`). Fixture: `/wp-json/wp/v2/`, WP-style contact page, fixer + unsafe-SVG seeds on `/work.html`; `recreate-fixers.test.js`. |
| 4a.6 Build, verify, preview | ✅ Done | `fd8d826` | **Build step** (`build/index.js`): atomic `dist/` build (`dist.tmp` → `dist`, a failure names the file), safety gate (moved here from generate), **verification** of `dist/` (`verify/site.js`: every emitted file present, internal links + anchors, local assets in HTML/CSS/SVG, no remote asset, **html-validate**; emitter-only HTML errors fail the job, markup carried over from the original is a warning), **fidelity** rendered from `dist/` with a **threshold of 80** (views, pages and site flagged `low`, warnings). **Preview** (`preview.js`): one recreate's `dist/` on `127.0.0.1:5100–5199`, one active preview, Host check, realpath containment, no dotfiles, strict CSP (`frame-ancestors` = the app); step 5 serves every page through it; started after the job and by `POST /preview`. NEW panel: sandboxed iframe (no scripts), viewport + page picker, report card. Fixture: fidelity **98**, 28 links / 27 assets / 6 pages valid; `recreate-build.test.js`. |
| 4a.7 Real-site fixes | ✅ Done | `9d129c3`, `4657970`…`1ef3342`, `e8a23c2` | From real-site testing (parchaa.com, Framer test site). **Scroll-reveal capture**: content hidden by appear effects (opacity 0 until in view, hidden again after) is captured in its revealed end state (animations finished, state pinned). **Same-origin `@font-face`** sources were bare strings → no `@font-face` emitted; fixed. **Builder flex sizing** (frames with absolute-only children, `display: contents` wrappers, content-sized flex items). parchaa.com fidelity 55 → 83 (/platform 47 → 86; homepage 68 still low), Framer test site 98. **Round 2** (branch `phase-4a-fix`, worktree, `4657970`…`1ef3342`; compared with the originals on parchaa.com (Framer) and panscience.xyz (Next.js)): wheel-driven capture scroll, srcset per view, grid item widths, wrap detection on the content box, capture waits for the document (retry, no `load` requirement), inspect winds down near its limit, untransformed boxes for rotated elements, sized transformed absolute boxes, `display: contents` in flow checks, spread flex columns, minimum sizes for small boxes, SSE watchdog + reconnect. parchaa.com 83 → **88** (10/10 pages; homepage 68 → 84), panscience.xyz 75 → **80** (all images on /media), Framer test site 97–98. Open: parchaa /solutions mobile (view alignment mixes list items across breakpoints), panscience /ventures tablet/desktop drift. Inspect limit 7 min with a 2.5-min reserve (`e8a23c2`): parchaa 6/6 pages, **89**. |
| 4a.7 UI + dev polish | ✅ Done | `82f0ece`, `5814686`, `b387d39`, `08b3daf`, `959577d`, `06355f7`, `15a62da` | Collapsible sidebar; dev runner (`server/scripts/dev.js`, restarts only on real changes, waits for jobs); Sync scroll of the websites inside the previews (+ Shot-mode hint); OLD preview follows the NEW page picker via `GET …/recreate/:recreateId/captures/:slug/:file`. |

4a.5 manually verified via UI end-to-end on fixture (recreate cc12277c) — site renders correctly in browser, dist/ minified build confirmed.
4a.6 verified end-to-end on the fixture through the running app (analysis 220fc9e7, recreate 0adc3a7d): fidelity 98/100,
28 links / 27 assets / 6 pages valid, preview on 127.0.0.1:5100 renders correctly at desktop and phone widths.

> ✅ **SAFETY — resolved in 4a.5:** the generated site contains no script and no external reference. Every SVG file and
> every inline SVG is rewritten by the allowlist sanitizer; `on*`/`srcdoc`/`formaction`/script-URL attributes and active
> elements are removed in the IR build; JSON-LD cannot close its `<script>`. The build step then re-parses every HTML,
> SVG and CSS file of `site/` and `dist/` (`verify/safety.js`) and **fails the job** if anything is found, so an unsafe site
> is never kept (`report.safety`). Defence in depth since 4a.6: the preview is served from its own port (never the app
> origin) with a CSP that allows no script, and framed with `sandbox="allow-same-origin"` (no `allow-scripts`) while the
> site has no JS (until 4b). Any JS added later (4b widget JS) must be generated by us and pass the safety gate.

Known issue: 2 `netGuard` tests fail on this Windows machine because `*.localhost` names don't resolve (DNS ENOTFOUND);
environmental, not a regression.

### Phase 4a decisions (approved)
- Fixes must be general, never site-specific (no per-URL code); platform knowledge lives in the rule JSON files.
- Scroll-reveal capture (4a.7, `capture/index.js` settle): scroll in steps < 1 viewport; track elements that start at
  opacity ≈ 0 and are shown by the page; finish their CSS transitions / Web Animations and record the settled
  opacity/transform/filter; back at the top, pin that state (inline `!important`, re-applied by a MutationObserver,
  transitions finished) on elements hidden again, except ones entirely inside the first screen and stacked siblings
  (carousel/tab slides). Never-revealed elements (menus, dialogs) stay hidden. Motion itself = Phase 4b.
- Flex/grid sizing (4a.7, `ir/styles.js`): the layout parent skips `display: contents`; a box whose in-flow children
  are none (all absolute/fixed/hidden, looking through `display: contents` wrappers) keeps its size; a content-sized
  flex or grid item (flex row: no grow; flex column: not stretched; grid: `justify-self` not stretch) gets `width` when
  its text wraps in any view (measured on the content box, padding excluded), it wraps a `flex: 1 0 0` child, it fills
  its parent, or it has no text — px when the width is equal in every view, % when the ratio is, else px (text: +1 px)
  + `max-width: 100%` unless it overflows its parent on purpose (marquee tracks). Small boxes (≤ 400×200, not filling
  the parent) that hold text, and small inline-level boxes, get `min-width` (captured − 1 px) / `min-height`: badges,
  chips and labels keep their size without ever cutting or wrapping text. A flex column that spreads its children
  (space-between, …) is measured by the sum of its children for `min-height`. Absolutely positioned boxes keep their
  size whatever their transform.
- Capture robustness (4a.7): scrolling is real mouse-wheel input (scripts that own the scroll position undo
  `scrollTo`), with a `scrollTo` fallback; navigation waits for `domcontentloaded` (one retry on timeout), the load event
  gets 20 s more but is not required; the inspect step stops starting pages when one more (at the slowest pace so far)
  would not fit its time limit (captured pages kept, the rest linked live, warning). Rotated/scaled elements are captured
  (and measured for fidelity) with their untransformed layout size, not the bounding box of the animation frame.
- srcset (4a.7, `assets/collect.js pickCandidates`): only the candidate each captured view used (`currentSrc`) is
  downloaded; an image that never loaded gets the smallest candidate covering its rendered width × DPR. Next.js-style
  srcsets (~16 widths per image) no longer fill the 800-file budget.
- Job progress (4a.7): SSE sends a named `ping` every 15 s; the client reconnects a dropped or silent (40 s) stream with
  backoff for up to 2 min ("reconnecting…"), and a job lost to a server restart says so ("Run it again").
- Verification severity (4a.6, confirmed by the user): only generator mistakes fail the job (missing build files, broken
  internal links, missing or remote assets, emitter-only HTML errors). Markup problems carried over from the original
  site (e.g. a button inside a link) and links to a missing `#anchor` are warnings only.
- Minimal static preview server in 4a (one active preview, ports 5100–5199); full PreviewManager in Phase 5.
- Internal links to pages beyond the page limit point to the original live URL and are marked in the report.
- Missing text (meta description, alt) is generated by heuristics only (no LLM) and marked "auto-generated".
- Recreate needs a completed Analyze; an analysis older than 7 days gives a warning.
- One global lock: only one Analyze **or** Recreate job runs at a time (`server/src/jobs/manager.js`).
- Time limit 10 minutes, configurable with `SAS_RECREATE_MINUTES` (1–60). The inspect step may use up to 7 of them but
  stops starting pages when one more (at the slowest pace so far) would not fit before a 2.5-minute reserve for the later
  steps; uncaptured pages link to the live site with a warning. Capturing pages in parallel and shorter load waits were
  tried and rejected (they broke captures of animation-heavy pages).
- Sync scroll (UI): a labelled pill on the OLD/NEW divider. On = the two WEBSITES scroll together by the same share
  of their height: the app cannot scroll a frame from another origin, so OLD shows its Analyze screenshot (Shot; Live
  comes back when sync is turned off) and NEW draws the recreated page at full height (height from the report) inside
  an app-owned scroll box; the wheel stays inside the websites. Off (default, not remembered) = everything as before.
- Matching page (UI): the OLD preview follows the NEW page picker. For another page than the homepage, OLD Live
  frames that page's original URL and OLD Shot shows the screenshot the Recreate capture took of it
  (`capture/<slug>/<view>-full.webp`, served by `GET …/recreate/:recreateId/captures/:slug/:file`; `report.pages[].slug`,
  filled in for older reports by the GET route). The homepage keeps the Analyze screenshots.
- canonical/sitemap/OG use the original origin unless the project's `target_domain` is set.
- Tests use only the fixture site (localhost:4100); never send requests to external sites from tests.
- Discovery (4a.2): a fresh SSRF-guarded mini crawl (robots respected). Order: homepage, pages the homepage links to
  (link order), sitemap, rest of the crawl. Login/cart/checkout/account/admin paths are skipped and listed under
  "Manual rebuild needed"; query-string URLs, non-HTML files and robots-blocked pages are skipped with a reason.
  Pages keep their URLs: `/` → `index.html`, `/about.html` → `about.html`, `/about/` → `about/index.html`.
- Capture (4a.2): every page at 1440/768/375 → `capture/<slug>/<view>.json` (DOM tree with computed styles stored as
  diffs: inherited props vs parent, others vs the tag's browser default; element width/height left out, `rect` kept;
  pseudo-elements, inline SVG, lazy attrs, head, :root custom props, @font-face, @keyframes, media queries, resources)
  plus fold/full WebP screenshots, and `capture/manifest.json`. The desktop view is required per page.
- Assets (4a.3): images (img, srcset, lazy attrs, CSS backgrounds, pseudo content, posters, og:image, svg href), icons,
  fonts and media from the captures go to `assets/{images,icons,fonts,media}/<name>-<sha256:10>.<ext>` with
  `assets/manifest.json` (`map` URL → file, `files`, `skipped` with reasons, `fontFaces` with local files, `keyframes`).
  Every download uses `guardedFetch` (`audit/http.js`): precheck + connect-time IP check on **every redirect hop**.
  Dedupe by URL (fragment stripped, query kept) and by content hash. Limits per file: image 15 MB/20s, icon 1 MB/15s,
  font 5 MB/20s, media 40 MB/60s; per recreate: 800 files, 300 MB, 6 parallel. Only fonts of families the pages used.
  Cross-origin stylesheets the browser could not read are downloaded and parsed (@font-face, @keyframes, @import).
  Skipped files are **never linked live**: they are listed in `report.assets.skipped`; oversized video/audio and
  undownloadable platform-CDN files also go to "Manual rebuild needed". Platform CDN hosts = `cleanup.cdnHosts` of the rules.
- IR (4a.4, `recreate/ir/`): one merged tree per page. Views are aligned child by child (same tag sequence → by index,
  else LCS on tag + text); elements only one view has are kept and hidden in the others. Sibling copies with the same
  content and disjoint visibility (builder Desktop/Tablet/Phone variants) are merged into one element. Plain wrappers
  (no style, one child, same box) are removed; `div[role=navigation|banner|contentinfo|main|complementary]` become
  `nav|header|footer|main|aside`. `ir/site.json` = `{ version, baseUrl, breakpoints, tokens, fontFaces, keyframes,
  boxSizingReset, rules, files, pages[{ head, body }] }`; references are `{asset}`, `{page,hash}`, `{live}`, `{external}`,
  `{anchor}` and `url("asset:…")`, so later stack emitters only resolve them.
- Styles (4a.4): one class per distinct style (elements with identical styles share it), desktop-first: base + `@media
  (max-width)` tablet and mobile overrides. Breakpoints come from the site's own media queries (widest boundary between
  the captured widths), default 1023.98 / 767.98. A value missing in a later view is written as `inherit` (inherited
  props) or `revert`; a reset makes links, headings and form controls inherit so "same as parent" stays true.
  Computed px lose intent, so captured boxes restore it: equal side margins → `margin: auto` + max-width; a block
  narrower than its parent → `%` width when the ratio is equal in every view, else `max-width` px; images/SVG/video/fields
  → `100%` or px; empty boxes keep their size; absolute boxes keep one anchor per axis + size; px grid tracks that fill
  the container → `fr`; containers taller than their content → `min-height`. Sizes respect content-box vs border-box.
  `* { box-sizing: border-box }` is written once when most elements use it. Colours → hex; colours equal to a `:root`
  colour token → `var(--token)` (builder token names are renamed `--color-N`). Only used `@keyframes` and `@font-face`.
- Class names (4a.4): an original class name is reused only when it reads as human-written; builder patterns
  (`cleanup.classPatterns` of every rule), hashed CSS-in-JS names, utility and visibility classes never are. Otherwise the
  name is the role (`site-header`, `main-nav`, `title`, `button`, `card-image`, …) prefixed with the nearest named block.
  Ids are kept when meaningful or referenced (`for`, `aria-*`, `#anchor`).
- Head (4a.4): original title/description/canonical/OG/Twitter/icons/robots/JSON-LD are kept (generator and platform
  meta dropped). Missing ones are filled only from the page: title ← first h1 (+ site name), description ← og:description
  or the first paragraph ≥ 50 chars (clipped at 160), canonical ← target domain or original origin + page path, og:* ←
  title/description/canonical/first image ≥ 200 px, icon ← the homepage icon, or a generated letter favicon when the
  site has none. Every filled field is in `report.autoGenerated` (`page`, `field`, `value`, `source`); a missing `lang`
  is reported (`pages[].head.missing`), never guessed. Site name: og:site_name → JSON-LD → logo text → host.
- Links (4a.4): recreated pages → relative paths in their original form (`about/`, `../`); other same-site links keep the
  live URL and are listed in `report.generate.liveLinks` with the reason; `www.` and bare host count as one site;
  `javascript:`/`data:` hrefs are dropped; `target=_blank` gets `noopener`. Images whose file was not downloaded are
  left out; forms keep their markup, lose `action`, and are listed under "Manual rebuild needed".
- Fit pass + fidelity (4a.4, `recreate/verify/`): the site is served from 127.0.0.1 (random port) and rendered with page
  JS off and every other request aborted. The generate step renders every page and view, compares each element box with
  the capture (`data-sas-id` only in the in-memory measurement build) and adds widths (top-down, only under a matching
  parent) and min-heights (bottom-up) for up to 2 rounds; a round that lowers the score is undone. The build step then
  scores each page/view: `sizes` (w/h within ±3 px / 3–5 %), `boxes` (IoU ≥ 0.6) and a rough `visual` (full-page shots
  scaled to 96 px wide); score = 35/25/40 %. Generated shots go to `fidelity/<slug>/<view>-full.webp`.
- Output: `data/projects/<id>/recreate/<recreateId>/` (written as `<recreateId>.tmp`, renamed on success,
  deleted on failure/timeout); the latest 2 completed recreates are kept. Inside: `capture/`, `assets/`, `site/` (the
  generated site), `dist/` (production build, 4a.5), `ir/site.json`, `fidelity/`, `report.json`. Site assets are hard
  links to `assets/` (copy fallback).
- SVG sanitizer (4a.5, `fixers/svg.js`): parse (htmlparser2, XML mode) and **rewrite from an allowlist** of SVG elements
  (drawing, text, paint servers, filters, animation, `<style>`); everything else is dropped with its content
  (`script`, `foreignObject`, `iframe`, `metadata`, editor namespaces). Dropped: `on*`, `xml:base`, prefixed editor
  attributes, any `javascript:`/`vbscript:` value, animations whose `attributeName` is href/on*/style, `@import`.
  References (href, `url()` in attributes, `style=""` and `<style>`) may only be `#fragment`, a local asset (inline:
  `asset:<file>`) or a raster `data:image/*`; `<a href>` inside SVG may also be http(s)/mailto/tel/relative. Comments,
  PIs and DOCTYPE (entity declarations) are dropped; all text is re-escaped. Files: run on every `.svg` (or SVG-typed)
  download at the end of the assets step, in place; a file without an `<svg>` root is deleted and reported
  (`not-an-asset`). Inline: run in the IR build, so `ir/site.json` never holds unsanitized markup.
- HTML guard (4a.5, `fixers/html.js`, in the IR build): drops `on*`, `srcdoc`, `formaction`, `ping`, legacy URL attributes
  and script/HTML `data:` values; `object`/`applet`/`frame`/`base`/`script`/`template` elements. Head: JSON-LD is parsed
  and written again with `< > &` as `\u` escapes (invalid JSON-LD dropped); `hreflang` alternates only http(s).
- Safety gate (4a.5, `verify/safety.js`; in the build step since 4a.6): after the `dist/` build, every HTML/SVG/CSS file of `site/` and `dist/` is parsed
  again: non-JSON-LD `<script>`, `on*`, script URLs, `srcdoc`, meta refresh, active elements, SVG references that are not
  local, and CSS `@import`/external `url()`/`expression()` are issues. Any issue fails the job (`report.safety`).
- Fixers (4a.5, `fixers/`, run in the generate step on the merged trees before styles, once; font fixes on each IR build):
  - **alt**: images without `alt` get `title`/`aria-label` → the `<figure>` caption → a readable file name (hashes, sizes,
    `IMG_1234`-style names rejected); inside a link/button with text, or `role=presentation`, `alt=""`. Otherwise
    `alt=""` and listed as open (review). Every value is in `report.autoGenerated` (`field: 'alt'`).
  - **names**: links/buttons without an accessible name get `aria-label` (or the alt of their only icon image) from the
    target page title, "Site home", a known service (GitHub, LinkedIn, …) or host, `Email …`/`Call …`, a hint in the
    original class/id/icon file (`menu`→"Open menu", `search`, `close`, …). Fields without a label get the placeholder
    or field name. Nothing found → open item.
  - **headings**: one h1 (extra h1 → h2; no h1 → the first heading in `main` is promoted); skipped levels are fixed by
    outline (a heading goes one below the nearest earlier heading of a higher original level, so siblings stay
    siblings). Headings before the first h1 are left alone. The old tag's UA margins are written explicitly.
  - **broken links**: links to targets in `audit.brokenLinks.broken` or discovery skips with an HTTP error become a
    `<span>` (text, class and id kept; every link-only attribute dropped, since 5.5). Unverified links (401/403/429/
    timeouts) are kept.
  - **loading**: per desktop and mobile view the largest image in the first screen (≥ 150×100) gets
    `fetchpriority="high" loading="eager"`; images below the first screen in every view get `loading="lazy"
    decoding="async"`; iframes below it `loading="lazy"`.
  - **fonts**: `font-display` auto/block/missing → `swap`; each page preloads (`<link rel=preload as=font crossorigin>`) the
    closest-to-400 normal face (woff2 preferred) of the at most 2 families that carry most of its text (`head.preload`).
  - `report.fixes[]` = `{ id, title, status: fixed|partial|open, count, open, items, openItems? }` (ids: `broken-links`,
    `img-alt`, `accessible-names`, `headings`, `image-loading`, `font-display`, `font-preload`, `wordpress-text`).
- WordPress REST (4a.5, `fixers/wordpress.js`): only when `audit.techStack` has `wordpress`. Probes
  `/wp-json/wp/v2/pages`, falls back to `/?rest_route=/wp/v2/`; lists pages and posts (`_fields=id,link,type`, ≤ 3×100
  each, totals from `X-WP-Total`), matches recreated pages by `link` (www = bare host) and reads the full items. SSRF-guarded
  (`fetchPage`), 10 s per request, 30 s total. Uses: title/excerpt fill a missing `<title>`/description before the page
  heuristics (source "WordPress REST API"); leaf content blocks (p, h1–h6, li, blockquote, figcaption, dt/dd, td/th,
  pre) are aligned in order with the rendered blocks (same kind, word Dice ≥ 0.5, 40-block window) and text-only blocks
  take the REST text; blocks with inline markup keep the rendered version; REST-only blocks are counted, not inserted
  (layout still comes from the render). IR `pages[].content` keeps the sanitized content HTML (allowlist tags/attrs, no
  classes/styles/scripts/forms, https iframes only) for Phase 6 emitters. `report.wordpress` has totals vs recreated;
  unrecreated posts/pages go to "Manual rebuild needed". Unreachable API → a warning, rendered text used.
- Production build (4a.5, `build/minify.js`): `dist/` = the emitted files with CSS and JS minified by esbuild (no
  bundling, no syntax lowering) and JSON compacted; HTML as emitted; assets hard-linked. `report.minify` has sizes.
  `site/` stays readable. Since 4a.6 the build runs in the build step and is atomic: written to `dist.tmp`, renamed to
  `dist/` only when every file was written; an esbuild error or an unreadable asset fails the job with
  "The production build failed on <file>: <error>".
- Build step (4a.6, `build/index.js`, step 4 "Building & verifying"): `dist/` build → safety gate (`site/` + `dist/`) →
  verification of `dist/` → fidelity of `dist/`. Any failure fails the job and the whole workspace is discarded (no partial
  output is ever saved).
- Verification (4a.6, `verify/site.js`, `report.verify`): every emitted page, stylesheet and asset is in `dist/`; every
  internal `<a>`/`<area>` href resolves to a page (file, or folder + `index.html`); every local reference (src, srcset,
  poster, icon/preload/stylesheet links, SVG href, `url()` in CSS, `<style>`, `style=""`, and inside SVG files) exists;
  assets from another origin are errors (iframes such as video embeds may stay external). HTML: html-validate with the
  `standard` + `document` presets (`require-sri` off). Emitter-only rules (`parser-error`, `no-dup-attr`, `void-content`,
  `missing-doctype`, `doctype-html`, `element-name`, `no-raw-characters`, `unrecognized-char-ref`, `attr-delimiter`)
  are errors; other findings (content model, usually carried over from the original DOM) are warnings. Missing, broken,
  remote or error → the job fails with a message naming the first case; HTML warnings and links to a missing `#anchor`
  are listed in `report.warnings`.
- Fidelity (4a.6): measured on `dist/` (the build the preview serves). `FIDELITY_THRESHOLD = 80`: every view, page and
  the site get `low`; `report.fidelity` has `threshold`, `status` (ok | mixed | low), `lowPages`, `pages[].lowViews`.
  Below the threshold → warnings in the report; the site is still kept (a low score calls for a review, not a failure).
- Preview (4a.6, `recreate/preview.js`): one preview at a time, serving exactly one recreate's `dist/` on
  `127.0.0.1`, first free port in 5100–5199. GET/HEAD only; Host must be this port on 127.0.0.1/localhost; paths stay
  inside the root (resolved + realpath), dotfiles refused, a folder without its slash redirects to it (same-origin path
  only). Headers: CSP `default-src 'none'` (img/media/font/style self, inline style, https frames, `form-action 'none'`,
  `base-uri 'none'`, `frame-ancestors` = `APP_ORIGIN` + its localhost/127.0.0.1 twin), nosniff, no-referrer, CORP
  same-origin, no-store. Step 5 "Starting preview" serves the new `dist/` on a throwaway port through the same handler and
  requests every page and the stylesheet (`report.preview`). After a successful job the preview is started for it; the
  app calls `POST /preview` for the selected project (also after a server restart). Retention and project delete stop
  a preview of a removed folder. The port is runtime state, never stored in the report.

### Phase 3 summary
- **OLD panel preview**: the live site in a sandboxed iframe when it allows framing; when X-Frame-Options/CSP
  blocks it, the screenshot taken during Analyze is shown instead. A Live/Shot toggle is always available.
- **Screenshots** at desktop/tablet/mobile (1440/768/375), fold + full page, WebP.
- **Viewport toggle** renders the page at the real width and scales it to the panel; it stays in sync with the
  metrics Mobile/Desktop toggle.
- **Metrics chips** (load time = TTI, LCP, TBT, page size) show real Lighthouse data for mobile or desktop (`audit.metricsByDevice`).
- **SSRF guard** on every server-side request made for a user URL (see rules below).

### Phase 3 decisions
- Live view (remote browser / CDP screencast) is **not built**; it is deferred to Phase 3b. A reverse proxy
  that strips framing headers is rejected for security reasons (the site's JS would run on the app origin).
- Screenshots are taken on **every** analysis, not only when framing is blocked (they also feed the Phase 4b visual diff).
- Each project keeps the screenshots of its **latest 3** completed analyses; older ones are deleted automatically.
- No intranet allowlist for user URLs for now.

**Workflow rule:** implement one phase at a time, and only after the user says "go ahead". Commit at the end of each phase.

## Key decisions
- **Stack-agnostic recreate**: always work from the *rendered output* (Playwright DOM, computed CSS,
  screenshots, network assets), never the site's source code.
  Pipeline: Capture → platform-free IR → Fixers → Emitter(stack).
- **Stack detection** is a generic engine plus one JSON rule file per platform
  (`server/src/detection/rules/<id>.json`: signals + weights, limitations, cleanup, manualRebuild).
  A new platform means a new file, with no engine change. No match → "Custom/Unknown".
- **Platform cleanup**: never copy builder class names/wrappers (`framer-*`, Webflow `w-*`, Wix ids).
  Use semantic class names. Download all assets locally, with zero references to platform CDNs
  (framerusercontent.com, wixstatic, etc.). Merge duplicate Desktop/Tablet/Phone variants into one
  responsive layout (1440/768/375). WordPress: use `/wp-json/wp/v2/` for clean content when it's reachable.
- **Fix checklist** = run the same audit pipeline again on the NEW site and diff it against OLD. Nothing is hardcoded.
- **Authorization**: the New Project modal requires an "I'm authorized" checkbox (the server rejects requests
  without `authorized: true`), plus a permanent disclaimer in the top bar.
- Page limit for recreate is configurable (default: homepage + 5 pages).
- Things that can't be automated (form backends, login, cart/checkout, CMS data, plugin behaviour, WebGL)
  are reported under "Manual rebuild needed" and never faked.

## Analyze (Phase 2) rules
- **Time limit:** 5 minutes per analysis. A step that would start after the limit is skipped and listed in
  `audit.errors`. One analysis runs at a time; others queue.
- **Links:** 4xx/5xx, DNS failure, connection refused and bad TLS count as **broken**. 401, 403, 429, 999 and
  timeouts go to **unverified**, not broken. The check covers at most 500 unique links.
- **Stack detection rules** are JSON files in `server/src/detection/rules/<id>.json` (signals + weights,
  limitations, cleanup, manualRebuild). A new platform means a new file, with no engine change. No match → "Custom/Unknown".
- **Scope:** Lighthouse (mobile + desktop), axe and stack detection run on the **homepage only**. SEO, AEO,
  meta checks and the link check cover all crawled pages (`max_pages`, default 25, depth 3).

## Preview & network security (Phase 3) rules
- **SSRF guard** (`server/src/security/`): user URLs may only reach **public** addresses. Loopback, private
  (RFC 1918, CGNAT, ULA), link-local (cloud metadata) and reserved ranges are blocked, including IPv4 embedded in IPv6.
  The check runs on the **resolved IP at connect time** (defeats DNS rebinding) and on **every redirect hop**.
  Node fetches use an undici Agent whose connector resolves, checks and pins the IP. Playwright and Lighthouse
  Chrome run behind a per-analysis local egress proxy (`egressProxy.js`) that does the same for every request.
- **Dev flag** `SAS_ALLOW_LOCALHOST=1` (for example in `server/.env`, which is gitignored) allows loopback only, never the API
  port 4000. Private/intranet ranges have no allowlist.
- **Internal allowlist**: `createNetPolicy({ internalPorts })` lets platform code (Phase 5 PreviewManager) reach
  its own loopback preview ports. It is passed as `runAnalysis({ netPolicy })` and is never derived from user input;
  the analyze route always uses the default user policy.
- **Frame check** (`audit/frame.js`) follows browsers: CSP `frame-ancestors` (all policies must allow
  `APP_ORIGIN`, default `http://localhost:5173`) overrides X-Frame-Options; Report-Only and `<meta>` are ignored;
  ALLOW-FROM and frame-busting scripts only set `confidence: 'uncertain'`.
- **Iframe**: `sandbox="allow-scripts allow-same-origin"` (no top navigation, forms or popups), `allow=""`, no referrer.
  The app never frames its own origin. A manual Live/Shot toggle is always available.
- **Screenshots**: captured every analysis at 1440×900 (DPR 1), 768×1024 (DPR 1) and 375×812 (DPR 2, mobile UA),
  one fold and one full-page shot each, full page capped at 8,000 CSS px, WebP q75. Stored in
  `data/projects/<id>/audit/<analysisId>/screens/`, served by a whitelisted route with immutable caching.
  After each analysis only the latest **3** completed analyses of a project keep their `screens/`.

## Conventions
- **All product text in English** (UI, API errors, dummy data, comments, docs), even though the user chats in Hinglish.
- Theme: light, indigo accent `#4F46E5`, slate neutrals, Inter + JetBrains Mono (local via @fontsource).
  Colors only via tokens.
- OLD panel = slate rail/chip; NEW panel = indigo rail/chip.
- The audit JSON shape (`server/src/dummy/audit.js`) is the contract the UI renders. `server/src/audit/assemble.js` produces it; new fields must be additive (`test/analyzers.test.js` checks the keys).

## Structure
```
client/src/  layout/ (AppShell, Sidebar, OldPanel, NewPanel)
             components/{common,audit,preview,project,recreate}/  (preview/SitePreview.jsx = iframe/screenshot,
             recreate/RecreateReport.jsx = fidelity + verification card, recreate/FixReport.jsx = fix checklist)
             store/useProjects.js, api/client.js, constants.js (STACKS), styles/
server/src/  index.js, db/index.js (schema + migrations), routes/{projects,analyze,screens,recreate,reaudit}.js, dummy/audit.js
             reaudit/ index.js (serve dist/ + runAnalysis on it + compare, STEPS), jobs.js (job, auto-trigger target, retention),
                    contract.js (audit.recreate for GET /audit),
                    compare/{index,scope,rules}.js (fix checklist: OLD vs NEW)
             recreate/ir/crawlFiles.js (sitemap.xml + robots.txt)
             jobs/ manager.js (JobManager + global one-job lock), sse.js
             recreate/ index.js (pipeline + STEPS + budget), jobs.js, inputs.js, workspace.js (tmp → final, retention),
                    errors.js, discover.js (page selection), inspect.js (step 1), capture/{index,snapshot}.js (Playwright capture),
                    assets/{index,collect,css,download,cdn}.js (step 2: local assets),
                    ir/{index,tree,styles,names,head,links}.js (IR), emit/{html,css}.js (plain HTML emitter),
                    fixers/{index,svg,html,a11y,perf,wordpress}.js (sanitizers + audit fixers + WP REST), build/{index,minify}.js (step 4 + dist/),
                    generate.js (step 3: IR + fixers + emit + fit pass), preview.js (static preview + step 5),
                    verify/{server,layout,fidelity,safety,site}.js (local render, fidelity, safety gate, build verification)
             security/ netGuard.js (address classes, policies, resolveChecked), egressProxy.js (Chromium proxy)
             audit/ index.js (pipeline + STEPS), jobs.js (queue, 1 at a time), http.js, robots.js, sitemap.js,
                    crawler.js, extract.js, linkChecker.js, render.js, screenshots.js, retention.js, frame.js, assemble.js,
                    lighthouse/{run,worker}.js, analyzers/{seo,aeo,crawlChecks,a11y,metrics,weaknesses}.js
             detection/ engine.js, manual.js, manual-rules.json, rules/<platform>.json (15 platforms)
server/test/ *.test.js (node --test via run-tests.js + setup-data-dir.js: temp DB per test file),
             serve-fixture.js + fixtures/site (seeded audit issues) and fixtures/recreate-site (responsive site for Recreate,
             plus a small /wp-json/wp/v2/ API and unsafe-SVG / fixer seeds)
data/        app.db + projects/<id>/audit/<analysisId>/{crawl,axe,lighthouse-*}.json + screens/*.webp (gitignored)
```

## Run
Ports: client **5173**, API **4000**, fixture site **4100**, recreate previews **5100–5199** (4a.6: one active, on 127.0.0.1).
For local testing, create `server/.env` (gitignored) with `SAS_ALLOW_LOCALHOST=1` so the fixture site can be analyzed.
If the frontend says "Cannot reach the API server", the server on 4000 is not running (or something else holds the port).
```bash
npm install
npm run dev          # client :5173 + server :4000 (concurrently)
npm run dev:server   # or: npm run dev:client (server: scripts/dev.js restarts only on real content changes in src/ or .env)
npm run build        # client production build
npm test -w server   # unit tests; each test file gets its own temp DB (OS temp folder, deleted after the run), never data/app.db
npm test -w server -- test/crawl.test.js   # a single file
npm run fixture-site -w server   # seeded test site on :4100 (analyzing it needs SAS_ALLOW_LOCALHOST=1)
npm run fixture-site -w server -- recreate   # the Recreate fixture site on :4100 instead
npx -w server playwright install chromium   # one-time
```
API: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (PATCH takes `max_pages`), `GET /api/projects/:id/audit`,
`POST /api/projects/:id/analyze`, `GET /api/projects/:id/analyze/current`, `GET /api/projects/:id/analyze/:analysisId/events` (SSE: progress/done/failed),
`GET /api/projects/:id/analyses/:analysisId/screens/:file` (`{desktop,tablet,mobile}-{fold,full}.webp`),
`POST /api/projects/:id/recreate`, `GET /api/projects/:id/recreate` (latest attempt + latest report), `GET /api/projects/:id/recreate/current`,
`GET /api/projects/:id/recreate/:recreateId/captures/:slug/:file` (per-page capture shots of a completed recreate, same file names),
`GET /api/projects/:id/recreate/:recreateId/events` (SSE), `GET/POST/DELETE /api/projects/:id/preview` (preview of the latest
completed recreate: `{ preview: { url, port, recreateId, … } | null }`; POST 404 without a recreate, 503 without a free port),
`POST /api/projects/:id/reaudit` (re-audit of the latest completed recreate; 409 without one or while one runs),
`GET /api/projects/:id/reaudit` (`{ last, result, stale }`; `result.checklist` = the full comparison), `GET /api/projects/:id/reaudit/current`,
`GET /api/projects/:id/reaudit/:reauditId/events` (SSE), `GET /api/projects/:id/recreate/:recreateId/download[?stack=]` (zip), `POST …/recreate/:recreateId/export` (stack from the saved IR), `GET /api/stacks`, `GET /api/health`. PATCH `/api/projects/:id` also takes `recreate_pages` (0–20) and `target_domain`.

## Currently dummy / known issues
- Analyze is real. Projects that were never analyzed still get the **dummy** audit (`isDummy: true`, "Dummy data" badge).
- Never-analyzed projects show a wireframe in the OLD preview. The NEW preview is real since 4a.6 (the latest recreate's
  `dist/`). The fix checklist (`audit.recreate`) is real once a re-audit finished (5.3); before that it is the sample
  (`isDummy: true`) plus the re-audit state; the NEW panel renders it with `FixReport` (5.4).
  Download (Phase 6) stays disabled.
- Only one preview runs at a time: selecting another project with a recreate moves the preview to it. Clicking a link
  to a page that was not recreated opens the live original inside the preview frame (without script).
- Recreate output (4a.4): font sizes and line heights are px per breakpoint (no fluid type yet); between the three
  captured widths the layout relies on the %/max-width/fr heuristics. Hover, focus and scroll states come in 4b.
- A mobile Lighthouse run takes ~40s+, and screenshots add 5–30s, so a full analysis usually takes 1.5–3 minutes.
- Audits from before Phase 3 have no screenshots and no desktop metrics; the UI asks to run Analyze again.
- Some frameable sites still render blank in the iframe (frame-busting, cookie walls); use "Shot". Cookie banners
  appear in screenshots as real visitors see them. Full-page screenshots stop at 8,000 CSS px.
- The SSRF guard pins the first resolved IPv4 address, so Node's IPv6→IPv4 fallback is not used. Requests
  a page makes to blocked addresses are listed in `audit.blockedHosts`.
- No live view yet (Phase 3b).
- Bot-protected sites (Cloudflare challenge) fail with a clear message; they are never bypassed.
- Jobs live in memory; a server restart marks running analyses as failed. The dev server therefore does **not** use
  `node --watch`: on Windows it restarted with nothing edited (it watches every imported file, node_modules included,
  and NTFS last-access updates from other processes reading them count as changes — starting Vite, a Lighthouse worker
  or a test run was enough). `server/scripts/dev.js` watches only `src/` and `.env` and restarts only when a regular
  file's content hash changed (folder notifications ignored; an unreadable file is retried and ignored; watcher errors
  are survived), and it waits while `GET /api/health` reports `busy` (a job running or queued). Note for agents: a real
  edit to `server/src` still restarts the user's dev server once no job runs; work in a git worktree while the user
  tests.
- Project delete uses `window.confirm`. Git shows LF→CRLF warnings on Windows, which are harmless.
