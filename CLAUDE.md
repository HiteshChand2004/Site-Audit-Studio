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
- Download + stacks (Phase 6): archiver (zip streamed on demand). Build toolchains are NOT server dependencies: `server/toolchains/<id>/` (own
  `package.json`, own `node_modules`, gitignored) installed on demand with `npm run setup:toolchains -w server -- <react-vite|next|mern>`:
  `react-vite` (vite 6.3.5, plugin-react 4.5.0, react 19.1.0), `next` (next 15.5.27, react 19.1.9), `mern` (react-vite's + express 5.2.1, compression
  1.8.2, mongodb 7.7.0). The generated projects pin the same versions.
- Planned: get-port, execa.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project CRUD (SQLite), stack modal, dummy audit | ✅ Done |
| 2 | Analyze job + SSE progress: Lighthouse (mobile+desktop), stack detection, crawler (broken links, sitemap, robots, meta), SEO, AEO, axe a11y, manual-rebuild detector | ✅ Done |
| 3 | OLD preview: frame check (XFO + CSP3 frame-ancestors), sandboxed iframe, screenshots 1440/768/375 (fold + full, WebP, keep latest 3), per-device metrics, SSRF guard | ✅ Done |
| 3b | Live view (CDP screencast, view + scroll + click, no keyboard) — deferred by the user | ⏳ Later |
| 4a | Recreate → plain HTML: page discovery (sitemap, limit), Playwright capture, local assets, IR, variant merge, semantic classes, fixers, build + verify, preview | ✅ Done (verified on real sites) |
| 4b | Responsive fidelity + visual diff + motion (hover, focus, scroll reveal, loops) in all four stacks, with re-audit rows | ✅ Done, verified on real sites; merged into `phase-4a` (fast-forward from `phase-4b`, 53652dd, approved by the user); never pushed |
| 5 | Re-audit of the NEW site → real fix checklist (OLD vs NEW), sitemap/robots emitter | ✅ Done (verified on real sites; merged into `phase-4a` (99ebc2f)) |
| 5b | Full PreviewManager (several previews on 5100–5199) — deferred by the user | ⏳ Later |
| 6 | React+Vite / Next.js / MERN emitters + Download zip + stack-aware re-audit and UI | ✅ Done (verified on real sites, merged into `phase-4a` (d25444d)) |

**Current status: Phase 6 COMPLETE, merged into `phase-4a` (d25444d, fast-forward from `phase-6`) plus the post-merge `flex: revert` fix (c1d4ca3); never pushed.** Phases 1, 2, 3, 4a, 5 and 6 are done
and merged on `phase-4a`.
5.1 re-audit job foundation ✅ · 5.2 comparator + sitemap/robots emitter ✅ · 5.3 API + `audit.recreate` contract ✅ ·
5.4 UI ✅ · 5.5 real-site verification + docs ✅. Phase 4b (responsive fidelity, visual diff, motion) is done and merged into `phase-4a` (53652dd, fast-forward from `phase-4b`; see its final summary). Same workflow: one step at a time, WIP
commit, wait for the user's "next"; never push; while the user tests, work in a git worktree and merge only when asked.

### Speed and robustness of the jobs (after Phase 4b) — ✅ merged into `phase-4a` (d1b09e8, fast-forward from `perf-robustness`, approved by the user); never pushed
Final check before the merge: full server suite 238 / 238; panscience.xyz end to end through the API (Analyze 102 s, Recreate 491 s, re-audit 174 s, 0 errors, fidelity 80, visual difference 79,
6 / 6 pages, 42 / 42 widths, safety passed). The worktree `../Website-Audit-perf` and the branch `perf-robustness` can be removed.
Reported by the user on panscience.xyz: Analyze took very long, stopped at 43 % and ended with "render timed out after 85s, screenshots timed out after 70s, links /
Lighthouse skipped: the time budget ran out". On a quiet machine the same analysis took 82 s without an error: the pipeline was fragile on a slow network or a busy machine
(every step one after the other, one total budget, the most valuable step — Lighthouse — last). Everything below is general, nothing site-specific.
- **Parallel work by free memory** (`audit/resources.js parallelism({ perUnitMB, max, min })`, `freeMemoryMB`): how many browser contexts run at once comes from the memory available
  now (150 MB per page, 300 MB kept free; macOS = unknown = no cut). Deliberately lenient: with about 1 GB available, two views at a time instead of four made the capture of six pages
  take 212 s instead of ~120 s with no gain, so work is only cut back when memory is really exhausted. Used by the Analyze screenshots (≤ 3 views), the crawl's renders (≤ 3), the Recreate
  capture (4 views, never under 2), the sweep (4 widths, never under 2) and the responsive check (≤ 4 widths, was one at a time).
- **Analyze** (`audit/index.js`): robots / sitemap, the homepage render (+ axe) and the screenshots start together; the screenshots go on next to the crawl and the link check; the browser is
  closed before Lighthouse, which still runs alone (mobile, then desktop). `LIGHTHOUSE_RESERVE_MS` = 120 s is kept for Lighthouse: every step before it gets `stepBudget()` = its own limit, but
  never the reserve (message "Skipped: the time that is left is kept for the checks after it"); the mobile run leaves half of it to the desktop run. Budget 5 → **6 minutes**. A Lighthouse run that
  dies (not one that times out) is tried once more when ≥ 45 s are left. The homepage fetch is retried once after a timeout (30 s). Step limits: render 110 s, screenshots 80 s, Lighthouse 120 s each.
- **Bounded waits** (`render.js waitSettled`): navigation waits for `domcontentloaded`; the `load` event gets at most 10 s and a quiet network 4 s more (only when `load` fired), so a tracker
  or embed that never answers cannot use up a step. The axe scan has its own 40 s limit: when it runs out, the rest of the render is kept. Screenshots: a view not finished by the step's
  deadline is given up and reported, the views already taken are kept (`captureScreenshots({ parallel, deadline })`). Lighthouse runs with `disableFullPageScreenshot` (its embedded screenshot was never used).
- **Recreate** (`recreate/index.js`): the sweep is a `background` step (`after: 'inspect'`, `join: 'responsive'`): it always runs next to the asset downloads, and next to generate / build
  (`browser: true` steps) only when a second browser fits in memory (`roomForSecondBrowser`: 900 MB beyond the 300 MB kept free; `SAS_RECREATE_OVERLAP=1` / `0` decides it for a machine whose capacity is
  known); otherwise it is awaited first. A background stage gets its own `{ stepDeadline, progress }` as its second argument. The generate step takes the pages swept so far (`ctx.sweepPending(count, ms)`,
  the first `REFINE_PAGES` = 3, waits ≤ 75 s) instead of the whole sweep; generate's limit 3 → 4 min. A failing step ends a running sweep before the workspace is discarded. `report.timings` = ms per step + `total`.
- **Progress** (`jobs/manager.js progressTracker`): steps may overlap, so the percentage is the weighted sum of every step's own fraction and the step shown is the earliest one still running; only the
  shown step's messages are displayed. The step lists are ordered by where a step is awaited (Analyze: screenshots after links; Recreate: sweep after preview), so the app's list only moves forward.
- **Measured on panscience.xyz** (6 pages, through the API on a scratch data dir, an 8 GB machine with 1–1.7 GB free): Analyze 82 s → **68 s**, no errors (render + screenshots + robots side by side,
  Lighthouse 29 + ~18 s); Recreate ~570 s (4b.9) → **529 / 559 s**, same results (fidelity 80, visual difference 79, between widths 74–75, hover 23–24, loops 34–36); re-audit 163 / 169 s (its motion step
  is ~115 s of that). The Recreate gain is small on this machine: with ~1 GB free the sweep only overlaps the asset downloads. Lighthouse's mobile accessibility score moves between 91 and 96 from run to
  run on this site with the old code too (which elements are revealed when axe runs), not because of this work.
- **A run on a slow connection** (plain requests took 6–12 s, ~450–700 MB free, overlap forced): the job still finished (510 s) and nothing timed out, but with less: 3 of 6 pages captured (inspect 251 s; the
  other pages link to the live site, with a warning), asset downloads 174 s instead of 12 s, the sweep captured nothing in its 4 minutes (warning), fidelity 76. So the overlap itself is **not measured yet**
  on a machine with memory to spare, and on a slow network Recreate degrades (fewer pages) rather than fails.
- **Shared cache of static files** (`audit/sharedCache.js createSharedCache()`, one per Recreate job: `ctx.netCache`, created in the inspect step, used by the capture of every view and page and by
  the sweep, removed at the end of the job; `SAS_SHARED_CACHE=0` turns it off): browser contexts share nothing, so each of the 11 contexts of a page (4 views + 7 sweep widths) downloaded the page's
  stylesheets, scripts, images and fonts again. Now the first context that asks for a file loads it **itself, as before** (the browser's own request through the egress proxy; the cache never fetches
  anything), the response is kept (`requestfinished` → body to a temp folder, never the workspace) and every other context is answered with it (`route.fulfill`); a context asking while the first is still
  loading waits for it (≤ 15 s, then loads it itself). Shared: GET requests for stylesheet / script / image / font that answered 200. Never shared: documents and frames, XHR / fetch, media and range
  requests, redirects and what they lead to (the browser does not route a redirect target), errors, responses with `Set-Cookie`, `no-store`, or a `Vary` other than Accept / Accept-Encoding / Origin;
  25 MB per file, 500 MB per job. A failed or abandoned load is left to each browser. `report.sharedCache` = { requests, served, servedBytes, loaded, stored, storedBytes, notShared, failed, files }.
  A first version fetched the file from Node (`route.fetch`): one connection per file instead of the browser's multiplexed one made the first load slower (2.7 s instead of ~1 s per view), so it was replaced.
- **Where a capture's time goes** (`views[v].timing` in `capture/<slug>/<view>.json`: ms for document, load, idle, scroll, snapshot, motion, screenshots; the sweep's widths have `timing` { load, scroll, screenshot }):
  panscience `/`, desktop view, normal network: document + load + idle ~4–5 s, the scroll-through 8–11 s, motion probing ~11 s, snapshot + screenshots ~3–4 s. So on a normal network the network is a small
  part of a capture, and the earlier guess that the 11 loads per page are the main cost was wrong there; the scroll-through and motion waits are kept as they are (they are what makes the capture accurate).
- **The cache, measured** (capture of views + sweep, same code path as the steps; slow connection = Chromium's network emulation "Fast 3G", 1.6 Mbit/s and 562 ms latency, in the measuring script only):
  normal network, panscience `/`, alternating runs: 63.2 s without, 60.4 s with (the first pair, 80 vs 94 s, was machine noise: free memory 970 vs 394 MB); pictures as equal as two runs without the cache
  are to each other. Slow connection: panscience 2 pages 138.6 → 130.1 s (network part of the sweep 103 → 57 s summed over its contexts); parchaa.com `/` 116.4 → 102.6 s (sweep 66.7 → 54.1 s), and the
  capture without the cache was **incomplete** at the laptop width (5 images aborted; header, blog list, testimonials and call-to-action missing in the screenshot) while the one with it was complete,
  same DOM (947 nodes) and height. So the gain is small on a fast connection, and on a slow one it is completeness more than seconds. One run per case: the direction is clear, the numbers are not exact.
- **Full Recreate with the cache** (panscience.xyz, 6 pages, API on a scratch data dir): **446 s** (529 / 559 s before it, ~570 s in 4b.9), same results: fidelity 80, visual difference 79, between widths 74,
  6 / 6 pages, 42 / 42 widths, hover 24, loops 35, checklist motion rows as before. 2915 static requests, 2710 answered from the cache: 205 files (11 MB) loaded once instead of 142 MB downloaded again.
  That run also had more free memory (1.2 GB: four views at a time), so not all of the gain is the cache's.
- **The asset step reads the cache** (`cache.lookup(url)` → the stored response; `assets/download.js fromCache`, `assets/index.js cachedSheet`): a file the job's browsers already loaded is taken from the
  cache instead of being downloaded a twelfth time, and passes the same checks as a download (size limit of its kind, not a web page in place of a file, content hash, SVG sanitizer afterwards). Anything
  the cache does not hold or that fails a check goes to the normal SSRF-guarded download, which decides and reports as before; cross-origin stylesheets are read from the cache the same way.
  `report.assets.fromCache`, `report.sharedCache.reused / reusedBytes`. panscience.xyz: 189 of 207 files from the cache, the step 7.6 s (11.6–14.2 s before); the 207 files are **byte-identical** (same sha256
  set) to a run that downloaded them from Node (the only differences: S3 signed URLs whose query changes per run, and which of two identical icons gives the file its name). The step that took 174 s on
  the slow connection is the one this is for; not measured again on a slow connection.
- **Analyze uses the cache too** (`audit/index.js`: one cache per analysis for the homepage render, the crawl's renders and the three screenshot views; `renderHome / renderHtml / captureScreenshots({ cache })`;
  closed with the browser, before Lighthouse, which runs in its own Chrome and is not touched). The homepage is opened in four contexts and its static files are downloaded once (test). On panscience.xyz
  the analysis took 80 s with no errors (68 s and 82 s in earlier runs): no measurable gain on a normal connection, the same picture as for Recreate; the point is the slow connection.
- **Full chain after both** (panscience.xyz, new project, API on a scratch data dir): Analyze 80 s, Recreate **487 s** (inspect 170, assets 7.6, sweep 150, generate 77, build 37, responsive 54), re-audit 164 s;
  fidelity 80, visual difference 78, between widths 74, 6 / 6 pages, 42 / 42 widths, 816 asset references verified, safety passed. The homepage's laptop view scored 77 instead of 86 in this run: the
  capture found its scroll-reveal content in another state (timer-driven reveals, the known run-to-run variance), every other page and view is within one point.
- **Open / next candidates**: the re-audit's motion step measures its ≤ 6 pages one after the other (~20 s each). Jobs still run one at a time under the global lock. What is left of a Recreate is the
  scroll-through (8–11 s per context), the motion probing and the sweep's seven page loads per page; shortening those changes what is captured and needs the user's decision.
- Tests: `shared-cache.test.js` (what may be shared; four contexts load a static file once while documents, API calls, redirects, cookies, `no-store`, `Vary: User-Agent` and errors still go to the server; an
  address the policy blocks is never reached; the size limit; a slow first load does not hold the others; the temp folder is removed; an analysis opens the homepage four times and downloads its static files once),
  `recreate-assets.test.js` (with the network closed a cached file is saved, an error page or a lost cache file goes to the download; the pipeline takes its files from the cache), `perf.test.js` (parallelism by memory, `stepBudget`, overlapping progress, an analysis of a local page whose image and frame never answer is complete, screenshot views kept at the deadline),
  `recreate-jobs.test.js` (the sweep runs next to the later steps and is awaited by `responsive`; short of memory it is finished before generate; a failing sweep is a warning; a failing step ends a running sweep).

### Complete report (UI redesign task, after 4b.1)
"Generate report" (top bar, when a project is selected) builds one report of the **original site (OLD panel), the recreated site (NEW panel) and the fix checklist**, shows it in a modal (animated steps, then a preview) and offers
**Download PDF** (made by the server, direct download, no print dialog), **HTML** (self-contained, no script, no external request) and **JSON** (the complete data), plus Regenerate.
- API: `GET /api/projects/:id/report[?format=html|pdf|json][&download=1]` (`routes/report.js`; built on request from what is stored, nothing is kept; CSP `default-src 'none'; img-src data:; sandbox`, no-store).
  The PDF (`report/pdf.js`) is the HTML report printed by the app's Chromium (A4, print media, page numbers in the footer, one at a time, no network); the print CSS lets cards break across pages, so there are no blank gaps (5 pages for a 6-page site, pages 85–100 % full).
- `server/src/report/collect.js` (project, latest analysis → `audit` incl. `audit.recreate` = fix checklist, latest completed recreate report, small WebP thumbnails: original first screens from the analysis, recreated pages and the
  visual-diff heatmap from the recreate folder), `report/render.js` (`renderReportHtml`; every value from the sites goes through `esc()`). The report is short on purpose and written for a client: numbered sections, a summary of plain sentences, then **At a glance** charts (inline SVG / CSS, no script):
  Lighthouse scores original vs recreated (grouped bars), SEO/AEO/crawl checks (donut), fix checklist (donut), fidelity by page (bars with the threshold line); small screenshots (desktop ~220 px, tablet ~115 px, phone ~70 px, in one row, original and recreated);
  **Original site** (performance rings + metrics, platform and weaknesses, SEO/AEO/crawl **issues only** with the passing count, broken links + accessibility, manual rebuild); **Recreated site** (fidelity / visual difference per page, layout between
  widths as a bar chart, built / fixed / to review, manual rebuild, warnings); **Fix checklist** (Lighthouse before → after, the status counts, "Needs attention", the list of fixed checks). Long lists show 8–20 rows and say "+N more in the JSON download".
  A project without analysis / recreate still gets a report that says so.
- Screenshots of the analysis are taken with `animations: 'allow'` (`audit/screenshots.js`): `'disabled'` reset running animations and stacked every word of a cycling headline on top of each other (seen on panscience.xyz). Analyses from before this need Analyze again.
- Client: `components/report/ReportModal.jsx` (+ css), `api.getReportHtml/getReportJson/getReportPdf`. Tests: `server/test/report.test.js` (404, empty project, all sections + HTML escaping, download/JSON, thumbnails, a real PDF).

### Phase 4b plan (approved) — branch `phase-4b` (worktree `../Website-Audit-4b`)
Decisions: CSS-first motion + one small generated `motion.js` (IntersectionObserver, safety-gated); sweep widths 320/480/600/900/1024/1280/1920; order:
4b.6 + 4b.7 (responsive + visual diff) → 4b.1–4b.5 (motion capture/emit, all stacks) → 4b.8–4b.9 (re-audit/UI, real-site verification). Everything general, nothing site-specific.
Same workflow: one sub-step at a time, WIP commit, wait for "next"; never push.

| Step | Scope | Status |
|---|---|---|
| 4b.6.1 | Responsive sweep: measure the original vs the recreate at the 7 sweep widths (`report.responsive`) | ✅ WIP |
| 4b.6.2 | Corrections driven by the sweep (breakpoint refinement, fluid type, phone shrink, width fixes) | ✅ WIP (long tail open, see below) |
| 4b.6.3 | A 4th captured view (laptop, 1024) between 768 and 1440 (IR views 3 → 4) + continuous overflow penalty | ✅ WIP |
| 4b.6.x | Sweep time budget / pages lost in **inspect** | ✅ Done in 4b.9 (panscience captures all 6 pages in every run; a page that stalls is abandoned 5 s before the step limit instead of failing the job) |
| 4b.7 | Visual diff score (perceptual SSIM-style diff, bands, heatmaps, NEW-panel cards) | ✅ WIP |
| 4b.1 | Motion capture: hover / focus (`capture/interactions.js`, `motion.json`) | ✅ WIP |
| 4b.2 | Scroll-reveal capture: from-state, duration, easing, delay, stagger, trigger (`capture/reveal.js`, `motion.json.reveal`) | ✅ WIP |
| 4b.3 | Continuous motion capture: CSS animations / WAAPI loops, script-driven loops (`capture/loops.js`, `motion.json.loops`) | ✅ WIP |
| 4b.4 | IR `motion` (hover, focus, scroll reveal, loops) + plain-HTML emission: CSS rules, generated `js/motion.js`, safety profile, preview | ✅ WIP |
| 4b.5 | The same motion in React + Vite / Next.js / MERN (ship `motion.js`, safety, equivalence ignores its classes) | ✅ WIP |
| 4b.8 | Re-audit rows (Motion category), NEW-panel Motion card, report row, hover control step | ✅ WIP |
| 4b.9 | Real-site verification (parchaa.com + panscience.xyz, all four stacks), calibration, docs | ✅ WIP |

4b.6.1 details (**measures only, never fails a job**):
- Last Recreate step `responsive` ("Checking responsive layout", `recreate/responsive.js`). Default job budget **10 → 12 minutes** (`recreateBudgetMs`): the 2 extra
  minutes are the sweep's, the other steps' limits are unchanged. No time left (< ~33 s) → skipped with a warning; the homepage is measured first, other pages only while one more fits.
- Original side (`capture/sweep.js`): each page is screenshotted at every sweep width the same way as the 3 captures (`settle`: lazy content, scroll-reveal pinned), full page
  capped at 8000 px, DPR 1, widths < 600 as a mobile viewport (both sides alike), 4 contexts at a time → `capture/<slug>/sweep/<width>-full.webp`; height and horizontal `scrollWidth` recorded.
- Recreated side (`verify/responsive.js`): `dist/` served locally and rendered at the same widths, JavaScript off, other origins aborted → `fidelity/<slug>/sweep/<width>-full.webp`. HTTP ≥ 400 = error for that width.
- Per width: `visual` (the fidelity check's 96 px similarity) 65 % + `height` score 35 % (`1 − 4·|ratio − 1|`), −15 for a horizontal overflow the original does not have. `low` = score < 80
  (`FIDELITY_THRESHOLD`; since 4b.7: visual < 65) or a new overflow; flags `taller` / `shorter` / `overflow` / `visual`. Thresholds are first guesses to be calibrated on real sites (4b.9).
- `report.responsive = { status: done|skipped|failed, widths, threshold, score, byWidth, driftCount, measured, worst[], pages[{ path, outPath, slug, score, drift[], widths{} }], skipped[] }`
  + warnings. Nothing measured → `failed` (+ warning). Tests: `recreate-responsive.test.js` (scoring, summary, original capture, the step on a local site: faithful copy ≥ 95, fixed-width container flagged as overflow at 320).

4b.6.2 details (the sweep now **decides**, still never fails a job; the 4b.6.1 step was split in two):
- **Steps** (7 now): `inspect` → **`sweep`** ("Capturing more widths", `recreate/sweep.js`: the original at the 7 widths, `capture/sweep.json`, `ctx.sweep`; max 4 min but never into
  the time the later steps need — `jobDeadline − LATER_STEPS_RESERVE`) → `assets` → `generate` (now also refines) → `build` → `preview` → **`responsive`** (renders `dist/`, compares with the stored
  originals, `report.responsive`, max 90 s). `sweep` and `responsive` are `optional` in `STEPS`: out of time, a timeout or an error is a warning, never a failed recreate.
- **Refinement** (`verify/refine.js`, in `generate`, after the fit pass, ≤ 90 s, first 3 pages): variants of `css/site.css` are served as an override of that one file and scored at the sweep widths
  with the 4b.6.1 score; nothing is rebuilt and the IR is not touched until a variant wins.
  1. *Breakpoints*: tablet ∈ {899.98, 1023.98, 1279.98, 1439.98} judged on 900 / 1024 / 1280, mobile ∈ {479.98, 599.98, 767.98} on 480 / 600 (one alternative per outcome); the site's own
     value (`source: 'site'`) is replaced only when an alternative scores ≥ 3 points higher → `ir.breakpoints = { …, source: 'sweep' }`.
  2. *Fluid type* (`ir/fluid.js`): font size / line height whose 3 captured px values lie on one line over the width (±max(0.5 px, 2 % of the range)) become `clamp(min, calc(a + b vw), max)`;
     the stepped overrides it replaces are dropped; taken only when the whole sweep scores ≥ 1 point higher.
  3. *Phone shrink*: mobile font sizes ≥ 24 px as `min(X px, Y vw)` (smaller than 375 px screens), judged on the 320 px width, ≥ 1 point.
  Result in `report.generate.responsive` (candidates with scores, chosen values, renders, `stopped`) and `report.responsive.refined`. The IR carries the result, so every stack gets it.
- **General fixes found by the sweep** (`ir/styles.js`): an absolute / fixed box is no longer written with a px width when its two insets stretch it (a fixed header with side margins) or when it is as wide as
  its containing block (`width: 100%`); form controls and buttons with a px width get `max-width: 100%` (like images).
- **Real sites** (authorized, through the API, temp data dir `C:\sasd`; a short path is needed: the scratchpad path exceeded Windows' 260 characters):
  parchaa.com — own tablet breakpoint (1319.98) scored 54.1 against 77.7 for 899.98, mobile 767.98 → 599.98 (58.3 → 66.5); fidelity 88–89 as before (re-run after all fixes: 88; shrink 70.7 → 68 correctly rejected). panscience.xyz — tablet 1024.98 → 899.98 (54.9 → 69), mobile kept;
  fidelity unchanged (80). No page of either site has a fluid-type rule on one line, so fluid type and phone shrink were not adopted there (shrink 76.3 vs 76.3).
- **Still open (not breakpoints)**: parchaa `/` at 900 px: the original shows its stacked (tablet-style) layout, the recreate squeezes the 1440 layout (sections wrap letter by letter): a layout at that width
  needs its own captured view (a 4th view between 768 and 1440); the breakpoint search only picks the lesser evil. panscience `/` and `/ventures` at 320 px: still a horizontal overflow (document 344 px wide)
  although the causes found (a 375 px wide absolute box, a nowrap 38 px heading, a 312 px button) were fixed one by one — the score is all-or-nothing on overflow, so shrink was not adopted. The known cases
  from 4a (parchaa `/solutions` mobile view alignment, panscience `/ventures` tablet/desktop drift) are alignment / layout-at-width problems: not solved here; `/solutions` is not in parchaa's default page set.

4b.7 details (perceptual visual diff):
- **Metric** (`verify/visualDiff.js`, `visualDiff(original, generated, { heatmap })`): both full-page screenshots scaled to the same width, compared block by block on luma (SSIM: mean, contrast, structure)
  times a mean-colour factor (a hue or image that is wrong counts although the brightness is alike), at two scales: **detail** (8 px blocks at 384 px wide, after a sigma 2 blur so text lines a few px
  apart are the same text) and **layout** (4 px blocks at 96 px wide, forgiving about shifts), 50/50. Rows only one page has count as different (a wrong page height costs). Result 0–1, `scales`,
  10 `bands` top to bottom (fractions of the page, score each), `worst` bands (< 0.7), `heightOnlyOne`, and a heatmap WebP (red = differs).
- **Where it is used**: *fidelity* keeps its formula and threshold 80 (old colour-distance `visual`, so numbers stay comparable with earlier phases) and **adds** `views[v].diff`
  (`score` 0–100, `scales`, `bands`, `worst`, `heatmap` = `fidelity/<slug>/<view>-diff.webp`), `pages[].diff`, `fidelity.diff` (`score`, `threshold` **65**, `status`, `lowPages`; `flagDiff`) + warnings.
  The *responsive sweep* (and its refinement) now uses the perceptual score as its visual term; a width is drift when visual < 65, the height is off, or a new overflow appears (`low = flags.length > 0`;
  the 80 threshold of 4b.6 was too strict for the new scale: 34 of 42 widths flagged). `verify/equivalence.js` (stack vs HTML build, ≥ 97 % pixels) still uses the old `visualSimilarity` on purpose.
- **Calibration** (111 real pairs from parchaa.com and panscience.xyz, fidelity views + sweep widths): the perceptual score ranks like the old one but is stricter (mean 0.695 vs 0.847): near-identical pages
  0.95–0.999, decent 0.75–0.9, visibly broken ≤ 0.55 (e.g. parchaa `/` at 900 px: 0.52). Thresholds are first guesses to be confirmed in 4b.9. ~0.1–1 s per view.
- **Bug found by the heatmap and fixed (general)**: the fidelity render and the sweep render took a full-page screenshot without loading `loading="lazy"` images, so photos below the fold were flat holes
  and the recreate was scored down for pictures it has (since 4a.6). `layout.js loadLazyImages` (eager + decode, ≤ 6 s) now runs before the fidelity screenshot and in the sweep render (the fit pass is unchanged).
- **API/UI**: `GET /api/projects/:id/recreate/:recreateId/fidelity/:slug/:file` (`{desktop,tablet,mobile}-{full,diff}.webp`). NEW panel report card: **Visual difference** (per page: band strip of the worst view,
  score, heatmap link per view, low ones in warn colour) and **Between the captured widths** (sweep score per width, drift count, breakpoints the sweep adjusted, fluid type). Tests: `recreate-visualdiff.test.js`.

4b.6.3 details (a 4th captured view + continuous overflow penalty; asked for before 4b.7, done after it):
- **Views** (`recreate/views.js`): `RECREATE_VIEWS` = desktop 1440, **laptop 1024**, tablet 768, mobile 375 (laptop: not a mobile viewport, 768 px high). `VIEW_IDS` (ir/tree.js), the capture (`capture/index.js`, 4 contexts per page
  in parallel), the fit/fidelity renderer (`verify/layout.js`) and the first-screen heights of the loading fixer (`fixers/perf.js`) use it. The analysis screenshots and the stack **equivalence** check keep the original three
  views (`audit/screenshots.js VIEWS`). A page without a laptop capture works as before (the cascade skips a missing view); the desktop view is still the only required one.
- **IR / CSS**: rules get `parts.laptop`; each view's styles are a diff against the next wider one, so the media queries stack: `@media (max-width: laptop)`, then tablet, then mobile (`emit/css.js` writes one per view,
  widest first; a laptop rule without a laptop breakpoint falls back to `DEFAULT_BREAKPOINTS.laptop` 1279.98). `ir.breakpoints = { laptop?, tablet, mobile, source }`; every stack gets it (all use `emitCss`).
- **Breakpoints from the site** (`pickBreakpoints(queries, { laptop })`): laptop = widest query boundary in [1024, 1440), tablet in [768, 1024), mobile in [375, 768) (defaults 1279.98 / 1023.98 / 767.98). A builder with a tablet variant
  at 810–1199 (Framer) now maps exactly: the 1024 capture is its tablet layout up to 1199.98, the 768 capture its phone layout up to 809.98. Without a laptop capture: the old rule (tablet = widest in [768, 1440)).
- **Fluid type / refinement**: `fluidValue(…, { laptop })` requires the laptop value on the line too; `refine.js` searches the laptop boundary on 1280 (alternatives 1279.98 / 1439.98), the tablet boundary on 900
  (899.98 / 1023.98) and mobile on 480 / 600; without a laptop view the 4b.6.2 search is unchanged.
- **Overflow penalty is continuous** (`verify/responsive.js compareWidth`): `overflowPx` = how far the recreate sticks out sideways beyond what the original does (minus 2 px slack); penalty = 15 × min(1, overflowPx / (0.15 × width)),
  at least 1 point, so a partial fix shows in the score (the 320 px overflow of panscience could not show progress before). `overflow` stays a drift flag.
- **Bug found by the extra view**: the loading fixer looked up the first-screen height per view from the three analysis views; a `laptop` view had none, so no image was ever lazy (found by the pipeline test).
- **Real sites** (parchaa.com, 6 pages, default limit, API on `C:sasd`): homepage visual score (perceptual, ×100) at 900 / 1024 / 1280 px **48 / 48 / 48 → 81 / 84 / 74**, contact 64 / 67 / 68 → 89 / 97 / 84, a blog page
  47 / 46 / 54 → 55 / 99 / 56; fidelity 88 → 91, visual diff 86; the sweep reached all 6 pages; breakpoints now laptop 1319.98 (the site's), tablet 809.98 (the site's), mobile 599.98 (sweep). Still weak: the blog pages at 900 / 1280 (~55) and
  the phone widths 480 / 600 of the blog pages (shorter / taller): between 375 and 768 there is still only the 375 capture.

4b.1 details (hover / focus capture - capture only, nothing is emitted yet):
- **Where**: desktop view only, in `captureView` after the screenshots and the DOM snapshot (`capture/interactions.js captureInteractions`), budget 8 s per page (`inspect.js MOTION_BUDGET`; skipped when the inspect
  step has no time to spare). Output `capture/<slug>/motion.json`; `report.pages[].motion` = counts, `report.motion` = { status, pages, hover, focus, rules, errors, notProbed }.
- **Two paths, both general**: (1) *CSS-first* - every `:hover` / `:focus` / `:focus-visible` / `:focus-within` / `:active` rule of every readable stylesheet, as authored (`rules[]`: selector, state, media condition, declarations;
  unreadable cross-origin sheets are counted - the assets step downloads them); (2) *probe* - the mouse moves onto the element and computed styles are compared with the state just before, so a hover driven by a script
  (builder runtimes, `mouseenter` handlers) is found with or without a rule.
- **Probe details**: candidates = links, buttons, fields, roles, `tabindex`, then `cursor: pointer` tops, then plain transition hosts (not inside a chosen element, 3 levels); equal elements (tag + role + classes + parent) are probed
  3 times (`groups[]` counts the rest); `limit` 40. Compared: ~45 visual properties (colour, background, border, outline, shadow, opacity, transform/translate/scale/rotate, filter, text-decoration, weight, letter-spacing, fill, stroke,
  display, visibility, cursor) for the element, its ::before / ::after (+ size / position) and its descendants (3 levels, ≤ 24). Each entry: `path` (the snapshot's `body>div:1>a:2`, so a later step finds the IR node),
  `changes {prop: [from, to]}`, `pseudo`, `kids[{path, changes, transition}]`, `transition` (hover-in; `transitionOut` when different), `layout` + `rect` delta (from offset* boxes: a transform is not a layout change), `domDelta`.
  Covered elements (something on top at the pointer) are skipped and counted; no-change elements are counted, not listed.
- **Scroll is not hover** (found on panscience.xyz: scroll-reveal hosts looked like 1.4 s opacity hovers): the rest state is read with the mouse out, after the scroll, and re-read until it holds still; an element already on screen is not
  scrolled at all. **Focus**: Tab from the top of the page (the Tab starting point is reset by focusing the body); at each stop the focused state is compared with the same element **blurred** (same scroll position, same reveal state);
  the browser's own default ring (`outline-style: auto`) is not a change. Hover may use 60 % of the budget, focus the rest; up to 80 Tab stops (non-probed stops are skipped cheaply).
- **Tests** (`recreate-motion.test.js`, 8; fixture in `recreate-capture.test.js`): link colour + transition, card shadow/transform + a fading child, an underline pseudo-element, no-change and covered elements, 8 equal elements → 3 probed,
  a script-only hover (no rule) and a scroll-reveal host that must not be listed, custom focus style vs default ring, rules with media, paths in the snapshot, the time budget. Fixture: `:hover` rule on the nav links and `hover.js` (script-only
  hover on the logo, the case only the probe can find).
- **Real site** (panscience.xyz, 6 pages): rules 20 per page (120), hover found on the nav links (colour 0.2 s, 3 links), "Contact Us" (transform 0.25 s), the scroll-reveal false positives gone; the site has no custom focus styles
  (every Tab stop is the browser's ring). Probing was slow there (only ~6 probes in 8 s) before the "do not scroll what is on screen" change; not re-measured on the real site after it. parchaa.com (an earlier run, before the scroll fix:
  118 hover entries, 111 focus entries, 99 rules over 5 pages) is verified in 4b.9. That panscience run took the whole 12-minute budget (the final responsive step skipped 4 pages): the cost of motion capture itself should be about
  8 s × pages; check the total again in 4b.9.

4b.2 details (scroll-reveal capture - capture only, nothing is emitted yet):
- **Where**: `capture/reveal.js` (the reveal tracker moved here from `capture/index.js`; `settle(page, view, cap, { observe })`). Desktop view with motion budget only (`observe`): other views only pin the end state as before.
  Result in `capture/<slug>/motion.json` → `reveal = { version, elements[], groups[], stats }`; `report.pages[].motion.reveal` = stats, `report.motion.reveal` = totals (revealed, declared, sampled, unmeasured, replay, timed, groups, staggered).
- **Two measurement paths, both general**: (1) *declared* - `getAnimations()` is read before the tracker finishes the animation: CSS transitions, CSS animations, Web Animations API give exact duration, delay, endDelay, easing and
  keyframes (a keyframe's first/last transform and filter are resolved to matrices; they override the state read around it); (2) *sampled* - a rAF recorder reads opacity + transform of every element that starts hidden
  (≤ 400 elements, ≤ 90 samples), so effects driven by script (GSAP, framer-motion JS, rAF loops) get a duration (to 99 % of progress) and an easing fitted to a cubic-bezier (named easings first, then a local search; `error` = RMSE).
- **Element**: `path` (snapshot path), `tag`, `text`, `rect`, `from` / `to` { opacity, transform (matrix), filter, `motion` { translate, scale, rotate } }, `timing` { source: transition | animation | waapi | sampled | unmeasured, duration, delay (null when sampled),
  easing { css, fit: declared | sampled, bezier?, error? }, `parts` when opacity and transform have their own timing }, optional `keyframes` (> 2), `trigger` { kind: scroll | timed, step, topBefore, topAfter } (position of the element's top as a viewport fraction
  before / after the scroll step that revealed it; a 'timed' one was already on screen: rotating headlines, timers), `replay` (hidden again when it leaves = the reveal repeats), `group`, `offsetMs` (start after the group's first).
- **Groups / stagger**: elements of one parent revealed by the same scroll step; singletons regroup by grandparent + same from/duration/easing (cards of a grid in separate columns). Stagger = ≥ 3 members whose consecutive start
  times (animation start + delay, or first sampled change) differ by a constant step (|step| ≥ 15 ms, jitter ≤ max(30 ms, 35 %)); `group.stagger = { stepMs, jitterMs, order }`.
- **Limits (by design)**: only opacity-hidden reveals (same as the end-state pinning); effects that run at page load (installed after load + idle) and looping/continuous motion (4b.3) are not covered; trigger is bounded by the scroll step (85 % of a viewport), not exact.
- **Cost**: elements animated by script are waited for (≤ 1.5 s per scroll step, as before); declared animations are finished at once. Fidelity unchanged.
- **Real site** (panscience.xyz, 6 pages, API on `C:sasd`): 130 reveals (124 declared, 6 sampled), 59 groups, 9 staggered; every section uses `700 ms cubic-bezier(0.16, 1, 0.3, 1)` from opacity 0 + translateY(16px), list items staggered ~50-70 ms
  (CSS transitions started one by one by a script, found through the start times); hero headline words (timer-driven, sampled, trigger 'timed') flagged; `/media` has no reveals. Fidelity 80, as before. parchaa.com is covered in 4b.9.
- **To verify in 4b.9**: the `timed` trigger kind and the ≥ 3 members stagger rule were added after the panscience run (unit tests only); re-run on panscience.xyz / parchaa.com.
- Tests: `recreate-reveal.test.js` (bezier/easing fit/matrix/path order; grouping + stagger; CSS transition, CSS animation, WAAPI, rAF-driven and a staggered list on a local page; no observe = no events), plus the services fixture in `recreate-generate.test.js`.

4b.3 details (continuous motion capture - capture only, nothing is emitted yet):
- **Where**: `capture/loops.js`, desktop view with motion budget, read **after the DOM snapshot and before the screenshots** (a screenshot with `animations: 'disabled'` cancels infinite animations). ~2.7 s per page outside the hover/focus budget.
  Result in `capture/<slug>/motion.json` → `loops = { version, loops[], stats }`; `report.pages[].motion.loops` = stats, `report.motion.loops` = totals (css, waapi, script, scrollLinked, paused, patterns{}).
- **Declared** (`scanAnimations`): `document.getAnimations()` minus CSS transitions: animations with iterations > 1 (usually infinite) or on a scroll/view timeline. Exact timing (duration, delay, iterations, direction, fill, easing, playbackRate, playState), keyframes as authored
  (`translateX(-50%)` keeps its %), pseudo-element target (`::after`), `inStylesheet` (its @keyframes is in a readable stylesheet = already carried by the recreate's CSS; false = WAAPI / unreadable sheet, to be rebuilt by a later step).
- **Script-driven** (`findScriptLoops`): computed transform / opacity / rotate / translate / scale of all elements (≤ 6000) compared 450 ms apart; changing ones that have no animation object are recorded per frame for 2.2 s (≤ 40, biggest first)
  and analysed (`analyzeSeries`): `spin` (deg/s), `drift` (px/s, wrap-around distance, period), `oscillate` (period, amplitude), `ramp` / `move`. SMIL `<animate>` and canvas / video are not visible to either path.
- **Pattern** (`classifyKeyframes`): spin, sway, marquee / ticker (one way, ≥ 20 px or 10 %), float / sway (alternate or a round trip back to the start, ≥ 4 px), pulse (scale), blink (opacity), dash (stroke-dash*), background-scroll,
  cycle (keyframes with holds: word / slide rotators), jiggle, other. Each loop: `path`, `pseudo?`, `source` (css-animation | waapi | script), `name`, `pattern`, `params`, `timing`, `keyframes`, `rect`.
- **Real site** (panscience.xyz, 6 pages): 32 CSS loops + 2 script; hero word rotator (cycle, 6 words with 8.77 s keyframes), drifting marquees (`psi-drift-l/r`, translateX ±50 % linear 36 / 52 s), spinners (80 s / 60 s), dashed spokes, node float (6 px round trip),
  blink dot; all `inStylesheet`. Fidelity 80, 0 errors, same page set as 4b.2. Note: the first real run was classified before the cycle / round-trip rules; re-classifying the saved keyframes gives cycle for the rotator and float for the nodes (the page itself was not re-run).
- Tests: `recreate-loops.test.js` (classification incl. cycle and round trip, series analysis, a local page with CSS spin / marquee / pulse / pseudo / paused / finite / WAAPI float / three script loops and controls: one-shot animation and transition are not loops),
  plus the services fixture's spinner in `recreate-generate.test.js`.

4b.4 details (IR `motion` + the plain-HTML build; the other stacks follow in 4b.5):
- **IR** (`ir/motion.js`, called in `generateStage` right after `prepareSite`): `capture/<slug>/motion.json` is matched to the merged tree by the desktop snapshot path (`tree.js` keeps it as `cpath`; a wrapper removed by `cleanTree` hands its path
  on as `cpathAlt`). A matched element gets motion tokens in ONE attribute, `data-motion="h1 rv r2 d70 rp"`; equal effects share a token, so the CSS has one rule per distinct effect and no original class name is needed.
  `ir.motion = { version, hover[], focus[], reveal[], delays[], loops[], script }` (absent when the page has no usable motion); `report.generate.motion` = per-kind counts, skipped reasons, `script`.
- **Hover / focus** (CSS only): `[data-motion~=hN]:hover { changed values }` (+ `::before/::after`, + descendants through `hNkM` tokens) inside `@media (hover: hover)`; focus as `:focus-visible`. Values are the captured *end* values (the element's base style already
  carries the transition). Skipped and counted: effects that add or remove DOM (a script), effects with no usable value; a `url()` that was not downloaded is dropped, never linked live.
- **Scroll reveal** (`scroll` triggers only; `timed` ones - rotating headlines, timers - are skipped): the from-state is written with the individual `opacity` / `translate` / `scale` / `rotate` / `filter` properties relative to the element's own style, hidden under
  `.js-motion [data-motion~=rN]:not(.is-in)` and animated by `@keyframes m-rN { from {…} }` on `.is-in` (duration + easing from the capture, `animation-delay: var(--md)` from a `dNN` token = the stagger offset, `backwards` fill). Everything sits in
  `@media (prefers-reduced-motion: no-preference)`. The end state is never written: it is the element as styled.
- **`js/motion.js`** (`emit/motionScript.js`, one fixed ~1 KB file, the same for every site; written only when there are reveal effects, `<script src defer>` in each page's head): sets `js-motion` on `<html>` (so a visitor without script, or with reduced motion, sees
  the finished page), adds `is-in` on `[data-motion~=rv]` elements when 10 % is in view (rootMargin -8 % bottom), removes it again for `rp` elements. Hover, focus and loops need no script.
- **Loops**: a CSS animation whose `animation-name` the element's captured style already carries is counted as `carried` (nothing written twice); Web Animations and script-driven spin / oscillation are rebuilt as `@keyframes m-lN` + `[data-motion~=lN]`.
  Skipped with a reason: drift / marquee driven by script (needs duplicated content), scroll-linked timelines, pseudo-element loops not in the stylesheet, `url()` in keyframes, elements the IR does not have.
- **Safety / preview**: the safety gate has a `motion` profile (`verify/appProfiles.js`): exactly `<script src="(../)*js/motion.js" defer>` and no other script, and the only JavaScript file is `js/motion.js` (also sink-scanned). `report.outputs.html.scripts = true` when the build carries it; the preview
  (`routes/recreate.js latestBuild`, `jobs.js`, `reaudit/index.js`) then gets `script-src 'self'` and the app frames it with `allow-scripts`. The preview step also requests `js/motion.js`. Fidelity, the fit pass, the sweep and the stack equivalence render with JavaScript off,
  so their numbers do not depend on the script.
- **Other stacks (until 4b.5)**: they share the IR, the `data-motion` attributes and the stylesheet, so hover, focus and CSS loops already work there; they do not ship `motion.js`, so reveals never hide. Verified: React + Vite and Next.js exports of the panscience
  recreate are DOM-equal to the HTML build on every page and view (pixels 1.0).
- **Real site** (panscience.xyz, 6 pages): safety passed, fidelity 81 (80 before), 109 reveals mapped to ONE shared effect (700 ms `cubic-bezier(0.16, 1, 0.3, 1)`, translateY 16 px) with stagger delays (70 / 120 / 130 / 220 ms), 27 hover elements in 9 effects, 26 CSS loops carried;
  in a browser the pages start with all reveal elements hidden and none is left hidden after scrolling through, no page errors; React and Next exports equivalent; the re-audit ran against the scripted build (preview `scripts: true`).
- **Open**: `/ventures` and `/media` tracked 0 reveals in this run (10 on `/ventures` in the 4b.2 run): the reveal capture varies between runs there (check in 4b.9). Elements revealed on load (first screen) are not captured, so they have no entrance animation.
- Tests: `recreate-motion-ir.test.js` (applyMotion tokens / sharing / skips, the CSS, the script tag, safety profile, and a real browser: hidden only with script, shown on scroll, `rp` repeats, nothing hidden without script or with reduced motion); `recreate-generate.test.js` (pipeline on the
  fixture: tokens, CSS, script file, safety, preview count 7); the structure assertions there read the markup without the `data-motion` attributes.

4b.5 details (the same motion in the app stacks):
- **What ships**: when `ir.motion.script` is set, React + Vite, Next.js and MERN (its client) each carry the same fixed `js/motion.js` as a plain file from the site root (`public/js/motion.js`, built to `/js/motion.js`) and load it with a deferred script tag
  in every page's head: React/MERN through the page head string (`page-meta.json` → prerender), Next.js as `<script src="/js/motion.js" defer />` in each `page.jsx` (React only hoists *async* scripts, so it stays in place; the exported HTML has `defer=""`).
  Hover, focus and CSS loops already worked in every stack since 4b.4 (shared stylesheet).
- **Safety**: the `vite` and `next` app profiles also allow exactly `<script src="/js/motion.js">` (no `type`, no inline text); the file is sink-scanned like every other script of the build. No other change to the rules; MERN's server CSP is `script-src 'self'`.
- **Equivalence / hydration** (`verify/equivalence.js`): the DOM signature ignores `js-motion` (on `<html>`/`<body>`) and `is-in` in `class` values (an element whose only class is `is-in` has no class), so the script's own classes are neither a DOM difference nor a hydration change.
- **Real sites**: panscience.xyz recreate re-exported (fresh builds) as React + Vite, Next.js and MERN: DOM 6/6 identical, pixels 1.0, hydration 6/6 clean, safety passed, no warnings from the script; in a browser the three builds start with all 50 / 28 reveal elements hidden on `/` and `/approach/`
  and none left hidden after scrolling through, no page errors. Gotcha when re-testing: `POST …/export` returns the existing output recorded in the report, so removing `stacks/` by hand is not a rebuild (delete `outputs.<stack>` from the report/DB row first).
- Tests: the real-export tests of `recreate-react/next/mern.test.js` carry a reveal effect (IR with `motion.script`): script file and tag in the build, equivalence + hydration still clean, and in a browser under the preview's policy `<html>` gets `js-motion` and the heading in view `is-in`.

4b.8 details (motion in the re-audit, the NEW panel and the complete report):
- **Hover control step (4b.1 refinement, found by this step)**: after a hover shows a change, the mouse leaves and the state is read again (`interactions.js keepReverting`, one extra read per positive finding): a real hover effect reverts; a change that stays or goes on (an entrance animation, a timer, a
  loop that ran while the mouse was there) is dropped, counted in `stats.notReverted` (`report.pages[].motion.notReverted`). Judged part by part: the element's own changes, its pseudo-elements and each descendant are kept or dropped separately, so a looping child does not hide the card's real hover.
  panscience: the original's hover count went 31 → 24 (page-title labels and the hero heading were entrance animations).
- **Re-audit step `motion`** (`reaudit/motion.js`, between the Analyze steps and `compare`, weight 5, never fails a re-audit): the original's `capture/<slug>/motion.json` is read; each recreated page (≤ 6, 40 s each, 150 s total) is opened on the throwaway server (JavaScript on, only that origin
  reachable) and measured with the same probes as the capture (`capture/measure.js measureMotion`: scroll reveal, loops, hover; hover budget 10 s = a little more than the capture's 8 s, because the probes walk the candidates in the same order and a recreate that gets less time would look like it lost elements).
  `skip: ['motion']` leaves it out.
- **Rows** (category `motion`, label "Motion", between Best practices and Platform): `motion.reveal` (scroll reveals by count + typical duration), `motion.hover` (paired by tag + text, with how many have the same changed properties), `motion.loops` (paired by pattern + duration). The original has the effect, so
  reproduced ≥ 90 % = `pass`, 50-90 % = `open`, < 50 % = `regressed`; a kind the original does not have has no row. `checklist.motion = { pages, reveal, hover, loops (before/after), failed[], skipped[] }`, also in `audit.recreate.motion`; pages that failed or were skipped become a note.
- **NEW panel**: the recreate card has a **Motion** section (hover / focus / scroll reveal / loops counts, the generated script, what was not rebuilt and why, timed effects left to the page's own CSS); the Safety row says "only the generated reveal script" when the build carries `js/motion.js`.
  The fix checklist shows the Motion category like any other. The complete report (HTML / PDF / JSON) has a Motion row under "Built, fixed and left to review" and the Safety row names the script.
- **Real site** (panscience.xyz, new Recreate + re-audits): scroll reveal 81 of 94 (typical 700 ms, same as the original) = open; hover 23 of 24 = **pass** (the one missing is the home page's `Ventures` nav link); loops 26 of 34 = open (8 are dashed spokes inside an inline SVG, which is not part of the IR).
  Gotcha found on the way: with the first 5 s hover budget the recreate was probed only as far as 7 candidates and looked like it had lost 7 hover effects - budgets must not be shorter than the capture's.
- **Open / 4b.9**: reveal 81/94 (the rest are effects the recreate cannot rebuild: page-load entrances, script-driven); loops in inline SVG; `/ventures` and `/media` reveal capture varies between runs; re-verify `timed` / stagger rules and the Next `/` first-measure flake on panscience.xyz and parchaa.com.
- Tests: `reaudit-motion.test.js` (summaries, rows and thresholds, real measurement of an original and two recreates with other markup: same effects found / all lost, unmeasurable page, checklist category); `recreate-motion.test.js` (entrance animation is no hover, real hover kept, a looping child does not hide the card's hover, `keepReverting`).

4b.9 details (final verification on two real sites, all four stacks, and what it found):
- **Method**: fresh Recreate of each site with the final code (default page set, API on `C:\sasd`), the three app stacks exported from the saved IR, then every stack (HTML, React + Vite, Next.js, MERN client) served under the real preview policy
  (`servePreview`, `script-src 'self'` / hashes for Next) and measured with the re-audit's own probes (`reaudit/motion.js`) against the original's capture, plus a real-browser pass (reveal elements hidden at the start, none left hidden after scrolling through, no page errors).
  The HTML build also went through the normal automatic re-audit.
- **parchaa.com** (Framer; recreate 4b2bf82a, 6 pages): fidelity 91, visual difference 89, between widths 73. Original motion: 15 hover + 13 focus elements, 44 reveals tracked (41 started by scrolling into view; Framer drives them by script, so all are *sampled*, typical 1130 ms), 20 loops (19 script-driven, 15 of them spinners).
  Rebuilt: 15 hover (6 effects), 13 focus, 41 reveals (38 distinct effects, 4 repeat), 16 loops (script spins become CSS `@keyframes`); 4 script-driven drifts / moves are not rebuilt. Checklist (HTML): reveal 38/41 **pass**, hover 12/15 open, loops 16/20 open; Lighthouse mobile performance 48 → 70, SEO 92 → 100.
  All four stacks: identical motion numbers, DOM 6/6 equal, pixels 1.0, hydration 6/6 clean, safety passed; JS gzipped 107 KB (React, MERN) / 243 KB (Next.js).
- **panscience.xyz** (Next.js; recreate 22f9e1a0, 6 pages): fidelity 80, visual difference 79, between widths 76. Original motion: 23 hover, 34 scroll reveals (+ 81 elements revealed by timers / "first scroll", not rebuilt), 34 loops (26 CSS carried by the page's own CSS, 8 dashed SVG spokes / script fades not rebuilt).
  Checklist rows on every stack: reveal 34/34 **pass**, hover 22/23 **pass**, loops 27/34 open. DOM 6/6 equal, pixels 1.0, hydration 6/6 clean, safety passed; JS gzipped 99 KB (React, MERN) / 244 KB (Next.js).
  In the browser the reveal elements start hidden and none stays hidden after scrolling (a page's `rp` elements hide again when they leave the view, as in the original); no page errors in any stack.
- **Found and fixed during 4b.9 (all general)**: (1) the re-audit paired loops by pattern + duration, but a loop the original drove with script has no duration while its rebuilt CSS animation has one (parchaa showed 1 of 20 loops): now by pattern;
  (2) scroll-reveal capture was **not deterministic** on pages whose reveals are started by a timer or by the first scroll (panscience `/media`, `/ecosystem`, `/ventures`: 0 or 18-49 tracked depending on whether the timer had fired before the tracker installed, and the ones caught were called "scroll"): a reveal now counts as a scroll reveal only
  when the element comes into view (below the screen before the step, at most 1.35 viewport heights below the top after it, `SCROLL_REVEAL_MAX_TOP_AFTER`); everything else is `timed` and is never rebuilt; (3) one stalled page killed the whole inspect step at its 420 s limit and discarded the job (seen once): a page started in time is now abandoned 5 s before the limit
  (`inspect.js PAGE_LIMIT_MARGIN`; pages captured so far are kept, the rest link to the live site); (4) a local page that did not reach `load` in 15 s failed the job in the fit pass (seen once): our own local renders (`verify/goto.js gotoLocal`) now retry once with twice the time.
  (3) and (4) happened on a machine with ~1.8 of 8 GB RAM free (several browsers at once); they are about robustness, not about motion.
- **Determinism after the fix (two fresh panscience recreates)**: hover 23 / 24, loops 34 / 34, fidelity 80 / 80, visual difference 79 / 79 (stable); scroll reveals 34 / 76: the *number* of reveals the capture finds on timer-driven pages still depends on timing (`/media` 0 or 27, `/ecosystem` 0 or 3 scroll reveals), because whether an element is still hidden when the tracker installs depends on when the page's own timer fires.
  The recreate and its checklist stay consistent within one run (the re-audit compares against the capture of the same recreate).
- **Calibration**: the Motion row thresholds (pass ≥ 90 %, open 50-90 %, regressed < 50 %) separate the real cases: reveals and hover pass at 86-100 %, loops sit at 79-80 % for reasons that are real limits (script-driven marquees, dashed strokes inside inline SVG). The visual-diff (65) and fidelity (80) thresholds of earlier steps were not changed:
  the final recreates sit at fidelity 80-91, visual difference 79-89, between-widths 73-76. The generated motion CSS is small (parchaa: 11 KB of 318 KB, 38 reveal effects for 41 elements because fitted easings differ slightly; not clustered).
- **Timing**: a Recreate of the six panscience pages takes ~9.5 min of the 12-minute budget (inspect ~2 min, sweep ~3.5 min, responsive ~1.5 min); the motion capture adds ~7-8 s per page (hover budget 8 s, loops 2.2 s, reveal tracking inside the scroll-through). Re-audit motion step: ≤ 10 s hover budget + ~25 s per page, ≤ 6 pages.

### Phase 4b final summary
Recreate now carries the motion of the original, not only its still layout:
- **Responsive fidelity** (4b.6): a fourth captured view (laptop 1024), a sweep of the original and the recreate at 7 widths, breakpoint refinement, fluid type, phone shrink, continuous overflow penalty (`report.responsive`).
- **Perceptual visual difference** (4b.7): SSIM-style score with bands and heatmaps per view, used by fidelity and the sweep.
- **Motion capture** (4b.1-4b.3, desktop view → `capture/<slug>/motion.json`): hover and keyboard focus (CSS rules + a mouse/Tab probe; a hover must revert when the mouse leaves), scroll reveals (declared timing from the Web Animations API, sampled timing with a fitted easing for script-driven effects, stagger, trigger, replay), and continuous loops (CSS animations, Web Animations, script-driven spin / drift / oscillation).
- **IR and emitters** (4b.4-4b.5): motion tokens in one `data-motion` attribute, one CSS rule per distinct effect (hover under `@media (hover: hover)`, focus, reveal under `.js-motion`, rebuilt loops), and **one fixed generated script** (`js/motion.js`, ~1 KB, the same for every site) for scroll reveal only. Without script, or with reduced motion, the page shows finished. The same output in the plain-HTML build and in React + Vite, Next.js and MERN; every stack stays behind the equivalence check (DOM equal, pixels ≥ 97 %, clean hydration) and the safety gate allows exactly that file.
- **Re-audit, UI and report** (4b.8): a Motion category in the fix checklist (reveal / hover / loops reproduced, same probes on both sides), a Motion section in the NEW-panel report card, a Motion row and the script-aware Safety row in the complete report.
- **Verified on parchaa.com and panscience.xyz** through all four stacks (4b.9, above).
- **Known limits**: effects that run at page load (entrance animations) and effects started by a timer or the first scroll are not rebuilt; script-driven drifts / marquees and loops inside inline SVG are not rebuilt; the number of reveals found on timer-driven pages varies between captures; hover coverage is limited by the probe budget (about 10 elements per page); no exit animation for `rp` reveals; Live view (3b) and the full PreviewManager (5b) stay deferred.
- **Branch state**: merged into `phase-4a` with the user's approval (fast-forward, 53652dd, 8 commits from `phase-4b`); never pushed. The worktree `../Website-Audit-4b` and the branch `phase-4b` can be removed.

### Phase 6 final summary
Every recreate can be built as **four stacks**, all from the same saved IR and all checked against the plain-HTML build: Plain HTML / CSS / JS (the
reference), React + Vite, Next.js (App Router, static export) and MERN (the React client + an Express server that serves it and stores form
submissions in MongoDB). The project's stack is built right after the recreate; any other stack can be built later from the saved recreate without
capturing the site again; each stack has its own preview, zip download and re-audit.
- **Architecture**: emitter registry (`recreate/emit/index.js`; one entry per stack: `emit(ir)` + optional `build()`), a stack-neutral IR walker
  (`emit/walk.js`: references, node and head descriptors) shared by every emitter, `emit/write.js`, `report.outputs[stack]`, export from the saved IR
  (`export/fromIr.js`, `POST …/recreate/:id/export`, under the global job lock), toolchains in `server/toolchains/`, `build/toolchain.js` (junction to the
  toolchain's `node_modules`, minimal env, time limit), download zip (`export/zip.js`).
- **How every stack is verified** (nothing is kept if it fails): the code around the pages is scanned; the build runs with the pinned toolchain; the build
  is scanned with the app rules (`verify/appProfiles.js`: only the framework's own scripts, never `unsafe-inline`); links/assets/HTML are verified; then
  **equivalence with the plain-HTML build** (`verify/equivalence.js`): same DOM (URLs resolved, moved pages mapped) and ≥ 97 % same pixels on every page and
  view with JavaScript off, and the pages hydrate without errors or DOM changes with it on (hydration problems are warnings). Deviation from the plan:
  fidelity is not measured a second time (that needs the in-memory trees); `outputs[stack].fidelity = { score: <the HTML build's>, basis: 'equivalent-to-html' }`.
- **Decisions (approved)**: toolchains installed on demand; React/Next hydrate and the checklist shows the JS cost; MERN v1 = form endpoint + MongoDB (no e-mail,
  CMS or accounts; logins, search and file-upload forms are left alone and reported); export without recapture; Next.js uses `trailingSlash: true` (`about.html` →
  `/about/`, with `_redirects` + `vercel.json`, canonical/sitemap on the new URLs); Next.js is pinned to 15.5.27 (15.3.3 was flagged vulnerable).
- **Re-audit and UI** (6.6): the re-audit audits the stack output the preview shows (scripts allowed, pages at their output URLs); the framework runtime the stack
  ships on purpose is `N/A`; a `JavaScript shipped` row compares the original's script transfer size with the build's gzipped bundles; stale reason `stack`.
  NEW panel: stack chip, build state (building / failed / not built / ready) with the verification card, the forms note under a MERN preview, a stack picker next to
  Download ("Build & download" for a stack that is not built yet).

**Real-site verification (6.7, authorized sites, API on a temp data dir, default page limit, through the API like the app: Analyze → Recreate with an app stack so the
automatic build + re-audit path runs → the other stacks exported → every stack re-audited and downloaded; 0 errors on both sites):**
| Site (original) | Stack | Build | JS gzipped | Equivalence (DOM / pixels / hydration) | Lighthouse mobile perf · SEO · a11y (original → now) | Checklist (fixed / regressed / open) | `JavaScript shipped` |
|---|---|---|---|---|---|---|---|
| parchaa.com (Framer, GTM; recreate fidelity 88, 6 pages) | HTML | reference | none | reference | 38·92·89 → 40·100·91 | 13 / 2 / 14 | fixed (655 KB → 0) |
| | React + Vite | 41 s | 103 KB | 6/6 · 1.0 · 6/6 | → 58·92·91 | 12 / 2 / 14 | improved (→ 103 KB) |
| | Next.js | 70 s | 237 KB | 6/6 · 1.0 · 6/6 | → 65·100·91 | 10 / 3 / 15 | improved (→ 237 KB) |
| | MERN | 40 s | 103 KB | 6/6 · 1.0 · 6/6 | → 59·92·91 | 12 / 2 / 14 | improved; 1 real form stored, server tests 15/15 |
| panscience.xyz (Next.js; fidelity 80, 6 pages) | HTML | reference | none | reference | 76·100·91 → 78·100·91 | 7 / 3 / 6 | fixed (160 KB → 0) |
| | React + Vite | 48 s | 96 KB | 6/6 · 1.0 · 6/6 | → 69·100·91 | 6 / 3 / 6 | improved (→ 96 KB); "No Next.js runtime left": fixed |
| | Next.js | 78 s | 237 KB | 6/6 · 1.0 · 6/6 | → 68·100·91 | 3 / 5 / 7 | **regressed** (160 → 237 KB); "Next.js runtime kept on purpose": N/A |
| | MERN | 47 s | 96 KB | 6/6 · 1.0 · 6/6 | → 69·100·91 | 6 / 3 / 6 | improved; no text form, server tests 15/15 |
Every downloaded zip (parchaa 3.1 MB, panscience 9.7 MB each) was also unpacked and used as a standalone project: React + Vite `npm install` 11–17 s + `npm run build` 6–8 s;
Next.js install ~52 s + build ~66 s (8 HTML files: the pages plus `404` and `_not-found`); MERN `npm run install:all` 25–42 s, `npm run build`, `npm test` (the
server tests, now including the built-site test) all passed. Regressions the checklist reports honestly: render-blocking and unused CSS (the shared stylesheet, deferred since
5.5), colour contrast 14 → 27 elements on panscience, and for Next.js "Avoid serving legacy JavaScript to modern browsers". Local Lighthouse timings move by several points between
runs (parchaa HTML 40 vs React 58 is mostly noise), so compare stacks by the JavaScript row and the audits, not by the performance score.

**Post-merge bug: `flex: revert` broken by Next.js's CSS pipeline (found on nyaayai.com, fixed in `c1d4ca3`, general).**
- *Symptom*: the Next.js build of nyaayai.com was rejected by the equivalence check: `/platform/`, tablet view, 71 % pixel match (the page was 10859 px tall instead of
  10303 px). It failed the same way on both recreates of that project, so a Next.js build of it had never succeeded; the React + Vite build was fine.
- *Root cause*: the IR resets a shorthand in a later view with a CSS-wide keyword (`flex: revert`, undoing the base `flex: 0 1 450px` at tablet width). Next.js's bundled
  `postcss-flexbugs-fixes` rewrites `flex: revert` to `flex: revert 1` (and `revert-layer` to `revert-layer 1`), which is invalid CSS: the browser dropped the reset and the
  base `flex-basis: 450px` stayed at tablet width. Our CSS was valid; esbuild (Vite) and the HTML build keep it as written, so only the Next.js stack was hit.
- *Fix*: `emit/css.js declarations()` writes a `revert` / `revert-layer` reset of `flex` as its longhands (`flex-grow`, `flex-shrink`, `flex-basis`: same meaning, left
  untouched by every tool). Regression test in `recreate-next.test.js`: the emitted CSS through Next's own plugin is unchanged, and a control shows what the shorthand turned into.
- *The check did its job*: the equivalence check (not a person) found the problem. The broken build was rejected and not kept (`outputs.nextjs = { status: 'failed', error }`);
  nothing wrong was ever shown, previewed or downloaded. A failed stack build is not retried by itself: "Build <stack> again" in the NEW panel, or `POST …/recreate/:id/export`,
  rebuilds it from the saved IR (no new capture).
- *Re-export verification (nyaayai.com, Next.js, from the saved IR, API run on the fixed code)*: build 97 s, **fidelity 83** (`equivalent-to-html`, threshold 80), DOM 6/6
  identical, **pixels ≥ 0.988** (mean 0.999, threshold 0.97), **hydration 6/6 clean**, safety passed, 0 URL changes, 0 warnings, JS 237 KB gzipped; `out/` has 8 HTML files
  (6 pages + `404`, `_not-found`); the download plan answers 200 (`nyaayai.clone.com-nextjs.zip`); no `node_modules` / `.next` left in the output.
- *Lesson*: two real sites (parchaa.com, panscience.xyz) did not exercise this combination; a bundler's own CSS plugins can change valid CSS, so every stack's output stays
  behind the equivalence check rather than being trusted because its input was valid.

**Known open items (not blockers)**: the MERN preview shows the client only (forms need `npm start`); only the latest 2 recreates keep their saved IR, so a stack can only be
built from those; Next.js ships ~237 KB gzipped of framework runtime (React + Vite ~100 KB, HTML none); the re-audit measures stacks on a local preview without compression and
compares against the original's real transfer size (the build's gzipped size is used for the stack side); a second app stack builds one at a time under the global job lock
(Next.js ~70 s, React/MERN ~45 s); the per-page / critical-CSS split (4b/later) would remove the CSS regressions; hover/scroll motion came in Phase 4b.

### Phase 6 plan (approved) — branch `phase-6`

Stack emitters (React+Vite, Next.js, MERN) + Download zip. The plain-HTML pipeline stays the reference (fit pass, `dist/`, fidelity);
stack emitters run after it from the saved IR (`ir/site.json`), general, no site-specific code. Decisions: toolchains in
`server/toolchains/` installed on demand; React/Next hydrate (checklist shows the JS cost honestly); MERN v1 has a form endpoint +
Mongo; export to another stack from the saved IR without recapture; order 6.1 first.

| Step | Scope | Status |
|---|---|---|
| 6.1 | Download zip for HTML (`recreate/export/zip.js`, `GET …/recreate/:recreateId/download`, UI button) | ✅ |
| 6.2 | Foundation: emitter registry, shared IR walker, stack in job/report, export from saved IR, toolchain setup | ✅ |
| 6.3 | React+Vite | ✅ |
| 6.4 | Next.js | ✅ |
| 6.5 | MERN | ✅ |
| 6.6 | Re-audit (target-stack-aware runtime rows) + UI | ✅ |
| 6.7 | Real-site verification + docs | ✅ |

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
  plugin-react 4.5.0, react/react-dom 19.1.0) and `next` (next 15.5.27 + react 19.1.9; first pinned at 15.3.3, replaced because that version is flagged vulnerable). `npm run setup:toolchains -w server -- react-vite`
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

6.5 details (MERN, `status: 'ready'`, `scripts: true`, toolchain `mern` = vite 6.3.5 + plugin-react 4.5.0 + react/react-dom 19.1.0 + express 5.2.1 + compression 1.8.2 + mongodb 7.7.0):
- **Layout** (`recreate/emit/mern/`): `client/` = the React + Vite emitter's project (`emitReact` on the IR with forms rewired), `server/` = fixed template files
  (`template/server/**`, read at emit time, the same for every site) + generated `server/forms.json` and `server/package.json` (pins from the toolchain), root
  `package.json` (`install:all`, `build`, `start`, `dev:client`, `dev:server`, `test`), `docker-compose.yml` (a local MongoDB), `README.md`, `.gitignore`.
- **Backend scope (v1, as approved)**: Express serves `client/dist` (CSP, nosniff, Referrer-Policy, X-Frame-Options, COOP, Permissions-Policy, compression, immutable
  caching for `/assets` and `/_app`, `404.html`), `GET /api/health`, `POST /api/forms/:id`, `GET /thanks`. No e-mail, CMS or accounts. Env: `PORT`, `SITE_DIR`,
  `MONGODB_URI`, `FORMS_DB`, `FORMS_COLLECTION`, `FORMS_STORE=memory`, `TRUST_PROXY`. Without `MONGODB_URI` (or when MongoDB is unreachable at start) the site is
  served and the endpoint answers 503; a failing write is a 503 that does not leak the reason.
- **Forms** (`mern/forms.js`): a `<form>` that collects named fields becomes `{ id: <page>-<n>, page, fields }` and posts to `/api/forms/<id>` (`action` + `method=post`
  added to the client markup, `enctype` dropped; a no-JavaScript browser is redirected to `/thanks`). Skipped and reported: GET / `role=search` / `type=search`
  forms, forms with a password field (login) or a file input, forms without named fields. Hidden inputs are never stored. Server validation (`forms.js`): only the
  defined fields, required, type (email, url, number with min/max), choices for select/radio/checkbox groups, length caps (maxlength, 2000 / 10000), non-string
  values rejected, control characters removed, `pattern` is not evaluated (ReDoS); same-site `Origin` check (403), in-memory rate limit 20/hour/address (429 +
  Retry-After), 100 KB body limit. Stored document: `{ formId, page, values, receivedAt, userAgent }`.
- **Build** (`mern/build.js buildMern`): the client goes through `buildReact` (toolchain `mern`, `sigOptions: { ignoreFormActions }` so action/method/enctype on forms
  are not an equivalence difference), then the generated server tests run with the pinned toolchain (`node --test` in `server/`, junction `node_modules`): 15 tests —
  validation, the store against a stand-in MongoDB driver, the app (headers, static serving, JSON + browser posts, 422/404/403/400/413/503/429), and
  `site.test.js`: every page of the real `client/dist` is served and every form of `forms.json` is on its page with `action="/api/forms/<id>"`. Output entry:
  `dist: 'client/dist'`, `forms: { stored, skipped }`, `server.tests`, plus the React fields. Zip: `client/` + `server/` sources, `.gitignore` and `.env.example` kept,
  `node_modules`/`.ssr`/`.next` anywhere and `dist`/`out` at the top or under `client/`/`server/` left out; the report has a forms section.
- Tests: `recreate-mern.test.js` (form detection + rewiring, project files, the shipped validator and a stand-in MongoDB driver, the generated server tests, a real
  export with a contact form + login + search form); the shipped tests are `template/server/test/*.test.js`. Real sites checked: fixture (1 form), panscience.xyz,
  parchaa.com (no text forms in the captured pages): client equivalent, hydration clean, 15/15 server tests.

6.6 details (re-audit and UI know the stack):
- **What is audited**: `export/fromIr.js` has `outputRoot`, `targetStack(report, projectStack)` (the project's stack when its output is ready, else the plain-HTML
  build — the same rule the preview uses) and `outputPages(report, stack)` (`[{ outPath, path }]`: where the output serves each page; builds record `pages`).
  `runReaudit` serves that folder (`servePreview({ connectSelf, scripts: emitter.scripts })`: an app's own scripts run, so Lighthouse measures what visitors get),
  seeds the crawl with the output's own URLs, and stores `stack` / `stackLabel` in its result. `compareAudits({ output })` pairs pages at their new URL
  (`scope.js pathOnNew`: Next.js moves `about.html` to `/about/`).
- **Runtime rows**: `platformItems` is target-aware — an OLD platform whose runtime the output stack ships on purpose (`emitter.runtimes`: react-vite `react`, nextjs
  `nextjs`+`react`, mern `react`) becomes `na` with "<Name> runtime kept on purpose (<Stack> output)"; every other platform is still `fixed` when its runtime is gone.
  `finish()` honours a `preset` status (rows decided by their own rule) and `statusLabel`.
- **JavaScript shipped** (`stack.javascript`, category performance): always a row when a side has JavaScript. Before = Lighthouse `resource-summary` script transfer size
  of the original; after = the build's **gzipped** bundle size (`outputs[stack].build.js.gzipBytes`; a local preview does not compress, so Lighthouse's number would
  overstate the cost), or Lighthouse's own figure for a build without bundles. `fixed` (none left), `improved` (< 90 %), `regressed` (> 110 %), else `changed`
  (labelled "About the same" / "Not compared" in the app). `checklist.stack = { id, label, jsBytes }`.
- **Contract** (`reaudit/contract.js`): `audit.recreate.stack`, `stackLabel`, `output` (= `checklist.stack`); stale reason `'stack'` when the project's target build is not the one
  the checklist audited (its stack changed, or the build finished after the re-audit).
- **Preview** reports `stack` (`startPreview({ stack })`, `info.stack`). `exportStack` now records every failure as `outputs[stack] = { status: 'failed', error }`.
- **UI**: `client/src/stacks.js` (`outputsOf`, `outputState` ready | failed | building | none, `shownStack`, `pageOf`). NEW panel: stack chip (the build shown; warn tone +
  title when it is the plain-HTML fallback; "Building…" chip), page picker and preview URL follow the output's own page URLs, polling of the build queued after a recreate
  (then the preview moves onto it and the audit reloads), `StackOutput` card (building / failed with "Build again" / not built with "Build" / ready: equivalence, hydration,
  safety, JavaScript shipped, fidelity, URL changes, forms + server tests, warnings), **forms note** under the preview of a MERN build with stored forms ("this preview shows the
  client only; run `npm start`"), footer **stack picker + Download** (a stack that is not built yet reads "Build & download": it is built from the saved recreate, then downloaded).
  `FixReport`: stack badge in the header, footnote naming the audited build, stale text for `stack`. `RECREATE_STACKS` has all four stacks.
- Tests: `reaudit-stack.test.js` (output selection, moved-page pairing, JS rows incl. regressions, kept runtimes, a real re-audit of a Next-style output, stale `stack`).
  Seen in the real app (scratch API + Vite, Playwright) with projects in each state: Next.js ready + re-audit, MERN with forms, building, failed, never built.

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
- Time limit 12 minutes since 4b.6.1 (10 + 2 for the responsive sweep), configurable with `SAS_RECREATE_MINUTES` (1–60). The inspect step may use up to 7 of them but
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
- **Time limit:** 6 minutes per analysis (5 before the speed and robustness work), of which 2 are kept for Lighthouse: a step before it is cut short
  or skipped rather than using them. A step that would start after the limit is skipped and listed in
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
- Theme ("Aurora light", UI redesign): light, vibrant. Violet accent `#6D4AFF` with a violet-to-pink brand gradient, indigo-tinted neutrals, soft lavender / sky / blush mesh background with slowly drifting blurred blobs
  (`AppShell .aurora`), white glass cards (blur + soft coloured shadows), Inter + JetBrains Mono (local via @fontsource). All colours, gradients (`--grad-*`), radii, shadows and motion (`--ease`, `--dur`) are tokens in
  `client/src/styles/tokens.css`. Keyframes live in `styles/global.css` and are used from CSS modules through variables (`animation: var(--k-fade-up) …`; `:global()` in `animation` is not accepted by the build).
  Motion: staggered fade-up of panel content and cards, hover lifts, gradient buttons with a shine sweep, animated score rings and count-up numbers (`components/common/CountUp.jsx`), shimmering progress bars, pulse on the NEW chip,
  all switched off by `prefers-reduced-motion`. Gotcha: a flex child with `overflow: hidden` gets min-height 0 and is squashed in the panels' flex column: give it `flex: none`.
  Colors only via tokens.
- OLD panel = sky-blue gradient rail/chip; NEW panel = violet-to-pink gradient rail/chip.
- The audit JSON shape (`server/src/dummy/audit.js`) is the contract the UI renders. `server/src/audit/assemble.js` produces it; new fields must be additive (`test/analyzers.test.js` checks the keys).

## Structure
```
client/src/  layout/ (AppShell, Sidebar, OldPanel, NewPanel)
             components/{common,audit,preview,project,recreate}/  (preview/SitePreview.jsx = iframe/screenshot,
             recreate/RecreateReport.jsx = fidelity + verification card, recreate/FixReport.jsx = fix checklist)
             recreate/StackOutput.jsx = the stack build card (building / failed / ready + what was verified)
             store/useProjects.js, api/client.js, constants.js (STACKS), stacks.js (outputs of a recreate), styles/
server/src/  index.js, db/index.js (schema + migrations), routes/{projects,analyze,screens,recreate,reaudit,stacks}.js, dummy/audit.js
             toolchains/index.js (status of server/toolchains/<id>, pinned versions)
             reaudit/ index.js (serve dist/ + runAnalysis on it + compare, STEPS), jobs.js (job, auto-trigger target, retention),
                    contract.js (audit.recreate for GET /audit),
                    compare/{index,scope,rules}.js (fix checklist: OLD vs NEW)
             recreate/ir/crawlFiles.js (sitemap.xml + robots.txt)
             jobs/ manager.js (JobManager + global one-job lock), sse.js
             recreate/ index.js (pipeline + STEPS + budget), jobs.js, inputs.js, workspace.js (tmp → final, retention),
                    errors.js, discover.js (page selection), inspect.js (step 1), capture/{index,snapshot}.js (Playwright capture),
                    assets/{index,collect,css,download,cdn}.js (step 2: local assets),
                    ir/{index,tree,styles,names,head,links}.js (IR), emit/{html,css}.js (plain HTML emitter),
                    emit/{index,walk,write}.js (emitter registry, stack-neutral IR walker, project writer),
                    emit/react/{index,jsx,components,scaffold,build}.js, emit/next/{index,routes,build}.js,
                    emit/mern/{index,forms,build}.js + template/ (the fixed Express server + its tests),
                    export/{fromIr,zip}.js (build another stack from the saved IR, download zip), inlineScripts.js (CSP hashes),
                    build/toolchain.js (runs a pinned toolchain), verify/{equivalence,appProfiles}.js (stack vs HTML build, app script rules),
                    fixers/{index,svg,html,a11y,perf,wordpress}.js (sanitizers + audit fixers + WP REST), build/{index,minify}.js (step 4 + dist/),
                    generate.js (step 3: IR + fixers + emit + fit pass), preview.js (static preview + step 5),
                    verify/{server,layout,fidelity,safety,site}.js (local render, fidelity, safety gate, build verification)
             security/ netGuard.js (address classes, policies, resolveChecked), egressProxy.js (Chromium proxy)
             audit/ index.js (pipeline + STEPS), jobs.js (queue, 1 at a time), resources.js (parallel work by free memory), sharedCache.js (static files shared by a job's browser contexts), http.js, robots.js, sitemap.js,
                    crawler.js, extract.js, linkChecker.js, render.js, screenshots.js, retention.js, frame.js, assemble.js,
                    lighthouse/{run,worker}.js, analyzers/{seo,aeo,crawlChecks,a11y,metrics,weaknesses}.js
             detection/ engine.js, manual.js, manual-rules.json, rules/<platform>.json (15 platforms)
server/toolchains/ react-vite, next, mern: package.json each (pinned), node_modules installed on demand (gitignored)
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
npm run setup:toolchains -w server -- react-vite next mern   # build toolchains of the non-HTML stacks, on demand (no argument: list the status)
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
  Download (6.1) streams the zip of the selected stack; a stack that is not built yet is built from the saved recreate first.
- Phase 6: the MERN preview serves the client only (its forms need the server); the saved IR (so "build another stack") exists for the latest 2 recreates only;
  an app stack's JavaScript runtime is a real cost (Next.js ~237 KB gzipped, React ~100 KB) that the `JavaScript shipped` row shows.
- Only one preview runs at a time: selecting another project with a recreate moves the preview to it. Clicking a link
  to a page that was not recreated opens the live original inside the preview frame (without script).
- Recreate output (4a.4): font sizes and line heights are px per breakpoint (no fluid type yet); between the three
  captured widths the layout relies on the %/max-width/fr heuristics. Hover, focus, scroll-reveal and loop motion came in Phase 4b (see its final summary).
- A Lighthouse run takes ~20–40 s each (mobile, then desktop), so a full analysis of a healthy site takes a little over a minute (render, screenshots and robots run side by side); slow sites and busy machines take longer, up to the 6-minute limit.
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
