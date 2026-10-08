# Site Audit Studio — Website Audit & Recreate Platform

Internal tool: keeps all company websites in one place, audits them and recreates an improved version in a chosen stack.
Company-owned or authorized sites only.

## Layout (3 columns; since the UI revamp: sidebar + home gallery + one dashboard per website, see "UI revamp (dashboard)")
- **Sidebar**: "New Project" + saved websites; clicking one loads it into OLD.
- **OLD panel**: URL + Analyze → preview (sandboxed iframe, or the Analyze screenshot when framing is blocked; Live/Shot toggle; 1440/768/375) →
  performance metrics → audit report (tech stack + confidence, weaknesses, SEO, AEO, meta/sitemap/robots, broken links, a11y, "manual rebuild needed") → Recreate + stack settings.
- **NEW panel**: preview of the recreated site (own localhost port) → fix checklist (fixed / still open / manual) → Download .zip.

## Tech stack
- Client: React 19 + Vite 6, Zustand, lucide-react, CSS Modules + tokens (`client/src/styles/tokens.css`). Port **5173**, `/api` proxied to 4000.
- Server: Express 5 (ESM, `"type": "module"`). Port **4000**.
- DB: SQLite via built-in **`node:sqlite`** (`DatabaseSync`; no native build, Windows-safe). Node ≥ 22.13; ExperimentalWarning silenced with `--disable-warning=ExperimentalWarning`.
- Analyze: playwright (Chromium), lighthouse + chrome-launcher (forked worker), @axe-core/playwright, cheerio, robots-parser.
- Preview/security: sharp (WebP screenshots), undici (fetch with connect-time SSRF check).
- Recreate: esbuild (minifies CSS/JS of `dist/`), html-validate (standard + document presets, offline).
- Download/stacks: archiver (zip streamed on demand). Build toolchains are NOT server dependencies: `server/toolchains/<id>/` (own `package.json` + `node_modules`, gitignored),
  installed on demand with `npm run setup:toolchains -w server -- <react-vite|next|mern>`: `react-vite` (vite 6.3.5, plugin-react 4.5.0, react 19.1.0), `next` (next 15.5.27, react 19.1.9),
  `mern` (react-vite's + express 5.2.1, compression 1.8.2, mongodb 7.7.0). Generated projects pin the same versions.
- Planned: get-port, execa.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project CRUD (SQLite), stack modal, dummy audit | ✅ |
| 2 | Analyze job + SSE: Lighthouse (mobile+desktop), stack detection, crawler (broken links, sitemap, robots, meta), SEO, AEO, axe, manual-rebuild detector | ✅ |
| 3 | OLD preview: frame check (XFO + CSP3 frame-ancestors), sandboxed iframe, screenshots 1440/768/375 (fold + full, WebP, latest 3), per-device metrics, SSRF guard | ✅ |
| 3b | Live view (CDP screencast, view + scroll + click, no keyboard) | ⏳ deferred by the user |
| 4a | Recreate → plain HTML: discovery, capture, local assets, IR, variant merge, semantic classes, fixers, build + verify, preview | ✅ verified on real sites |
| 4b | Responsive fidelity + visual diff + motion in all four stacks, re-audit rows | ✅ merged (53652dd, ff from `phase-4b`) |
| 5 | Re-audit of NEW → real fix checklist, sitemap/robots emitter | ✅ merged (99ebc2f) |
| 5b | Full PreviewManager (several previews on 5100–5199) | ⏳ deferred by the user |
| 6 | React+Vite / Next.js / MERN emitters + Download zip + stack-aware re-audit/UI | ✅ merged (d25444d) |

**Current status**: Phase 6 complete, merged into `phase-4a` (d25444d, ff from `phase-6`) + post-merge `flex: revert` fix (c1d4ca3); never pushed. Phases 1, 2, 3, 4a, 4b, 5, 6 are all on `phase-4a`.
After Phase 6, `ui-redesign` was merged into `phase-4a` (asked by the user, to see it on 5173); it brings the WIP work of `recreate-retry`, `full-site`, the UI redesign and **desktop only** (sections below).
**Workflow**: one phase/step at a time, only after the user says "go ahead"; WIP commit per step, wait for "next"; commit at the end of each phase; never push;
while the user tests, work in a git worktree and merge only when asked. Leftover worktrees/branches that can be removed: `../Website-Audit-4b` + `phase-4b`, `../Website-Audit-perf` + `perf-robustness`.

### Faster "Visit every page" (Recreate inspect step) — branch `optimize-fast-crawler` (worktree `../Website-Audit-crawler`, from `fix-all` 46b36c8, checkpoint a777653), WIP
User: make step 1 much faster for any site, keep the old crawler as fallback, miss nothing. All general (no site rule). Capture still needs a real browser
(computed styles, screenshots, motion), so "HTTP first" applies to discovery only; the capture itself (views, probes, waits) is unchanged.
- **Pages side by side** (`recreate/inspect.js`): `capturePagesAtOnce()` = `SAS_CAPTURE_PAGES` (1–8; **1 = the previous one-page-at-a-time loop, same code path**),
  else `SAS_MAX_PARALLEL` → floor(cap / 4 views) (≥ 1), else min(`CAPTURE_PAGES_MAX` 3, CPU threads / 4, free memory / (4 × 150 MB)). A 2–4-thread or short-of-memory machine stays at 1.
  Before each extra page starts, `roomForAnotherPage()` checks free memory again (else waits for a running page: `report.capture.heldBack`). Pages start in discovery order; captured
  pages / manifest keep it. Per-page cap, stall → retry in a fresh browser, outage/sleep recovery (`recoverHit`, per page), `PAGE_LIMIT_MARGIN`, `scaleToPages` unchanged.
  An unexpected error in one page (not the homepage) is reported for that page (notice page) instead of failing the step, in both paths. One browser, one egress proxy, one shared cache for all.
  `report.capture = { pagesAtOnce, peak, heldBack, discoverMs, captureMs }` (additive). Outage grants of pages hit together may add up (still capped by `ALLOWANCE_MS`).
- **Discovery** (`discover.js`, `audit/crawler.js`, `audit/extract.js`): fetch concurrency `SAS_CRAWL_CONCURRENCY` (1–16, default `CRAWL_CONCURRENCY` 8; Analyze keeps 4);
  browser renders limited to free memory (≤ 4, `inspect.js limiter`) in one browser (fixes a race that could launch two); render rule `looksClientRendered` (shell, < 300 chars of text
  whatever the links, an empty app mount point `#root/#app/#__next/…` or a `<noscript>` asking for JavaScript while text < 2000) — broader than `looksLikeShell`: when in doubt, render.
  URL dedupe = existing `pageKey` (www / trailing slash / fragment). Discovery was already HTTP-first and takes ~1–2 s; the time is in capture.
- Not changed on purpose: capture waits (`load` ≤ 20 s, quiet network ≤ 5 / 3 s, 300 ms) and probe timings — they decide what is captured (lazy content, hydration, reveals).
- **Measured** (this machine: Ryzen 5 7535HS 12 threads, 15 GB, ~4.6 GB free; same limits; before = checkpoint worktree, after = branch; 3 pages at once):
  fixture (8 pages): inspect 99 / 105 s → **36 / 36 s**, total 138 / 149 → 86 / 75 s, identical results (pages, motion counts, fidelity 99, per-page scores).
  parchaa.com (Framer, 9 pages): inspect 667 / 658 s → **250 / 261 s**, total 896 / 907 → 501 / 518 s; same 9 pages, 0 errors; hover 151 / 136 → 152 / 153, reveal 76 / 70 → 81 / 72,
  loops 37 / 33 → 28 / 37, clicks 15 / 15 → 16 / 16 (run-to-run noise of timer-driven pages; homepage loops 13–19 in every run), fidelity 95 / 95 → 94 / 94, visual diff 93 / 93 → 92 / 94.
- Tests: `recreate-concurrent-capture.test.js` (limit honoured, order kept, failing pages isolated, memory fallback, `SAS_CAPTURE_PAGES=1`, homepage failure still fails, real captures
  1 vs 2 at once equal, render rule, crawl concurrency + dedupe); `recreate-interrupts.test.js` (+ outage hitting two pages side by side; the order-based stand-in pins 1 page).
- **Back to the old behaviour**: `SAS_CAPTURE_PAGES=1` (capture) + `SAS_CRAWL_CONCURRENCY=4`; or `git checkout fix-all` / `git reset --hard a777653` on this branch.

### Speed and robustness of the jobs (after 4b) — ✅ merged into `phase-4a` (d1b09e8, ff from `perf-robustness`, approved); never pushed
Final check: server suite 238/238; panscience.xyz via API: Analyze 102 s, Recreate 491 s, re-audit 174 s, 0 errors, fidelity 80, visual diff 79, 6/6 pages, 42/42 widths, safety passed.
Trigger: on panscience.xyz Analyze stopped at 43 % ("render timed out after 85s, screenshots after 70s, links / Lighthouse skipped"); on a quiet machine 82 s with no error. The pipeline was fragile
on slow networks / busy machines (all steps serial, one budget, Lighthouse last). All fixes general.
- **Parallelism by free memory** (`audit/resources.js parallelism({ perUnitMB, max, min })`, `freeMemoryMB`): 150 MB per page, 300 MB kept free; macOS = unknown = no cut. Lenient on purpose
  (2 views instead of 4 at ~1 GB free: six pages 212 s vs ~120 s, no gain), so it cuts only when memory is really short. Used by Analyze screenshots (≤ 3), crawl renders (≤ 3), Recreate capture (4, min 2),
  sweep (4 widths, min 2), responsive check (≤ 4, was serial).
- **Analyze** (`audit/index.js`): robots/sitemap, homepage render (+ axe) and screenshots start together; screenshots continue next to crawl + link check; browser closed before Lighthouse (runs alone, mobile then desktop).
  `LIGHTHOUSE_RESERVE_MS` = 120 s: earlier steps get `stepBudget()` = own limit but never the reserve ("Skipped: the time that is left is kept for the checks after it"); mobile leaves half to desktop.
  Budget 5 → **6 min**. A Lighthouse run that dies (not times out) is retried once when ≥ 45 s are left. Homepage fetch retried once after a timeout (30 s). Limits: render 110 s, screenshots 80 s, Lighthouse 120 s each.
- **Bounded waits** (`render.js waitSettled`): navigation waits for `domcontentloaded`; `load` ≤ 10 s, then quiet network ≤ 4 s (only if `load` fired). axe has its own 40 s limit (rest of the render kept).
  Screenshots: views not done by the deadline are given up and reported, finished ones kept (`captureScreenshots({ parallel, deadline })`). Lighthouse uses `disableFullPageScreenshot`.
- **Recreate** (`recreate/index.js`): the sweep is a `background` step (`after: 'inspect'`, `join: 'responsive'`): always next to asset downloads; next to generate/build (`browser: true`) only when a second browser
  fits (`roomForSecondBrowser`: 900 MB beyond the 300 MB reserve; `SAS_RECREATE_OVERLAP=1/0` forces it), else awaited first. A background stage gets `{ stepDeadline, progress }` as 2nd argument. Generate takes the
  pages swept so far (`ctx.sweepPending(count, ms)`, first `REFINE_PAGES` = 3, waits ≤ 75 s); generate limit 3 → 4 min. A failing step ends a running sweep before the workspace is discarded. `report.timings` = ms per step + `total`.
- **Progress** (`jobs/manager.js progressTracker`): percentage = weighted sum of each step's fraction; shown step = earliest still running (only its messages shown). Step lists are ordered by where a step is awaited
  (Analyze: screenshots after links; Recreate: sweep after preview), so the app's list only moves forward.
- **Measured (panscience, 6 pages, 8 GB machine, 1–1.7 GB free)**: Analyze 82 → **68 s**; Recreate ~570 (4b.9) → **529 / 559 s**, same results (fidelity 80, visual diff 79, widths 74–75, hover 23–24, loops 34–36);
  re-audit 163 / 169 s (motion ~115 s of it). Small Recreate gain: with ~1 GB free the sweep only overlaps asset downloads. Lighthouse mobile a11y varies 91–96 run to run on this site (old code too).
- **Slow connection run** (requests 6–12 s, ~450–700 MB free, overlap forced): finished (510 s), no timeouts, but 3/6 pages captured (inspect 251 s, rest linked live + warning), assets 174 s (vs 12 s),
  sweep captured nothing in 4 min (warning), fidelity 76. So overlap is **not measured yet** on a machine with spare memory; on a slow network Recreate degrades (fewer pages), not fails.
- **Shared static-file cache** (`audit/sharedCache.js createSharedCache()`, one per Recreate job = `ctx.netCache`, created in inspect, used by every view/page capture and the sweep, removed at job end; `SAS_SHARED_CACHE=0` = off):
  the 11 contexts of a page (4 views + 7 sweep widths) each re-downloaded CSS/JS/images/fonts. Now the first context loads a file **itself** (browser request through the egress proxy; the cache never fetches),
  the response is kept (`requestfinished` → body to a temp folder, never the workspace), others get `route.fulfill`; a context asking during the first load waits ≤ 15 s, then loads itself.
  Shared: GET stylesheet/script/image/font with 200. Never: documents/frames, XHR/fetch, media/range, redirects and their targets, errors, `Set-Cookie`, `no-store`, `Vary` other than Accept / Accept-Encoding / Origin;
  25 MB per file, 500 MB per job. Failed/abandoned loads left to each browser. `report.sharedCache` = { requests, served, servedBytes, loaded, stored, storedBytes, notShared, failed, files }.
  A first version used `route.fetch` from Node (one connection per file, first load 2.7 s vs ~1 s per view) and was replaced.
- **Capture timing** (`views[v].timing` in `capture/<slug>/<view>.json`: document, load, idle, scroll, snapshot, motion, screenshots; sweep widths `timing` { load, scroll, screenshot }): panscience `/` desktop, normal network:
  document+load+idle ~4–5 s, scroll-through 8–11 s, motion ~11 s, snapshot+screenshots ~3–4 s. So the network is a small part; the guess that 11 loads per page dominate was wrong. Scroll-through and motion waits kept (they make the capture accurate).
- **Cache measured** (slow = Chromium "Fast 3G" emulation, 1.6 Mbit/s, 562 ms, measuring script only): normal network panscience `/` 63.2 s without vs 60.4 s with (first pair 80 vs 94 s was noise: 970 vs 394 MB free),
  pictures as equal as two runs without. Slow: panscience 2 pages 138.6 → 130.1 s (sweep network 103 → 57 s summed); parchaa.com `/` 116.4 → 102.6 s (sweep 66.7 → 54.1 s), and without the cache the laptop capture was
  **incomplete** (5 images aborted; header, blog list, testimonials, CTA missing) while with it complete (same DOM 947 nodes, height). Gain: small on fast networks, completeness on slow ones. One run per case.
- **Full Recreate with the cache** (panscience, 6 pages): **446 s** (vs 529/559, ~570 in 4b.9), same results (fidelity 80, visual diff 79, widths 74, 6/6, 42/42, hover 24, loops 35). 2915 static requests, 2710 from cache:
  205 files (11 MB) loaded once instead of 142 MB re-downloaded. More free memory that run (1.2 GB, 4 views), so not all gain is the cache's.
- **Asset step reads the cache** (`cache.lookup(url)`; `assets/download.js fromCache`, `assets/index.js cachedSheet`): cached files pass the same checks as downloads (size per kind, not a web page, content hash, SVG sanitizer);
  anything missing/failing goes to the normal SSRF-guarded download. Cross-origin stylesheets too. `report.assets.fromCache`, `report.sharedCache.reused / reusedBytes`. panscience: 189/207 files from cache, step 7.6 s
  (11.6–14.2 before); the 207 files are **byte-identical** (sha256) to a Node-download run (except S3 signed URLs whose query changes, and which of two identical icons names the file). Not re-measured on a slow connection.
- **Analyze uses the cache too** (one per analysis: homepage render, crawl renders, 3 screenshot views; `renderHome / renderHtml / captureScreenshots({ cache })`; closed with the browser before Lighthouse, which is untouched).
  panscience: 80 s, no errors (68/82 before): no gain on a normal connection; the point is slow connections.
- **Full chain after both** (panscience, new project): Analyze 80 s, Recreate **487 s** (inspect 170, assets 7.6, sweep 150, generate 77, build 37, responsive 54), re-audit 164 s; fidelity 80, visual diff 78, widths 74,
  6/6, 42/42, 816 asset refs verified, safety passed. Homepage laptop view 77 instead of 86 (timer-driven scroll-reveal state, known variance); all else within a point.
- **Open candidates**: re-audit motion measures ≤ 6 pages serially (~20 s each); jobs run one at a time under the global lock; remaining Recreate cost = scroll-through (8–11 s/context), motion probing, 7 sweep loads per page —
  shortening these changes what is captured and needs the user's decision.
- Tests: `shared-cache.test.js` (sharing policy; 4 contexts load a static file once while documents/API/redirects/cookies/`no-store`/`Vary: User-Agent`/errors still hit the server; blocked addresses never reached; size limit;
  slow first load doesn't block others; temp folder removed; an analysis opens the homepage 4× and downloads static files once), `recreate-assets.test.js` (network closed: cached file saved, error page or lost cache file → download;
  pipeline uses the cache), `perf.test.js` (parallelism, `stepBudget`, overlapping progress, a local page whose image and frame never answer completes, screenshot views kept at the deadline),
  `recreate-jobs.test.js` (sweep runs beside later steps, awaited by `responsive`; short of memory it finishes before generate; failing sweep = warning; failing step ends a running sweep).

### Complete report (UI redesign task, after 4b.1; dashboard redesign on `report-revamp-2`)
"Generate report" (top bar, project selected) builds one report of OLD, NEW and the fix checklist; modal (animated steps, then preview); **Download PDF** (server-made, direct download, no print dialog),
**HTML** (self-contained, no script, no external request), **JSON** (complete data, shape unchanged: it is where all detail lives), Regenerate.
- API: `GET /api/projects/:id/report[?format=html|pdf|json][&download=1]` (`routes/report.js`; built on request from stored data, nothing kept; CSP `default-src 'none'; img-src data:; sandbox`, no-store).
  PDF (`report/pdf.js`) = the HTML printed by the app's Chromium (`preferCSSPageSize`, no margins, no browser header/footer: the report lays out its own A4 sheets and footer; one at a time, no network).
- `report/collect.js` (project, latest analysis → `audit` incl. `audit.recreate`, latest completed recreate report, small WebP thumbnails of the homepage's first screen: original + copy, computer and phone;
  **logo** = the site's icon kept by `routes/favicon.js` (`favicon.bin` + `favicon.json` type, image types only, ≤ 512 KB) as a data URI in `images.logo`, so the JSON stays unchanged; none → letter monogram).
- **Dashboard redesign (user rejected the text-heavy revamp: "no logo, content content content, no analytical charts, not impressive")**: `report/render.js` rewritten. Each page = a fixed A4 sheet (`.page` 210 × 297 mm, own footer "<site> · Website report · date / Page n of N";
  screen view = sheets on grey, < 820 px they flow). Charts = inline SVG built server-side, theme colours only (copy = orange #c2410c, original = slate grey, status green / amber / red / blue always with a word), values printed on the marks, tabular figures.
  - **Page 1 (dashboard)**: dark header band with the logo tile, site name, address, "Website report" + date; one verdict line (~20 words, e.g. "The copy is faster, easier to find on Google and more accessible, and fixes 17 problems.");
    a sub line (checked / copied / compared dates, page counts); **four 270° gauges** (phone scores: outer orange ring = copy, inner grey ring = original, green tick at 90, "+18 Better / ±0 Same / −16 Worse" (±2 = same), "Original 81", "Computer 94 → 100");
    **KPI tiles** (Fixed or better, Still needs work, Got worse, Needs a person, Match with the original % + word); original vs copy homepage in a browser frame with the phone view overlapping; **What to do next** (≤ 3).
  - **Page 2 ("The numbers")**: grouped bar chart (4 areas × phone/computer, original vs copy, dashed "good" line); **donut** of the checklist (Fixed, Better, Fine on both, Still needs work, Got worse, Needs a person; deploy-only checks left out);
    **speed** small multiples (Main content shows in, Ready to use in, Page freezes for when ≥ 0.05 s, Page weight; each on its own scale with Google's mark dashed); **match per page** (≤ 11 pages: sorted bars with the target-80 line; more: pages per
    band 95–100 … below 65 + lowest page); **What was fixed** (≤ 6, accessibility → Google → AI → links → site files → speed → platform, "and N more") and **Needs a person** (≤ 4, equal kind + reason merged); last line "Every check, page and value is in the JSON download."
  - States: never checked = 1 page (band, "This website has not been checked yet.", three "Not yet" step cards, next steps); checked only = gauges / bars of the original alone with Good / Needs work / Poor, tiles (pages, things to improve, accessibility issues,
    dead links, needs a person), donut of Google / AI / site-file checks, "The most important problems" (≤ 6) and the screenshot next to the next steps; copied without re-audit = original's scores, match chart, "Fixed by the copy" (`report.fixes`).
  - `report/words.js` (plain names, mirrors `client/src/copy.js`) unchanged; the render uses `AREAS`, `rating`, `matchRating`, `plainName`.
  - Pages (user's data): botza.panscience.ai 2, parchaa.com 2 (also rendered as checked-only 2, copied-only 2, never-checked 1).
- Analysis screenshots use `animations: 'allow'` (`audit/screenshots.js`): `'disabled'` stacked every word of a cycling headline (panscience). Older analyses need Analyze again.
- Client: `components/report/ReportModal.jsx` (+ css; unchanged), `api.getReportHtml/getReportJson/getReportPdf`. Tests: `report.test.js` (404, never-checked one page + monogram, checked + copied two pages with inline charts and escaping,
  checked-only verdict / problems, full verdict + gauge words + donut counts + fixed list, logo from the saved icon, download/JSON, thumbnails, real PDF = 2 pages).

### UI revamp (dashboard) — branch `ui-revamp` (worktree `../Website-Audit-uirevamp`, from `fix-all`), WIP, client only
Asked by the user: look like a real, professionally built product (not AI-generated), images + motion, keep the orange theme, and above all **organised** content. Layout chosen: a **website dashboard**. Steps R1–R4, WIP commit each.
- **Shell**: sidebar = mark (`common/Illustrations.jsx LogoMark`), "All websites" (home), "Add a website", search, each site's favicon + three progress marks
  (`site/Site.jsx StageDots`: checked · copy made · compared; running = moving, got worse = amber), pulsing dot while a job runs; rail when collapsed (Ctrl+B).
  Slim top bar in the main column: breadcrumb, Full report, the authorization note (short form < 1180 px, full text still read by screen readers).
- **Data**: `store/useProjects.js` `overviews[id] = { audit, recreate }` for every site (GET only, refreshed by `goHome` and whenever the open site's audit / copy reloads); `goHome()` (remembered as
  `wa:lastProject = 'home'`; the app opens on the last site or home). Screenshot URLs of an audit are rewritten to the project's current id (`normalizeAudit`: an imported project kept its old id in them, 404).
  `siteData.js`: `originalShot` (Analyze desktop fold, else the copy step's capture), `captureShot`, `copyShot` (fidelity picture), `scoresOf`, `stagesOf`, `outcomeCounts`, `useSiteData(id)`.
- **Home** (`layout/Home.jsx`): welcome band (warm mesh drifting slowly + grain, totals with count-up), gallery (most recent site with a copy = wide card with the copy overlapping its picture; cards = screenshot in a browser frame,
  phone scores of the copy with the change against the original, progress marks), dashed "Add a website" card, "How it works" with four drawn illustrations (`CheckArt`, `CopyArt`, `CompareArt`, `ResultsArt`).
- **Website dashboard** (`layout/Workspace.jsx` + `SiteHero.jsx`): one scroll area; hero (favicon, name, address, facts, counts better / still open / got worse / for a person, the next action: Check the site →
  Create the copy → Download the site (direct when the project's stack build is ready and safe, else Results), Check again; real screenshot with the copy overlapping; scores copy vs original with Phone / Computer and bars).
  Sticky section tabs **Overview | Check | Copy | Compare | Results** (`common/Tabs.jsx SectionTabs`, arrows / Home / End; status per tab from the same `stepStates`); on every section but Overview the hero is one compact row.
  Opens on Overview unless a check / copy is running. `steps/OverviewStep.jsx`: plain summary, original vs copy pictures + match, what still needs a look (comparison, else the check's problems), progress timeline, facts;
  a site not checked yet gets the four steps with "Check the site".
- **Sections**: Check = health tiles (ring + meaning), speed in a hairline grid, "On this page" jump links above the sticky original preview. Copy = settings next to the last copy (picture, pages, match), stages joined by a line
  (folded once a copy exists). Compare = strip of every page (capture picture + match), the copy frame has its own Live / Picture (picture = fidelity shot; picture first when the app is not on :5173, because the preview
  server's frame-ancestors only allows the app's address). Results = `recreate/PageGallery.jsx` (original + copy picture per page, 6 then "Show all", click opens Compare on that page).
- **Look**: tokens added (`--canvas`, `--surface-warm`, `--hairline(-strong)`, `--elev-1..3`, `--elev-accent`, `--mesh-hero`, `--grain`, `--fs-3xl`, `--fs-display`, `--radius-xl`, keyframes `sas-rise / slide-in / skeleton / draw`);
  `.skeleton`, `.eyebrow`, `.tabular` in global.css. Cards = hairline + soft elevation, icons without tiles, folds quiet; modal backdrop neutral. All motion off under `prefers-reduced-motion`.
- Checked with Playwright at 1440×900, 1024×768 and 768×1024 (home, every site and section, a site never checked, modals, collapsed rail, keyboard on the tabs): no console errors; `npm run build -w client` passes.

### UI redesign (calm light theme, guided steps) — branch `ui-redesign` (worktree `../Website-Audit-ui`), WIP, merged into `phase-4a`
Asked by the user: the vibrant look and crowded two panels were hard to read → light theme, organised data, tasteful motion, wording a non-technical person understands. Decisions (user): **guided steps**
(1 Check the site → 2 Create the copy → 3 Compare → 4 Results & download) and **calm blue** (#2563EB on white / soft grey). Steps U1–U6 (U7 polish folded into U6); one at a time, WIP commit, wait for "next". All general.
- **U1 foundation**: `styles/tokens.css` keeps token names with calm values (neutral greys, one blue accent, status colours tint + border, neutral shadows, base type 14.5px; `--grad-*` now flat colours). No page gradients,
  aurora blobs, glass top bar, gradient logo, shine, glowing/pulsing chips or moving rails; violet rgba shadows → neutral. **`client/src/copy.js`** = the one place for plain labels and "what does this mean" texts (ratings Good / Needs work / Poor,
  health areas, speed metrics in everyday words, the four steps, friendly names for every server job step, result statuses, terms). New `components/common/`: `Surface.jsx` (Card with icon/title/explanation/tip/actions, Alert, EmptyState),
  `InfoTip` (the "i": hover, keyboard, tap), `Score.jsx` (ScoreRing with rating in words, StatusIcon, Pill), `Tabs.jsx` (StepTabs, Segmented), `StepList`, `ConfirmDialog` (replaces `window.confirm`; Button `dangerSolid`), Button size `lg`.
  Sidebar: "Add a website", "Your websites", "Search your websites", removal via the app dialog ("the real website is not affected"), no stack tag.
- **U2 guided layout**: two panels gone (`OldPanel` / `NewPanel` removed). `layout/Workspace.jsx` = name + address, **step tabs** (arrow keys) with live status per step (`stepStates`: "Checked 5 h ago" / "Checking · 40 %" / "The check failed";
  "30 pages copied" / "Working · 12 %" / "Check the site first"; "30 pages side by side"; "3 fixed · 6 got worse" in warn tone); a project opens on the step where its work stands (`startStep`) until the user picks a tab; the stack-build
  polling moved here. `layout/steps/`: **CheckStep** (address, pages, "Check now / again", progress, report left, original site sticky right; one column < 1180 px), **CreateStep** (settings in words, one big "Create the copy", "Change settings"
  = stack modal, stale alert, progress, "Last copy", build card), **CompareStep** (one toolbar: page, sizes, "Scroll together"; original page-aware; empty state → step 2), **ResultsStep** (download card + technology picker + "Full report (PDF)",
  outcome, checklist, "Compare now" when missing). Top bar "Full report" (secondary); empty app "Start with a website"; `format.js` (timeAgo, ageDays, plural); preview toggle "Live / Picture".
- **U3 Check**: `components/audit/HealthOverview.jsx`: **At a glance** (generated sentences: speed, "especially on phones" when phone ≥ 15 below computer, Google, a11y count, dead links, "Built with X"), Phone / Computer switch,
  **five health cards** (Speed, Found on Google, Easy for everyone, Safe & modern = Lighthouse categories; Ready for AI answers = share of AEO checks passing, warning = half) with `ScoreRing` + "i" incl. the expert term;
  **Speed in everyday words** (Main content shows in, Ready to use in, Page freezes for, Page weight; Google thresholds). `components/audit/FixList.jsx`: **What needs fixing** (failing/warning SEO/AEO/site-file checks, weaknesses, a11y rules,
  dead links as one row; Important / Worth fixing / Minor; row opens to "Why it matters", "What the check found", "How to fix this"; "Usually fixed in the copy"), **Already fine (n)** folded, **Needs a person**. `copy.js CHECKS`
  (plain name, why, area, fix flag per check title) + `SEVERITY`. Old `AuditReport` under folded **Details for experts**; `MetricsBar` removed.
- **U4 Create + progress**: `AnalyzeProgress` (check, copy, comparison) = titled box, % + **time so far** (`startedAt`), bar with sheen, "waiting" note when queued, calm reconnect note, `StepList` with `copy.js JOB_STEPS` names + live message;
  failure = Alert ("Nothing was lost… start it again"). `StackOutput` = Card with marks ("Looks and works like the simple version", "Starts without errors in the browser", "Safe", "Extra download for visitors", "Match with the original",
  "Some page addresses changed", "Contact forms"). "What happens when you click" (four stages). Settings dialog: "Settings for the copy", "Future address of the new site", stacks described for non-developers (`constants.js STACKS.detail`).
- **U5 Compare**: one toolbar for both frames (`PreviewFrame viewportButtons={false}`); "Page n of N" picker showing each page's match score + previous/next; **one match line** (`copy.js matchRating`: Almost identical ≥ 90, Very close ≥ 80,
  Close, worth a look ≥ 65, else Clearly different) + "i". Grey frame dots. Kept small on purpose (user: don't make it unnecessarily complicated; a second score and per-size chips were dropped).
- **U6 Results**: `components/recreate/Outcome.jsx` **How the copy turned out**: one sentence, four counts with "i" (Better = fixed + improved, Still needs work, Got worse, Needs a person), overall match + verdict, Speed / Google / Easy for everyone
  before → after with Better/Worse/Same; "Still needs work" ≤ 6 items (worse first). Then "Compare now", **download** card, folded "Every check, before and after" (`FixReport`) and "Match per page and other measurements" (`RecreateReport`).
  Sample checklist (`FixChecklist`) removed. Checked in a browser, no page errors.

### "As is" fixes (user, after the panscience all-pages run) — WIP, no git repo in this copy (no WIP commits / worktree)
User: hero too big, some buttons do nothing, some hovers missing, FAQ open by default, Analyze 63 pages vs 62 copied; the copy must also be **mobile responsive**. All fixes general.
Plan (approved): **1** screen-height units + collapsed panels + page count → **2** working controls (accordions, menus, tabs, carousels, filters; small generated script, all 4 stacks; `capture/clicks.js` already
records them, nothing consumed them) → **3** script-driven hovers (probe budget ran out on every page: index 6 of 32) → **4** mobile: bring back the parked tablet + phone captures (user's choice, slower) →
**5** shortest possible waiting for Analyze, Recreate and Re-audit (user, added during step 1; done after 2–4 because they add capture work) → **6** full panscience run + a second site.
- **Step 1 (done, waiting for "next")**: causes were a 900 px capture window (hero `min-height: 100dvh` → `min-height: 900px; height: 900px`; content centred with `top/left: 50%` + `translate(-50%,-50%)` → `top: 450px; left: 720px`),
  `styles.js` dropping every `grid-template-rows` (accordion `0fr` → open), and `?query` addresses counted as pages.
  - `capture/viewport.js` (every view, after the screenshots, ~0.3–0.4 s): page re-read with the window 1.3× taller, same width, then put back; boxes whose height / min-height / top / bottom (positioned) changed get `node.vp = { vh, h, top, bottom, mh }`
    in `<view>.json` (`viewportProbe` = { height, nodes, ms }); `ir/tree.js fromCapture` carries `vp`.
  - `ir/styles.js viewportStyle` (end of `normalizeView`): centring idiom → `left/top: 50%` + `translate(-50%…)` (width `100%` at its max-width, else px + `max-width: 100%`); with `vp`: min-height following the window → `Ndvh` / `calc(Ndvh ± Cpx)` (`followWindow`)
    and the guessed px height dropped; px height following → dvh; box held by two unmoved insets → no px height; an unmoved inset is the anchor, a share of the containing block → `%`.
  - Collapsed panels: rows all `0px` → `grid-template-rows: 0fr`; a box of no height with `overflow: hidden|clip` and content (parent not collapsed) → `height: 0px`.
  - Analyze `pagesCrawled` = addresses without a query string (Recreate's rule), `pageVariants` = the rest (additive); Check step shows "(+N addresses with “?…” counted as the same page)". Old analyses keep their count until checked again.
  - Verified on live panscience (`/`, `/about`, `/ventures`, `/contact`): hero `min-height: 100dvh`, content centred at 50 %, FAQ grids `0fr`. Tests: `recreate-viewport.test.js`.
    Suite: 269 pass, 3 fail = the 2 known `netGuard` + `recreate-reveal` "timing, easing…" ('sampled' vs 'transition', load-dependent: 3/3 pass alone; the test only uses `settle()`, untouched).
    Temporary diagnostics `server/scratch-*.mjs` (hover original vs copy, probe + IR on live pages, test-server driver `scratch-run.mjs` on PORT 4010 / `SAS_DATA_DIR=C:\sasd2`,
    preview checkers `scratch-faq.mjs` / `scratch-states.mjs`, live click probe `scratch-clicks.mjs`, original's behaviour `scratch-orig.mjs`): delete when the plan is done.
  - Not a bug of ours (2026-10-06): panscience itself dropped to 17 sitemap URLs and "News 0 / Blogs 0" on /media (posts still online, unlinked), so Analyze finds 21 pages, not 62.
- **Step 2 (working controls)**: all general, in all four stacks (same fixed `js/motion.js`, same CSS).
  - **Panels that open on click** (accordions, dropdowns): `capture/clicks.js` reads the panel's area (`commonPath` of the control and what it opened, never `body`) open and closed again
    (`readRegion`: display / visibility / opacity / transforms / height / max-height / grid rows / paddings / margins / colours + ::before/::after) → `widget.state = { root, parts[{ rel, changes }], added? }`.
    `ir/motion.js openDecls`: collapsed sizes open to their content (`height: auto`, `max-height: none`, rows `1fr`), other size changes left out; equal controls (signature group) get the effect at the same
    relative places → tokens `wN` (area), `wt` (control), `wNpK` (part); `motionCss`: `[data-motion~=wN].is-open [data-motion~=wNpK] { … }`; `js/motion.js` toggles `is-open` + `aria-expanded` on click.
    `added` (panel rendered only when open) → skipped + counted. `report.generate.motion.widgets`.
  - **Tabs / carousels / filtered lists** (`capture/states.js`, after the click probe, ≤ 30 s per page, nothing on pages without switching controls): groups of equal controls (`planSets`; the selected
    dot/tab is added back from its row, `rowControls`) are clicked in turn and the area that changes is snapshotted per state (`snapshotPage({ rootPath })`, inherits from its real parent); next /
    previous are matched to the state they lead to (offset ±1); elements that change without a click (rotators, marquees, counters: `selfChanging` 1.2 s) are never evidence. On the area's snapshot node:
    `states = { initial, count, controls[rel], nav[{ rel, offset }], variants[{ index, body }] }` (a page snapshot caught between two timer states takes the current one). Assets of the states are collected
    (`assets/collect.js`). `ir/states.js expandStates` (in `buildPageTree`, before cleanup; cleanup keeps elements with `stateAttrs`): each state = a `hidden` copy of the area right after it,
    `data-w-set` / `data-w-i` on areas, `data-w-go="sN:i"` on controls (next/previous → neighbour state), copies' nodes linked as `stateTwins` (hover / reveal tokens reach them).
    CSS `[data-w-set][hidden] { display: none !important }`; script shows the state a `data-w-go` control points to. No script = first state only.
  - Probe fixes: a control inside a control skipped as duplicate is not a separate control (FAQ arrow spans); signature = tag | role | classes | ARIA state attributes | parent | grandparent (inline-styled
    sites: FAQ buttons and category chips had the same signature, so the FAQ was never probed); a query / hash change on the same path (`?tab=join`) is not leaving the page (`samePage`).
    Pending page timers cleared when the probe starts (`stopTimers`: autoplay changed the page mid-probe → false "hover" panels, panels "not closing"); what moves by itself (own transform /
    opacity only, 1.5 s, `selfMoving` → `clicks.noise`) is removed from every reading (the hero word rotator made FAQ items look like tabs); visibility counts clipping by a collapsed overflow
    parent (accordion answers keep their own size); removed elements count as hidden (paths kept with the "before" reading; filters remove cards); fixed / sticky bars and sub-pixel translates are
    not moves (header sliding on scroll, reveals finishing); after scrolling a control into view: settle 700 ms and aim again (smooth scroll). A probe that leaves the remaining controls at other
    paths (a tab inserting a section) → the start address is loaded again before the next probe and at the end (`controlsInPlace`, `stats.reloads`). Click budget 10 → 20 s per page.
  - States: a set needs a change outside its own controls (a card expanding is its own panel); sets whose controls lie inside what another set switches are content; same-area sets merge only on the
    same row; state budget follows the work (4 s per control, 30–60 s). A carousel (has next / previous) starts at what a **first-time visitor** sees right after load (`firstVisit`: fresh context,
    intervals and ≥ 1 s timers disabled by an init script; panscience remembers the last slide in storage and autoplays after ~5 s), matched exactly or by visible text (`closestByText` ≥ 0.9).
  - The fit pass and fidelity skip state copies (`verify/layout.js stateCopy`): /ventures fidelity 53 → 70 again. Toggles (`aria-expanded`, `<summary>`) are probed first (a page whose chips need
    reloads used up the budget before its FAQ). The window-height probe reads layout sizes (`offsetWidth/Height`): a spinning box's bounding box looked like a size following the window (caught by
    `recreate-generate.test.js`).
  - Verified (test server, panscience, 9 pages + home): FAQ opens/closes on /, /about, /approach, /contact (and /ventures captured after the toggle-first fix, live probe); homepage carousel 24 states,
    starts at Accern like a first visit, dots / next / previous identical to the original; /ventures chips 26 → 8 → 2 → 26 cards (original 27 → 8 → 2 → 27: one card fewer in "All", open);
    safety passed, fidelity 88, visual diff 89, no page errors. Recreate 426 s for 10 pages (was 271 s before step 2: click budget 20 s + state capture ~35 s on the homepage, ~20 s on /ventures).
    Full suite: 274 pass, 2 fail (known `netGuard`), 9 skipped.
- **Rebuild from the last visit (regenerate from saved capture)** — `recreate/replay.js`: `POST …/recreate { reuseCapture: true }` takes the latest finished recreate whose `capture/manifest.json` +
  `assets/manifest.json` exist; the job (`recreate/jobs.js`, `payload.reuseFrom`) runs with `replayStages` in place of inspect / assets: both folders hard-linked (copy fallback), `ctx.pages` /
  `ctx.discovery` (origin, skipped, robots, llms) / `ctx.livePages` / `ctx.assets` from the manifests, report pages / motion / discovery / assets / page+asset manual items carried, warning
  "Rebuilt from the capture of …". The capture manifest now keeps `discovery.robots` / `llms` (older ones: robots from the earlier report's `crawl-files` fix, llms from its `site/llms.txt`).
  Generate → build → preview → re-audit as usual; the new recreate can be the source of the next. panscience 10 pages: **34 s instead of 426 s**, identical results. App: step 2 "Rebuild from
  the last visit" (shown once a copy exists). Tests: `recreate-replay.test.js`.
- **Step 3 (fonts + hovers)**:
  - Fonts: the copy was right at 1440 (182/200 identical) but the original sizes text with the window (panscience `h1` = min(5vw, 76px), h2 / p too): on any narrower laptop window the copy's
    text was bigger. `capture/typography.js probeTypography` (desktop view, after the height probe): font-size / line-height / letter-spacing of every element with own text read again at
    1920 / 1600 / 1280 / 1100 → `node.ty` when they change; `ir/typography.js fluidType` (in `normalizeView`, desktop): `fluidLength` fits `Nvw` / `calc(Nvw ± Apx)` with caps → `min()` / `max()`
    / `clamp()` (a cap only where the line would pass the value the page stopped at); line-height / letter-spacing with a constant ratio to a fluid size → unitless ratio / `em`. Test
    `recreate-typography.test.js`: copy = original at 1920 / 1366 / 1280 / 1024.
  - Hovers: CSS hovers were complete (8 pages, totals equal; "extra" findings were the diagnostic missing the original's smooth-scrolled elements). The mouse probe aimed before a smooth
    scroll settled (script-owned scroll) → re-aim after the settle; hover time follows the candidates (0.9 s each, ≤ min(15 s, 2 × budget)) instead of 60 % of 8 s (6 of 32 probed).
    Test `recreate-hover-probe.test.js` (20 script-only hovers on a long smooth-scrolling page, all found).
  - **The user's list during step 3** (all general):
    1. Tabs whose content is another section that a tab inserts (contact "Partner with us / Join us"): `planSets` takes, under a broad common ancestor, the 2–3 child parts holding controls
       / changes (`parts`, one virtual node, per-part `states` sharing `group`); when a tab adds/removes sections (paths shift) and the row has ≤ 3 controls, the whole common area (`main`).
    3. Short messages a click shows ("X's website hasn't been added yet"): `capture/notices.js` (fixed element shown, not undone by the click; fresh first visit with timers on; ≤ 30
       controls, 30 s; message snapshotted per control, duration measured) → `body.notices`; `ir/states.js expandNotices`: hidden copies at the end of body `data-w-note-of`, controls (+ twins
       with the same text) `data-w-note="nK:ms"`; script shows / hides. A bare `href="#"` stays `#` (`ir/index.js`; was resolved to "./" → the click reloaded the page). Fixed elements are not
       evidence for state sets.
    4. Flex-column items narrower than a stretching column (an "Apply now" button 140 px became 319 px): `width: fit-content` (one line of text) or `min(Npx, 100%)`; not when its own max-width explains it.
    5. One FAQ answer at a time: after the probe, open A then B of a list of equal panels; A closed by itself → `exclusive`; the list container (common path of the group) `data-w-one`
       (+ twins); the script closes the other open panels in it.
    6. Small boxes taller than their one line of text (26 px numbered circles became 26 × 17 ovals): `min-height` = captured height (`styles.js`, `inheritedPx`).
    7. Carousels that move on by themselves: `watchAutoplay` (fresh first visit, timers on, ≤ 13 s, ≥ 2 steps; none in 7 s = no autoplay) → `states.autoplay { ms, step }` → `data-w-auto`;
       the script advances it, a click restarts the wait (panscience 4.8 s).
    8. Bars that change once the page is scrolled (header white with dark links past the hero): `capture/scrollstate.js` (fixed / sticky bars ≥ half the width, read at the top and down
       the page with the mouse wheel — a script-owned scroll ignores scrollTo — threshold to ~10 px, what a small scroll back up undoes is left out) → `node.scrolled`; IR `sN` tokens +
       `data-scroll-at` (`0.9vh` when near one window height); CSS `.is-scrolled`; script toggles it.
  - Stacks: a fresh toolchain install got Rollup 4.64 (Vite 6.3.5 only asks ^4.34): its tree-shaking took 3–5 min on a React bundle (4.40.2: 2 s) → `overrides: { rollup: 4.40.2 }` in the
    react-vite / mern toolchains and the generated package.json (`pinnedOverrides`; `toolchainStatus` checks the pinned copy, also nested `vite/node_modules/rollup`). MERN server tests:
    `--test-reporter=tap` + parser for both formats (Node 24's default "spec" output read as 0 of 0).
    9. Hero word rotator shifted by the measured word width (`heroCycleShift` keyframes read custom properties the page sets per element): the snapshot now keeps custom properties
       where they differ from the parent's (set on that element), so they reach its rule.
    10. Contact headline in the tab states: states are snapshotted at 1440 × 900 only → twins with the same text take the original's `ty` / `vp` (`ir/states.js`), and a state replacing
       the page snapshot carries them over (`carryProbes`); px minimums from text size (small boxes, inline-level boxes, one-line boxes) are not written for fluid text
       (a 76 px `min-height` kept the line taller than the 68 px of the shrunk text).
    11. Centred one-line boxes (the message) get `width: max-content` (+ `max-width: 100%`), not a px width a slightly wider rendering wraps in.
    12. The locked cards were the last of 27 (cap was 12): notices now try up to 30 controls in 30 s, the next one clicked right away (waiting only when the message did not change).
    13. Filter chips that render only the chosen category's section (/media "All / News / Videos…"): the chips' signature also matched a look-alike
       button inside a filtered section (inline-styled site, no classes), which stretched the set over `main`, and > 3 controls over a broad area were
       skipped. Now a control with the set's signature inside what the set switches (not on the triggers' row) is content (`planSets`); a broad area
       whose parts can't hold (> 3 or < 2) is copied whole per state, with > 3 controls only while controls × elements ≤ `MAX_STATE_NODES` (3000).
    14. Equal controls group only within one top-level block (child of body / main, `clicks.js region` in the signature): a "View more" below the chips
       was skipped as a duplicate chip. After a probe reloads the page it waits for a quiet network (≤ 5 s) before stopping timers: a hydrating
       Next.js page left the next button dead ("no change").
    15. A button that adds content and takes it away on the next click ("View more" / "View less"): a two-state set of the part holding it
       (`planSets` toggle plan, `captureStates`: click, snapshot, click again must restore), the button leading from each state to the other.
       `ir/states.js` expands sets inside sets and gives a nested set to the same content (tag + text) in the outer set's other states.
       Test: `recreate-widgets.test.js` (filter + "View more" in the copy). Note: /initiatives cards and "Know more" are plain links; in a copy
       limited to 10 pages the uncopied initiative pages open the local notice page.
    16. Slow floating shapes (parchaa hero icons, 15–25 px over 4–12 s, moved by script) looked one-way in the 2.2 s loop recording (`drift` / `move`,
       not rebuilt): small movers that didn't turn are recorded again by path for up to 9 s (`loops.js recordPaths`, `SLOW_MOVER_PX` 60) → `oscillate`
       → the existing `@keyframes m-lN`. Only pages with such movers pay the extra seconds.
    17. Cards whose hover look the page's script draws (parchaa product cards: dark layer + screenshot + white text added on mouseenter; a builder's hover
       variant): the hover probe counts a sizeable layer shown inside a non-button control; `captureStates` snapshots each such card while hovered
       (`node.hoverState`, ≤ 24 per page); `ir/states.js expandHoverCards` puts the snapshot right after the card (`data-w-hcopy`, card `data-w-hrest`,
       cell `data-w-hv`, only when the card is its cell's only element); CSS swaps them on `:hover` / `:focus-within`, no script; fit / fidelity skip the copy.
       Panels a hover opens elsewhere are rebuilt from their open / closed styles with `:hover` (`wN` + `wh`, `@media (hover: hover)`).
       A button that changes on hover is still clicked (the panscience "View More" had been recorded as a hover only).
    18. States are read once their reveals ended (`revealArea` finishes running animations in the area and waits ≤ 1.5 s for faint elements): the
       contact "— APPLICATION" label had been captured at opacity 0 mid-fade.
    19. Hover / focus rules of content only a tab / filter state shows (contact "What we look for" cards, `.hoverLiftSm:hover`): read while each state
       is shown (`interactions.js cssStateEffects`, ≤ 12 states), stored per part on the variant (`effects`), the copy's nodes get their own paths
       (`<area>#v<i>>…`) and `stateEffects`, which `ir/motion.js` adds to the page's hover / focus list.
    20. React / MERN dev mode (`npm run dev`): the shell has no page head, so `js/motion.js` (menus, tabs, reveals, notices…) never loaded and nothing
       worked in a downloaded project run with the dev server. `src/main.jsx` now renders with `flushSync` and then adds the script when the site has
       one (`scaffold.js`); a built page keeps it in its head.
    21. The faint-element wait of `revealArea` (18) only continues while elements are still appearing: a carousel's hidden slides stay hidden, and
       24 slides had run past the state limit (homepage carousel lost its states and autoplay). `STATES_BUDGET_MS.max` 60 → 100 s.
    22. Page-load entrances (timed reveals in the first screen: a builder's hero fading in) are rebuilt: token `rl` + the effect's `rN`, the same
       `@keyframes m-rN` played once on load with CSS only (no hidden state, no script); skipped when the element carries an animation of its own
       (word rotators, loops) or repeats. Scroll reveals now use `[data-motion~=rv][data-motion~=rN]` so `rl` elements are never hidden.
    23. Views listing the same items in another order (parchaa `/solutions`: the phone layout's list starts with another item): `tree.js matchChildren`
       paired same-tag children by position, so items got each other's phone sizes (text squeezed to 26 px, the page 9397 px tall on a phone vs 6949).
       Same tags + the same items (tag + text) in a different order → matched by content (LCS); an item that moved is kept once per layout, each shown only
       where it belongs, so every layout keeps its own order. Same tags with different text still pair by position. Test in `recreate-generate.test.js`.
    24. Controls only the phone layout shows (a hamburger menu): the click probe also runs on the phone view (`capture/index.js`, 8 s, ≤ 8 controls,
       toggles first, after everything else was read) → `capture/<slug>/mobile-clicks.json`; `readPageMotion` adds it as `clicksMobile`; merged nodes keep
       their phone snapshot path (`tree.js mpath` / `mpathAlt`), and `ir/motion.js` rebuilds those widgets like the desktop ones (skipped when the desktop
       already rebuilt the same control: `skipped.phoneDone`; `widgets.phone` counts them). A panel far from its control (a drawer outside the header
       holding its button) has the whole page as its area: `readRegion({ only })` reads just the control and the panel. Test in `recreate-widgets.test.js`.
    25. Tickers moved by script (parchaa testimonials, a builder's ticker that only moves while on screen): `captureLoops` also scrolls a window at a
       time (≤ 12 steps, 0.7 s settle) and records strips ≥ 200 px wide that move by themselves there (`findScriptLoops({ inView, minWidth })`); every
       script candidate carries `repeat` = distance from its first child to the child's next copy (`repeatOf`: equal tag + text + image + child count).
       `ir/motion.js scriptLoop`: a `drift` with a repeat (or a seen wrap) → `@keyframes m-lN` translate 0 → ∓repeat, linear, infinite, duration
       repeat / rate (seamless, CSS only). One-way moves without a repeat stay skipped. Cost ~+15–25 s on a long page. Tests: `recreate-loops`, `recreate-motion-ir`.
    26. Found on nyaayai / parchaa (all in `ir/styles.js` / `emit/html.js`, so a rebuild from the capture applies them):
       - A border side with a style but no captured width (the capture keeps only values that differ from the default, and 0 px looks like it) got
         the browser's "medium" 3 px: a builder's 1 px divider `::after` drew a full grey box. `fillBorderWidths` writes 0 px for such sides
         (elements and pseudo-elements, `border-style` shorthand expanded 1–4 values).
       - An empty box (only absolute content) that is all its parent holds, where the parent is a flex / grid item (a logo frame in a ticker's
         list item): own px width + `flex-shrink: 0`; without it both shrank to 0 once the row was fuller than the screen (logos vanished).
       - Text that keeps line breaks (`white-space(-collapse)` pre / pre-wrap / preserve…, read from the class rules, inherited down): the HTML
         emitter adds no indentation inside it (each list item had 2 blank lines above and below its text: 24 px items 120 px tall).
       - An absolute box with both insets is "stretched" only when its insets stay the same across views; insets that move (right 370 at 1440,
         566 at 1024 for a 340 px card) mean a box of its own width, which keeps it (parchaa cards overlapped at 1100–1279 px).
       - A content-sized item filling its parent in one view while the views differ otherwise gets `100%` there, not the captured px (blog cards
         stayed 817 px at 1200 instead of following the column).
    27. Between the captured widths (parchaa at a 1265 px window, laptop rules captured at 1024; all in `ir/styles.js`):
       - A grid item with text as wide as its column in every view (and of changing width) gets `width: 100%` of its cell
         (`gridColumnWidth`), not the captured px: product cards stayed 397 px in 528 px columns. Logo tiles (no text) keep px.
       - An absolute box as wide as its containing block while centred (`left: 50%` + translate) gets `width: 100%`, and its
         height then comes from its aspect ratio (also not pinned by the empty-box rule): a hero picture stayed 1024 × 712.
       - A box stretched by inset 0 in one view but sized in another gets `width/height: auto` there (no px carried by the cascade);
         an empty absolute box stretched by both insets of an axis gets no px size on it (a card's dark layer stopped short).
       - A picture filling a parent stretched by `top/bottom: 0` gets `height: 100%`.
       Page height at 1265: 7094 vs original 7128 (the certificate logos stay at their 1024 size, 118 vs 152 px: open).
  - Autoplay timing measured inside the page (`watchText`: visible text every 100 ms, page clock); from Node a snapshot per reading took up to 0.5 s under load (1.5 s read as 2 s).
  - Verified (fresh capture home + 9 pages, then rebuilt from it; `scratch-checkall.mjs`): all 12 of the user's points OK (contact headline at 1280: 66.56 px, top 233, height 68 = original);
    fidelity 88 → 93, visual diff 89 → 94; React / Next / MERN: DOM 10/10, pixels 1.0, hydration clean, safety passed. Full suite: 288 pass, 2 fail (known `netGuard`), 4 skipped.
    `recreate-mern.test.js` now asks `node --test` for TAP (Node 24 prints "spec"; the test had been skipped while the toolchains were missing).
- **Step 4 (phone + tablet back)** — branch `step4-mobile` (worktree `../Website-Audit-step4`, from `as-is-fixes`), WIP, not merged. "Desktop only" (below) undone: copies are responsive again (320–1920).
  - Restored from 6bb0f55 (reverse patch): `views.js ENABLED_VIEWS` = desktop, laptop, tablet, mobile; Recreate `sweep` + `responsive` steps (7 steps, breakpoint refinement back); Analyze 3 screenshot views +
    `lighthouse-mobile` (mobile metrics/weaknesses again); report thumbnails/scores for both devices; client Phone / Computer toggles and size buttons; tests (sweep tests un-skipped). Kept: `KNOWN_*` views,
    the single-view IR path (`dropHiddenVariants`, `resolveHints` single, `{ source: 'single-view' }`) for captures saved while only desktop was on, the re-audit "same device on both sides" rule.
  - The step 1–3 probes stay desktop-only (typography, scroll state, clicks, states, notices; the window-height probe runs on every view), so the IR fills the gaps:
    - **State copies** (`ir/states.js borrowViews`): a tab / carousel / filter state is snapshotted at the desktop window only and a node missing in a view is hidden there (`styles.js cascade`), so on a phone the
      shown state went blank. Each copy node takes the other views of the original area's node at the same place (same tag + index among same-tag siblings, else the last such sibling: a card the first state
      lacks takes the previous card's layout); no counterpart → its own desktop data (`ownViews`). Done right after the copy is made, before `mergeVariants`, so copies merge like the original.
      Notices (`expandNotices`) get their own desktop data in every view.
    - **Safety net** (`js/motion.js show`): a state the stylesheet does not render at the current width (e.g. a builder's phone variant of the area has no captured states) is not switched to; the visible one stays (autoplay too).
    - **Fluid text in media queries** (`ir/typography.js fluidFit` / `fluidTypeAt`, `styles.js fluidDecls`): laptop / tablet / phone keep the desktop's fluid font-size (+ line-height / letter-spacing ratio) where it
      gives that view's captured px at its width; else their px (a phone size of its own). Without it 1024–1279 used the laptop px (h1 51 px at 1200 instead of 60).
    - Not done: the click / state / notice / scroll-state probes do not run on the phone view, so a **phone-only hamburger menu does not open** in the copy (needs a click probe on the mobile capture);
      `is-scrolled` / open-panel CSS is written for every width from the desktop values.
  - Tests: `recreate-widgets.test.js` (carousel built from a desktop + phone capture with the generated stylesheet: switches at 375 and 1200; a state hidden at a width is not switched to),
    `recreate-typography.test.js` (`fluidTypeAt`; four captures: copy = original font sizes at 1920 / 1366 / 1200 / 1100 / 1024 / 768 / 375).
  - Expected cost (from the desktop-only measurement on panscience, 6 pages: 178 s vs 711 s with all views): ~+90 s per page Recreate (sweep ~35, responsive ~15, generate fit/refine ~25, build fidelity ~12,
    inspect ~2 since views run side by side), Analyze +~30 s (phone Lighthouse, two more screenshots), re-audit +~55 s. Not re-measured on a live site.
- **Step 5 (shorter waiting)** — branch `step5-speed` (worktree `../Website-Audit-speed`, rebased on `as-is-fixes`), WIP, not merged. Only when / side by side, never what is captured or measured. All general.
  - Re-audit motion (`reaudit/motion.js`): no Tab walk (`measureMotion({ focus: false })`; the checklist reads reveals, loops, hover only; hover keeps its time); network-quiet wait on the loopback build 3 → 1 s.
  - Re-audit Lighthouse starts while the link check still runs (`runAnalysis({ linksBesideLighthouse })`, re-audit only; links awaited before the report). Analyze unchanged. `lighthouseRun` = tests' stand-in.
  - Project stack built **inside** the Recreate (`recreate/stack.js`, background step `stack` after `build`, awaited at the end): only when a second browser fits (`canOverlap`), the
    toolchain is installed and ≥ 3 min are left; stopped 5 s before its limit. `export/fromIr.js buildStackOutput` (shared with the export) writes `stacks/<stack>/` in the workspace, so the
    committed folder and `report.outputs[stack]` are as before; a failed build = `outputs[stack]: failed`, never a failed recreate. Otherwise the export after the job, as before
    (`report.stackBuild = { inJob, reason?, ms? }`). Preview starts on the stack output when ready; the re-audit no longer waits behind a queued export.
  - Capture: `captureStates` and `captureNotices` side by side (notices use their own fresh context; page address / size / user agent read first; `motion.json statesNoticesMs`).
  - `measureSite` (fit pass + fidelity) and the responsive step: 2 pages at a time when 600 MB per page fit (`PAGES_AT_ONCE`), results in page order, the deadline still leaves out the last pages.
  - Measured on fixtures: states 1.9 s + notices 3.0 s → 3.0 s together; 4 pages measured 1.95 → 1.0 s (400 ms per page load); link check beside a stand-in Lighthouse 4.4 → 3.7 s;
    re-audit motion on a one-link page ~0.35 s less (up to the 4 s focus share per page on real sites). Not measured on a live site yet.
  - Tests: `reaudit-motion`, `perf`, `recreate-jobs` (stack in the job / after it / failed), `recreate-widgets` (states + notices side by side = same result), `recreate-crash`, `recreate-responsive`.
- **Added to the plan by the user during step 2** (not started): fonts look bigger in the copy than in the original (match sizes); the new site must fix every problem of the old site's audit
  (fix checklist). **Testing rule (user)**: while fixing, run only the test file of the feature touched; the full suite only when a step is complete (before its commit) and before a merge.
  **Fast iteration (asked)**: capture once, then regenerate from the saved capture (generate + build only) for steps that do not change the capture; full fresh Recreate only for the final check.
  - Tests: `recreate-widgets.test.js` (accordion: every item incl. unprobed ones opens/closes, aria-expanded, no-script closed; React-like carousel: re-rendered panel, dots, next/previous wrap, noise counter).

### Fix everything the audit found (branch `fix-all`, worktree `../Website-Audit-fixall`, from `as-is-fixes`) — WIP
User: the copy must look and work exactly like the original, and change only where that removes a "Still needs work" / "Got worse"
row; SEO, Performance, Accessibility and Best Practices must beat the original on phone and computer; every page Analyze found must
be recreated. All general. Decisions (user): fix everything (contrast colours and bad / duplicate titles + descriptions rewritten,
marked review); "Structured answers" is N/A when neither side has question headings. Diagnosis (real re-audits 2026-10-07): CSS
render-blocking + unused on every site (one shared `css/site.css`, parchaa 480 KB of which 134 KB unread `--framer-*` properties);
contrast "regressions" were axe scanning text mid fade-in (#445063 read as #8f9aaa); DOM size = hidden state copies (panscience 2033
of 2809 elements) + hover-card copies; SEO / AEO / theme-color rows were copied over unchanged.
- **All pages**: Recreate's discovery read only server HTML (a client-rendered site: 1 page vs Analyze's 22). `inspect.js` now
  passes the analysis crawl's pages (`analysisPages`, its crawl.json) as `knownUrls` (crawl seeds + `selectPages` source
  `analysis`) and a browser `render` for shells, like the analysis crawl.
- **Head** (`ir/seoText.js refineHeadTexts`, after every head is built): titles outside 10–60 or duplicated → page heading /
  address + site name; descriptions outside 50–160 or duplicated → paragraphs only that page has; homepage keeps valid own text;
  `theme-color` = brand colour; missing `lang` from the text (`detectLang`, script then stop words, null unless clear).
- **AEO** (`ir/structuredData.js`, after the tree fixers): WebSite + Organization (name, address, icon, social profiles) on the
  homepage and FAQPage from question → answer pairs (headings / summary / dt / buttons, accordion panels included), never a type
  twice; `llms.txt` generated (llmstxt.org) when the original has none (`ir/crawlFiles.js`). Comparator: `aeo.structured-answers`
  N/A when both details are `NO_QUESTIONS` (`audit/analyzers/aeo.js`).
- **CSS** (`emit/css.js emitCss(ir, { page })`, `usedCustomProps`): a page's stylesheet holds only its classes and the
  @keyframes / @font-face they name; custom properties no var() reads are never written. HTML: inline `<style>` per page
  (`emitSite({ inlineCss })`, only the final write in generate; fit pass and refine keep the shared file), minified in the build
  (`build/minify.js minifyInlineStyles`). React / MERN: `page-meta.json` `css` inlined by the prerender, dev server imports the
  whole sheet. Next.js: `app/**/page.css` per route + `experimental.inlineCss`. `report.fixes` `page-css`.
- **DOM size**: a state the page does not start in (`out.tpl` = its set) and a card's hovered look (`tpl: 'hover'`) are written in
  `<template data-w-tpl>` (HTML; JSX via `dangerouslySetInnerHTML` with `emitNode`); `js/motion.js` puts states in place on first
  use (`materialize`, its reveal elements marked shown) and hover looks on first pointerover / focusin. No script: first state,
  rest look. `report.fixes` `state-templates`.
- **Images** (`assets/variants.js`): IR `<img>` carry the width shown per view (`rw`); WebP files at those widths and twice them
  (never wider than the original, a variant not smaller than the original is not written, animated / SVG / < 12 KB left),
  `srcset` with `w` + `sizes` from the breakpoints; added to `assets/manifest.json`. `report.fixes` `responsive-images`.
- **Contrast** (`fixers/contrast.js`, tree fixer, per view): background = nearest backgrounds blended + opacity; below 4.5:1
  (3:1 large) the colour mixes toward black or white by the smallest amount that passes (+0.08); text over a picture / gradient
  left and listed. axe now waits ≤ 3 s for ending animations before scanning (`audit/render.js renderHome`, both sides).
- **Names**: icon-only controls named from what they do (`stateRole` next / previous / item n of N, `wt` toggles "Open menu" /
  "Show more", two icon buttons side by side = Previous / Next).
- **From the first step-6 run (botza.panscience.ai, all four categories already ≥ the original)**: og:image of the
  original unusable (another host answering with a page) → the page's own first screen (`capture/<slug>/desktop-fold.webp`,
  1200 × 630, `generate.js addSocialImages`) as og:image + twitter:image; FAQPage also for a page that is one question (its
  h1) and its answer; the FAQ heading signal only for headings that title an FAQ (`audit/extract.js`, both sides); contrast
  rebuilt: the homepage's axe findings (real browser colours) decide for those elements (`axeContrastFindings`), decorative
  text (aria-hidden, or a watermark ≤ 1.6:1 laid over the layout) drawn by `::before { content }`, the style-based pass only
  for text that fails and not ≤ 1.6:1 (a misread background had turned a lime label olive; 330 needless tweaks before);
  hover probe: `:not(:hover)` / `:not(:focus)` rules follow the forced state while probing (botza "Proven at scale" cards:
  the hidden panel's `opacity: 1` had been lost to `.logo-silo:not(:hover) .silo-content { opacity: 0 }`). Not rebuilt yet:
  effects on siblings (`.card:hover ~ .card`).
- **Measurement parity**: the re-audit's throwaway server gzips text (`servePreview({ compress })`), as any host does.
- **Stack downloads never fail on our own changes**: an app stack (React / Next.js / MERN) is checked against a plain-HTML
  build of the same `ir/site.json` made by the same code (`export/fromIr.js buildStackOutput`, a temporary
  `stacks/<stack>.html-ref.tmp`), not the recreate's older `dist/`; framework mount ids (`ir/names.js MOUNT_IDS`: root,
  __next, app, …) are never written and never count as a difference; equivalence skips `#root` only on the side whose stack
  adds it (`compareBuilds({ appWrapper })`, React / MERN). botza (React original, content in its own `<div id="root">`):
  Next.js export 32/32 DOM, pixels 1.0, hydration clean.
- **Motion rows** (diagnosed side by side on panscience / parchaa): 46 of 48 "missing" hovers were the pairing key — text with
  vs without spaces between blocks, textContent vs innerText → `reaudit/motion.js hoverKey` (tag + lower-case text without white
  space, 40 chars), CSS-rule probe reads visible text before aria-label; loop patterns paired by family (`PATTERN_FAMILY`:
  oscillate = float, drift = marquee). Real losses fixed: a hover that also adds elements keeps its style part (`ir/motion.js`);
  a DOM change that did not undo with the mouse out is not a hover (`keepReverting`); a loop host is never also a reveal (its
  animation replaced the loop); loops inside inline SVG get their token on the element inside the markup (`svgTarget`,
  `tokenizeInSvg`) with rebuilt keyframes. Re-audit page budget 40 → 90 s (a 6600 px page took 46 s and "timed out"), total
  grows per page (≤ 6 × 75 s).
- Fixed on the way: regexes that had lost their backslashes (`emit/html.js` pre-wrap detection `split(/s+/)`, `[w-]`;
  `capture/loops.js repeatOf` `/s+/`). EVIDENCE entries for every new fixer. Tests: `recreate-fix-all.test.js`.
- **parchaa round** (open after a fresh test: unused CSS 11 KiB, DOM 926 → 1100, LCP render delay, responsive images 427 → 82 KiB,
  3 slow fades): (1) per-page `@font-face` keeps only subsets (unicode-range) holding a character the page draws and the
  weights its rules use, picked like the browser's weight matching (400 / 700 always; `emit/css.js pageFontFaces`; homepage
  94 → 19 faces); the font preload takes the subset with most of the page's text (`charsCovered`). (2) `fixers/perf.js
  pruneSprites`: inline SVGs with an id that no view shows (0-size clipping box / hidden) and nothing references (`#id`,
  `url(#id)`, ids inside them, transitively) are removed. (3) `markLayouts`: parts shown in some views only (≥ 3 elements, not
  script-owned: states, notices, hover copies, `w` tokens, `hidden`) get `data-w-lay`; `js/motion.js` (last block) parks the ones
  the stylesheet hides at the current width (comment placeholder) and swaps on resize; in React / Next.js pages only after
  hydration (`__reactFiber` on a part); `window.__sasKeepLayouts` skips it (equivalence hydration check). The original builder
  does the same with script; no-JS pages keep every part. Report fix `dom-size` { sprites, layouts }. (4) The LCP image and its
  ancestors lose entrance tokens (`rv`, `rl`, `rp`, `rN`, `dN`; `fixLoading` → `unfaded`). (5) cover images: variant width
  `sqrt(w·h·ratio)` (file area = box area, as Lighthouse judges). (6) Slow fades: one-way opacity ramps < 0.5 are recorded
  longer (opacity turns count for the early stop), `analyzeSeries` counts turns across still samples, oscillations keep
  `min` / `max`, `scriptLoop` rebuilds opacity oscillations (alternate keyframes); re-audit pairs them as family `fade`
  (`oscillate` on opacity / `blink` / opacity-only `other`). (7) Checklist: a Lighthouse audit failing on both sides whose
  measured value moved on every device (`numericValue`, else metric savings) is improved / regressed (`lighthouseTrend`:
  10 % margin, 2 % for element counts). Tests: `recreate-dom-size.test.js`.

### Desktop only (WIP, user: "remove tablet and mobile from frontend and backend, keep only desktop") — merged into `phase-4a`; **UNDONE in as-is step 4** (branch `step4-mobile`, see above)
History: one view everywhere, the rest parked, not deleted. Step 4 listed all four views again and restored what is below; what stays from it: `KNOWN_*` views, the single-view IR path for older
desktop-only captures, the re-audit "same device on both sides" rule.
- Server: `recreate/views.js ENABLED_VIEWS = ['desktop']` (`RECREATE_VIEWS`, `VIEW_IDS`, `MEDIA_VIEWS` follow it; `KNOWN_VIEWS` / `KNOWN_VIEW_IDS` / `KNOWN_MEDIA_VIEWS` = all four, used by IR tree, CSS emitter, loading fixer so an older
  saved copy keeps its tablet/phone styles when another stack is built). Recreate: `sweep` and `responsive` removed from `STEPS` / `STAGES` (5 steps; no breakpoint refinement). Analyze: `audit/screenshots.js VIEWS` = desktop,
  `lighthouse-mobile` step gone (desktop gets the whole reserve); `scores` / `metricsByDevice` desktop only; `audit.metrics` + weaknesses from desktop.
- Single-view IR: no breakpoints (`{ source: 'single-view' }`, no media queries); a builder's hidden section copies with a visible twin dropped (`tree.js dropHiddenVariants`; a hidden menu without a twin stays); a single ratio is not
  a share of the parent (`styles.js resolveHints`: px kept, 100 % only when filling the parent — a 40 px spinner had become 2.78 %).
- Re-audit: Lighthouse audits compared only on a device both sides measured; `JavaScript shipped` reads full runs, desktop first. Report: desktop scores/metrics, one screenshot per side.
- Client: no Phone/Computer toggles or size buttons (`PreviewFrame VIEWPORTS` = 1440; hidden with one size); "Measured on a computer"; older phone-only checks still display. Tests updated; the four background-sweep tests `skip`ped ("parked").
- **To bring sizes back**: list views in `ENABLED_VIEWS`, restore the two steps in `recreate/index.js`, views in `audit/screenshots.js`, `lighthouse-mobile` in `audit/index.js`, client toggles (git history), un-skip the sweep tests.
- **panscience.xyz** (6 pages, one run each, "before" = `acc4b05`): Analyze 59 → 69 s (noise), **Recreate 711 → 178 s** (inspect 161 → 148, generate 157 → 11, build 88 → 16; sweep 213 s + responsive 89 s gone; "before" used almost
  the whole 12 min and skipped 2 sweep pages), **re-audit 196 → 141 s**; chain ~16 → ~6.5 min. Desktop quality same: fidelity 80 → 81, visual diff 79, 6/6, safety passed, hover 24/24 → 24/25. Cost: tablets/phones get the desktop layout.
  The first "before" run's server exited silently ~5 min into Recreate (not reproduced).

### Robustness found by the all-pages run (WIP, merged into `phase-4a`)
- **Crashed local browser no longer fails a Recreate**: panscience all pages (99, 8 GB, ~1.3 GB free): capture (~29 min) + assets done, then Chromium crashed in the fit pass (`Target crashed`) and 30 min were discarded.
  `verify/layout.js`: `isBrowserCrash(err)`; `openRenderer` `recover(generation)` (new Chromium, same contexts updated in place; renders hit by the same crash share one relaunch; `renderer.recoveries`); `renderPage` and equivalence `snapshot`
  use `withBrowserRetry` (once more). `generate.js measureSite` → `{ started, failed }`: a page still failing is listed, the rest go on (only "no page rendered" throws); fit pass keeps it as generated (`report.generate.fit.failed` + warning);
  fidelity lists it (`fidelity.failed`, in `unscored`) + `fidelity.browserRestarts`. Equivalence never skips a page. Tests: `recreate-crash.test.js`.
- **www. and bare host were two pages**: panscience links both forms; `sameSite` saw one site but the crawler and `selectPages` deduplicated by `urlKey` (full host), so every page was done twice (99 "pages" for ~57, ran the machine
  to ~230 MB free, server ended). `audit/util.js pageKey(url)` = `urlKey` without scheme + `siteHost` (no `www.`), used by `audit/crawler.js` and `recreate/discover.js`; `urlKey` unchanged (asset dedupe). Test in `recreate-capture.test.js`.

### Full-site clone — branch `full-site` (worktree `../Website-Audit-par`), WIP, merged into `phase-4a`
Asked by the user: clone the whole site as is (every page, no link back to the old site, hover / animations / buttons the same), no 20-page cap, no timeouts, little waiting. Plan (approved): **A** all pages + limits that follow the work
+ no live links (A.1, A.2) → **B** measure what differs on panscience (hover, animations, buttons) → **C** fix it generally (incl. small generated scripts for menus / accordions / tabs / carousels) → **D** less waiting.
Decision: links to pages that can't be cloned honestly (login, cart, checkout, account, admin) → **local notice page**; linked files (PDF…) downloaded.
- **A.1**: `projects.recreate_pages = -1` = **All pages** (`inputs.js ALL_PAGES`; default for new projects; PATCH accepts `'all'`; 0–300 still limits). Crawl up to `SITE_PAGE_CAP` = 300 (+50 skipped) at depth 8 (a limit keeps the old sample crawl).
  **Limits follow the work**: `perPage` per step (inspect 150 s, assets 15, generate 45, build 45, preview 3, sweep 120, responsive 30; measured on the 2-core laptop with room); old limits cover `BASE_PAGES` = 6. After discovery, inspect calls
  `ctx.scaleToPages(n)`: job deadline (unless `SAS_RECREATE_MINUTES` fixes it), running capture, `ctx.laterReserve` and every later step's limit grow per extra page. **Stalled page** (not the homepage) abandoned after max(4 min, 3 × slowest so far),
  captured once more at the end in a **fresh browser** (closing the first ends the stalled capture, so no shared folder); only a double stall is reported (`reason: 'stalled'`). Gear dialog: "Every page of the site" checkbox (on), number only when off.
  Tests: `recreate-all-pages.test.js`; fixture ports must be unique per test file (files run in parallel; 4192–4199 taken).
- **A.2 no link leads to the original site**: `ir/links.js createLinkResolver({ assetFile })`: a same-site link that is not a recreated page → (1) the recreated page if only a query-string variant, (2) a **downloaded file** (`{ asset }`),
  (3) else a **local notice page** at the same path (`{ file: outPathFor(path) }`, `resolve.notices`): `ir/notice.js noticePage` = static HTML (no script, inline CSS, `noindex`, reason in plain words, "Back to the homepage"), added to `ir.files`
  by `buildIR` so every stack ships it (HTML `site/`, apps `public/`), never in sitemap.xml. Downloaded platform-CDN files are local; other hosts stay external. `emit/walk.js` reference `{ file }` → `refs.fileHref` (HTML relative; apps `rootFileHref`).
  Assets: `<a>` / `<area>` to files of the site or its CDN collected (`collect.js linkedFileKind`: PDF / Office / archives = **document** → `assets/files/`, 25 MB / 60 s; images, media by kind). Report: `generate.noticePages` (+ `noticePageCount`),
  `generate.links.{file,notice}`; `liveLinks` empty for same-site links. Notice pages verified like pages. canonical / og:url still use the original origin unless `target_domain` is set. Tests: `recreate-generate.test.js`, `recreate-assets.test.js`.
  Not tested yet: notice pages inside a real React / Next.js / MERN build.

### Recreate: sleep and network outages (`recreate/interrupts.js`, branch `recreate-retry`, WIP, merged into `phase-4a`; builds on `audit/interruptions.js`)
Steps are long, so a step is never re-run whole. (1) **Sleep does not count**: each pause the watcher finds is given back at once — job deadline, `ctx.jobDeadline`, every running step's limit and `stepDeadline` move later (`runStep` uses
`extendableTimeout`; a firing step timer first lets the watcher look (`tick()`)). (2) **Only what was hit is repeated, once**: a page capture or a page's sweep widths overlapped by an outage/sleep, even without an error (`recoverHit`; an abandoned
capture that may still write is never repeated); asset downloads that failed at network level (`RETRYABLE_ASSET_REASONS`: timeout, time-limit, dns, refused, error) during an outage, merged into the first round (`mergeDownloads`: same bytes = one file);
discovery's homepage fetch (`recoverFailure`). Before a repeat it waits for the site (≤ 2 min, `NETWORK_WAIT_MS`) and gives back the hit piece's time. generate / build / preview / responsive are local: only (1). (3) **Capped** at 6 min per job
(`ALLOWANCE_MS`). Log line `[recreate <id>] <step>: <what> — <cause> → <outcome>`; `report.interruptions` = { pauses, pausedMs, outages, grantedMs, allowanceMs, events[] }. inspect and sweep read their limits live. `SAS_NETWORK_WATCH=0` = DNS watcher off
(test suite). Tests: `recreate-interrupts.test.js`. Not covered: cross-origin stylesheets in the asset step and the WordPress REST fetch.
- **First real run** (panscience, 2-core laptop, `SAS_MAX_PARALLEL=1`, limit 20): the overloaded process froze 5–10 s at a time (16 "pauses", 142 s; network fine), taken for sleep at the 5 s threshold: homepage captured twice, 305 s given back
  (15.8 min instead of 12). No corruption (second capture overwrote all files), no errors, fidelity 75. Fixed: sleep counts from **30 s** (`PAUSE_MIN_MS`), an outage needs **2 failed DNS checks in a row**, a check that ran far past its timeout
  (process froze) counts as no answer either way. The long inspect came from the page limit (20 of 21 pages, 7-min limit, 3–7 captured) and one view at a time, not from retries.
- **Step list no longer ticks then unticks** (all jobs): `progressTracker` now shows the **first unfinished step of the list**, started or not; a step waiting for the background sweep says "Waiting for “Capturing more widths” to finish".
  Every listed step reports progress (the re-audit leaves `screenshots` out). Tests: `recreate-interrupts.test.js`, `perf.test.js`.

### Phase 4b (approved plan, branch `phase-4b`, worktree `../Website-Audit-4b`) — merged
Decisions: CSS-first motion + one small generated `motion.js` (IntersectionObserver, safety-gated); sweep widths 320/480/600/900/1024/1280/1920; order 4b.6 + 4b.7 → 4b.1–4b.5 → 4b.8–4b.9. All general.
Steps (all ✅): 4b.6.1 sweep measure · 4b.6.2 sweep-driven corrections · 4b.6.3 4th view (laptop 1024) + continuous overflow penalty · 4b.6.x sweep budget / pages lost in inspect (done in 4b.9) ·
4b.7 visual diff · 4b.1 hover/focus capture · 4b.2 scroll-reveal capture · 4b.3 loop capture · 4b.4 IR `motion` + HTML emit · 4b.5 motion in app stacks · 4b.8 re-audit/UI/report · 4b.9 real-site verification.

**Summary**: Recreate carries the original's motion, not just its still layout: responsive fidelity (laptop view, 7-width sweep, breakpoint refinement, fluid type, phone shrink, continuous overflow penalty), perceptual visual diff
(SSIM-style, bands, heatmaps), motion capture (hover/focus, scroll reveals, loops → `capture/<slug>/motion.json`), emitted as `data-motion` tokens + CSS + one fixed `js/motion.js` (scroll reveal only) in all four stacks,
a Motion category in the checklist/NEW panel/report. **Known limits**: page-load entrance effects and effects started by a timer or the first scroll are not rebuilt; script-driven drifts/marquees and loops inside inline SVG
are not rebuilt; reveal counts on timer-driven pages vary between captures; hover coverage limited by the probe budget (~10 elements/page); no exit animation for `rp` reveals.

**4b.6.1 sweep (measures only, never fails a job)**
- Last Recreate step `responsive` ("Checking responsive layout", `recreate/responsive.js`). Budget 10 → **12 min** (`recreateBudgetMs`; +2 for the sweep). < ~33 s left → skipped + warning; homepage first, other pages while one more fits.
- Original (`capture/sweep.js`): each page at every width like the 3 captures (`settle`: lazy content, scroll-reveal pinned), full page ≤ 8000 px, DPR 1, < 600 = mobile viewport (both sides), 4 contexts → `capture/<slug>/sweep/<width>-full.webp`; height + `scrollWidth` recorded.
- Recreate (`verify/responsive.js`): `dist/` served locally, JS off, other origins aborted → `fidelity/<slug>/sweep/<width>-full.webp`; HTTP ≥ 400 = error for that width.
- Score per width: `visual` 65 % + `height` 35 % (`1 − 4·|ratio − 1|`), −15 for a new horizontal overflow. `low` = < 80 (since 4b.7: visual < 65) or new overflow; flags `taller` / `shorter` / `overflow` / `visual`.
- `report.responsive = { status: done|skipped|failed, widths, threshold, score, byWidth, driftCount, measured, worst[], pages[{ path, outPath, slug, score, drift[], widths{} }], skipped[] }` + warnings; nothing measured → `failed`.
  Tests: `recreate-responsive.test.js` (scoring, summary, capture, faithful copy ≥ 95, fixed-width container flagged at 320).

**4b.6.2 sweep decides (still never fails a job)**
- Steps: `inspect` → **`sweep`** ("Capturing more widths", `recreate/sweep.js`, `capture/sweep.json`, `ctx.sweep`; ≤ 4 min, never into `jobDeadline − LATER_STEPS_RESERVE`) → `assets` → `generate` (+ refine) → `build` → `preview` →
  **`responsive`** (≤ 90 s). `sweep` and `responsive` are `optional`: timeout/error = warning.
- **Refinement** (`verify/refine.js`, in generate after the fit pass, ≤ 90 s, first 3 pages): variants of `css/site.css` served as an override and scored at sweep widths; nothing rebuilt, IR untouched until a variant wins.
  1. Breakpoints: tablet ∈ {899.98, 1023.98, 1279.98, 1439.98} on 900/1024/1280, mobile ∈ {479.98, 599.98, 767.98} on 480/600; the site's own value (`source: 'site'`) replaced only when ≥ 3 points better → `source: 'sweep'`.
  2. Fluid type (`ir/fluid.js`): font size / line height whose 3 px values lie on one line (±max(0.5 px, 2 %)) → `clamp(min, calc(a + b vw), max)`, replaced stepped overrides dropped; kept when the sweep gains ≥ 1.
  3. Phone shrink: mobile font sizes ≥ 24 px → `min(X px, Y vw)`, judged on 320, ≥ 1 point.
  Result in `report.generate.responsive` and `report.responsive.refined`; the IR carries it, so every stack gets it.
- General fixes (`ir/styles.js`): an absolute/fixed box stretched by two insets, or as wide as its containing block, gets no px width (`width: 100%`); px-width form controls/buttons get `max-width: 100%`.
- Real sites (API, temp data dir `C:\sasd` — short path needed, the scratchpad path exceeded Windows' 260 chars): parchaa.com own tablet bp 1319.98 scored 54.1 vs 77.7 for 899.98; mobile 767.98 → 599.98 (58.3 → 66.5); fidelity 88–89
  (shrink 70.7 → 68 correctly rejected). panscience tablet 1024.98 → 899.98 (54.9 → 69), mobile kept, fidelity 80. Neither site has fluid-type candidates.
- Open then: parchaa `/` at 900 (stacked original vs squeezed 1440 layout → needed a 4th view); panscience `/` and `/ventures` overflow at 320 (doc 344 px) despite fixing causes one by one (all-or-nothing score);
  4a cases (parchaa `/solutions` mobile alignment, panscience `/ventures` tablet/desktop drift) not solved; `/solutions` is not in parchaa's default page set.

**4b.7 perceptual visual diff** (`verify/visualDiff.js`, `visualDiff(original, generated, { heatmap })`)
- Both full-page shots scaled to one width, compared block by block on luma (SSIM: mean, contrast, structure) × a mean-colour factor, at **detail** (8 px blocks at 384 px wide, sigma 2 blur) and **layout** (4 px blocks at 96 px), 50/50.
  Rows only one page has count as different. Output 0–1, `scales`, 10 `bands`, `worst` (< 0.7), `heightOnlyOne`, heatmap WebP (red = differs).
- Fidelity keeps formula + threshold 80 (old colour-distance `visual`, comparable with earlier phases) and **adds** `views[v].diff` (`score` 0–100, scales, bands, worst, `heatmap` = `fidelity/<slug>/<view>-diff.webp`), `pages[].diff`,
  `fidelity.diff` (`score`, `threshold` **65**, `status`, `lowPages`; `flagDiff`) + warnings. The sweep (+ refinement) uses it as its visual term; drift = visual < 65, height off, or new overflow (`low = flags.length > 0`; the 80 threshold
  flagged 34/42). `verify/equivalence.js` keeps the old `visualSimilarity` on purpose.
- Calibration (111 real pairs): ranks like the old score but stricter (mean 0.695 vs 0.847): near-identical 0.95–0.999, decent 0.75–0.9, broken ≤ 0.55 (parchaa `/` at 900: 0.52). ~0.1–1 s per view.
- Bug found by the heatmap: fidelity and sweep shots didn't load `loading="lazy"` images (recreate scored down since 4a.6). `layout.js loadLazyImages` (eager + decode, ≤ 6 s) now runs before both (fit pass unchanged).
- API/UI: `GET …/recreate/:recreateId/fidelity/:slug/:file` (`{desktop,tablet,mobile}-{full,diff}.webp`). NEW panel: **Visual difference** (band strip of the worst view, score, heatmap link per view, low ones warn)
  and **Between the captured widths** (score per width, drift count, adjusted breakpoints, fluid type). Tests: `recreate-visualdiff.test.js`.

**4b.6.3 laptop view + continuous overflow penalty**
- `recreate/views.js RECREATE_VIEWS` = desktop 1440, **laptop 1024** (not mobile, 768 high), tablet 768, mobile 375. Used by `VIEW_IDS` (ir/tree.js), capture (4 contexts per page), `verify/layout.js`, `fixers/perf.js` first-screen heights.
  Analysis screenshots and stack equivalence keep 3 views (`audit/screenshots.js VIEWS`). A missing laptop capture is skipped by the cascade; desktop is the only required view.
- CSS: rules get `parts.laptop`; each view diffs against the next wider one, media queries stack widest first (`emit/css.js`); laptop without a breakpoint → `DEFAULT_BREAKPOINTS.laptop` 1279.98. `ir.breakpoints = { laptop?, tablet, mobile, source }`.
- `pickBreakpoints(queries, { laptop })`: laptop = widest boundary in [1024, 1440), tablet in [768, 1024), mobile in [375, 768) (defaults 1279.98 / 1023.98 / 767.98). Framer's tablet variant 810–1199 now maps exactly. Without laptop: old rule (tablet in [768, 1440)).
- Fluid type requires the laptop value on the line too; `refine.js` searches laptop on 1280 (1279.98 / 1439.98), tablet on 900 (899.98 / 1023.98), mobile on 480/600.
- Overflow penalty (`compareWidth`): `overflowPx` beyond the original's (− 2 px slack); penalty = 15 × min(1, overflowPx / (0.15 × width)), ≥ 1; `overflow` stays a flag.
- Bug found: the loading fixer had no first-screen height for `laptop`, so no image was ever lazy (caught by the pipeline test).
- parchaa.com: homepage visual at 900/1024/1280 **48/48/48 → 81/84/74**, contact 64/67/68 → 89/97/84, a blog page 47/46/54 → 55/99/56; fidelity 88 → 91, visual diff 86; sweep reached 6 pages; breakpoints laptop 1319.98 (site),
  tablet 809.98 (site), mobile 599.98 (sweep). Still weak: blog pages at 900/1280 (~55) and at 480/600 (only the 375 capture between 375 and 768).

**4b.1 hover / focus capture**
- Desktop view only, in `captureView` after screenshots + snapshot (`capture/interactions.js captureInteractions`), 8 s per page (`inspect.js MOTION_BUDGET`; skipped when inspect has no time). → `capture/<slug>/motion.json`;
  `report.pages[].motion` counts, `report.motion` = { status, pages, hover, focus, rules, errors, notProbed }.
- (1) CSS: every `:hover` / `:focus` / `:focus-visible` / `:focus-within` / `:active` rule of readable sheets as authored (`rules[]`: selector, state, media, declarations; unreadable cross-origin sheets counted).
  (2) Probe: mouse onto the element, computed styles compared to just before — finds script-driven hovers too.
- Candidates: links, buttons, fields, roles, `tabindex`, then `cursor: pointer` tops, then transition hosts (not inside a chosen one, 3 levels); equal elements (tag + role + classes + parent) probed 3× (`groups[]` counts the rest); limit 40.
  ~45 visual properties compared for the element, ::before/::after (+ size/position) and descendants (3 levels, ≤ 24). Entry: `path` (snapshot path like `body>div:1>a:2`), `changes {prop: [from, to]}`, `pseudo`,
  `kids[{path, changes, transition}]`, `transition` (+ `transitionOut`), `layout` + `rect` delta (offset boxes), `domDelta`. Covered elements skipped + counted; no-change counted, not listed.
- Scroll is not hover (panscience reveal hosts looked like 1.4 s opacity hovers): rest state read with the mouse out after scrolling, re-read until stable; on-screen elements not scrolled. Focus: Tab from the top (start reset by focusing body),
  focused vs **blurred** state of the same element; `outline-style: auto` is not a change. Hover ≤ 60 % of the budget, focus the rest; ≤ 80 Tab stops.
- Tests: `recreate-motion.test.js` (+ fixture in `recreate-capture.test.js`: `:hover` rule on nav links, `hover.js` script-only hover on the logo).
- panscience: 120 rules, hover on nav links (colour 0.2 s), "Contact Us" (transform 0.25 s), reveal false positives gone, no custom focus styles. parchaa (before the scroll fix): 118 hover, 111 focus, 99 rules / 5 pages.

**4b.2 scroll-reveal capture** (`capture/reveal.js`; tracker moved from `capture/index.js`; `settle(page, view, cap, { observe })`)
- Desktop view with motion budget (`observe`); other views only pin the end state. → `motion.json.reveal = { version, elements[], groups[], stats }`; totals in `report.motion.reveal` (revealed, declared, sampled, unmeasured, replay, timed, groups, staggered).
- (1) Declared: `getAnimations()` read before the tracker finishes it (transitions, CSS animations, WAAPI: duration, delay, endDelay, easing, keyframes; first/last transform + filter resolved to matrices).
  (2) Sampled: rAF recorder of opacity + transform on elements that start hidden (≤ 400 elements, ≤ 90 samples) → duration (to 99 %) + easing fitted to a cubic-bezier (named first, then local search; `error` = RMSE).
- Element: `path`, `tag`, `text`, `rect`, `from`/`to` { opacity, transform, filter, `motion` { translate, scale, rotate } }, `timing` { source: transition|animation|waapi|sampled|unmeasured, duration, delay (null if sampled),
  easing { css, fit, bezier?, error? }, `parts` }, `keyframes` (> 2), `trigger` { kind: scroll|timed, step, topBefore, topAfter }, `replay`, `group`, `offsetMs`.
- Groups: same parent + same scroll step; singletons regroup by grandparent + same from/duration/easing. Stagger = ≥ 3 members with a constant start step (|step| ≥ 15 ms, jitter ≤ max(30 ms, 35 %)) → `group.stagger = { stepMs, jitterMs, order }`.
- Limits: opacity-hidden reveals only; load-time effects and loops not covered; trigger bounded by the scroll step (85 % of a viewport). Script-animated elements waited ≤ 1.5 s per step; declared ones finished at once.
- panscience: 130 reveals (124 declared, 6 sampled), 59 groups, 9 staggered; sections `700 ms cubic-bezier(0.16, 1, 0.3, 1)` from opacity 0 + translateY(16px), list items staggered ~50–70 ms; hero words timer-driven ('timed'); `/media` none.
- Tests: `recreate-reveal.test.js` (+ services fixture in `recreate-generate.test.js`).

**4b.3 loop capture** (`capture/loops.js`, desktop with motion budget, **after the snapshot and before screenshots** — `animations: 'disabled'` cancels infinite animations; ~2.7 s/page outside the hover budget)
- → `motion.json.loops = { version, loops[], stats }`; totals in `report.motion.loops` (css, waapi, script, scrollLinked, paused, patterns{}).
- Declared (`scanAnimations`): `document.getAnimations()` minus transitions, iterations > 1 or scroll/view timeline; exact timing, keyframes as authored (`translateX(-50%)` kept), pseudo target, `inStylesheet`
  (its @keyframes is in a readable sheet = already carried; false = WAAPI / unreadable, to rebuild).
- Script-driven (`findScriptLoops`): transform/opacity/rotate/translate/scale of ≤ 6000 elements compared 450 ms apart; changers without an animation object recorded per frame 2.2 s (≤ 40, biggest first) → `analyzeSeries`:
  `spin` (deg/s), `drift` (px/s, wrap, period), `oscillate` (period, amplitude), `ramp` / `move`. SMIL `<animate>` and canvas/video invisible to both paths.
- Pattern (`classifyKeyframes`): spin, sway, marquee/ticker (one way, ≥ 20 px or 10 %), float/sway (alternate or round trip, ≥ 4 px), pulse, blink, dash, background-scroll, cycle (holds: rotators), jiggle, other.
  Loop: `path`, `pseudo?`, `source` (css-animation|waapi|script), `name`, `pattern`, `params`, `timing`, `keyframes`, `rect`.
- panscience: 32 CSS + 2 script loops (word rotator cycle 8.77 s, marquees `psi-drift-l/r` ±50 % 36/52 s, spinners 80/60 s, dashed spokes, node float 6 px, blink dot; all `inStylesheet`); fidelity 80.
- Tests: `recreate-loops.test.js` (+ services fixture spinner).

**4b.4 IR `motion` + plain HTML** (`ir/motion.js`, in `generateStage` after `prepareSite`)
- `motion.json` matched to the merged tree by desktop snapshot path (`cpath`; a wrapper removed by `cleanTree` passes `cpathAlt`). Tokens in ONE attribute, `data-motion="h1 rv r2 d70 rp"`; equal effects share a token (one rule per effect, no original class needed).
  `ir.motion = { version, hover[], focus[], reveal[], delays[], loops[], script }` (absent when unused); `report.generate.motion` = counts, skip reasons, `script`.
- Hover/focus (CSS only): `[data-motion~=hN]:hover { end values }` (+ pseudo, + descendants via `hNkM`) in `@media (hover: hover)`; focus as `:focus-visible`. Skipped: DOM-changing effects, no usable value; undownloaded `url()` dropped.
- Scroll reveal (`scroll` triggers only, `timed` skipped): from-state via individual `opacity` / `translate` / `scale` / `rotate` / `filter`, hidden under `.js-motion [data-motion~=rN]:not(.is-in)`, `@keyframes m-rN { from {…} }` on `.is-in`
  (captured duration + easing, `animation-delay: var(--md)` from `dNN` = stagger, `backwards` fill), all in `@media (prefers-reduced-motion: no-preference)`. End state never written.
- **`js/motion.js`** (`emit/motionScript.js`, fixed ~1 KB, same for every site, only when reveals exist, `<script src defer>` in each head): sets `js-motion` on `<html>`, adds `is-in` to `[data-motion~=rv]` at 10 % in view
  (rootMargin −8 % bottom), removes it for `rp`. No script / reduced motion = finished page. Hover, focus, loops need no script.
- Loops: an animation the element's style already names = `carried`; WAAPI and script spin/oscillation → `@keyframes m-lN` + `[data-motion~=lN]`. Skipped: script drift/marquee (needs duplicated content), scroll-linked, pseudo loops not in the sheet,
  `url()` in keyframes, elements missing from the IR.
- Safety/preview: `motion` profile (`verify/appProfiles.js`): exactly `<script src="(../)*js/motion.js" defer>`, only JS file `js/motion.js` (sink-scanned). `report.outputs.html.scripts = true` → preview (`routes/recreate.js latestBuild`, `jobs.js`,
  `reaudit/index.js`) gets `script-src 'self'`, app frames with `allow-scripts`; preview step requests `js/motion.js`. Fidelity, fit pass, sweep and equivalence render with JS off.
- panscience: safety passed, fidelity 81, 109 reveals → ONE effect (700 ms, translateY 16 px) + stagger delays 70/120/130/220 ms, 27 hover elements in 9 effects, 26 CSS loops carried; browser check: reveals hidden at start, none left after scrolling, no errors.
- Tests: `recreate-motion-ir.test.js` (tokens, CSS, script tag, safety, real browser incl. no-script/reduced motion); `recreate-generate.test.js` (structure assertions ignore `data-motion`).

**4b.5 motion in app stacks**: when `ir.motion.script` is set, React+Vite, Next.js and MERN client ship the same `js/motion.js` as `public/js/motion.js` (→ `/js/motion.js`), deferred tag in each head: React/MERN via `page-meta.json` → prerender,
Next.js `<script src="/js/motion.js" defer />` in each `page.jsx` (React only hoists *async* scripts). Safety: `vite` / `next` profiles allow exactly `<script src="/js/motion.js">` (no type, no inline), sink-scanned; MERN CSP `script-src 'self'`.
Equivalence ignores `js-motion` (on html/body) and `is-in` in `class`. panscience re-exported as all three: DOM 6/6, pixels 1.0, hydration 6/6, safety passed, browser check OK. Gotcha: `POST …/export` returns the recorded output, so deleting
`stacks/` by hand is not a rebuild (delete `outputs.<stack>` from the report/DB first). Tests: `recreate-react/next/mern.test.js` real exports carry a reveal.

**4b.8 re-audit, NEW panel, report**
- Hover control step (`interactions.js keepReverting`): after a change, mouse leaves and state is re-read; non-reverting changes (entrance, timer, loop) dropped → `stats.notReverted`. Judged per part (element, pseudo, each descendant). panscience hover 31 → 24.
- Re-audit step `motion` (`reaudit/motion.js`, before `compare`, weight 5, never fails): recreated pages (≤ 6, 40 s each, 150 s total) opened on the throwaway server (JS on, only that origin) and measured with `capture/measure.js measureMotion`
  (reveal, loops, hover; hover budget 10 s ≥ the capture's 8 s — a shorter budget looked like lost effects). `skip: ['motion']` omits it.
- Rows (category `motion`, between Best practices and Platform): `motion.reveal` (count + typical duration), `motion.hover` (paired by tag + text, + same changed properties), `motion.loops` (paired by pattern). ≥ 90 % `pass`, 50–90 % `open`, < 50 % `regressed`;
  no row for kinds the original lacks. `checklist.motion = { pages, reveal, hover, loops, failed[], skipped[] }` (also `audit.recreate.motion`).
- NEW panel **Motion** section (counts, script, what wasn't rebuilt and why, timed effects); Safety row "only the generated reveal script". Report: Motion row + script-aware Safety row.
- Tests: `reaudit-motion.test.js`, `recreate-motion.test.js`.

**4b.9 real-site verification** (fresh Recreate, three app stacks exported, every stack served under the real preview policy and measured with `reaudit/motion.js` + browser pass)
- **parchaa.com** (Framer, 6 pages): fidelity 91, visual diff 89, widths 73. Original: 15 hover + 13 focus, 44 reveals (41 scroll, all sampled, ~1130 ms), 20 loops (19 script, 15 spinners). Rebuilt: 15 hover (6 effects), 13 focus, 41 reveals (38 effects, 4 repeat),
  16 loops (script spins → CSS); 4 script drifts not rebuilt. Checklist: reveal 38/41 pass, hover 12/15 open, loops 16/20 open; LH mobile perf 48 → 70, SEO 92 → 100. All stacks identical, DOM 6/6, pixels 1.0, hydration clean, safety passed; JS gz 107 KB (React, MERN) / 243 KB (Next).
- **panscience.xyz** (Next.js, 6 pages): fidelity 80, visual diff 79, widths 76. 23 hover, 34 reveals (+ 81 timer/"first scroll" ones not rebuilt), 34 loops (26 carried, 8 SVG spokes / script fades not rebuilt). Every stack: reveal 34/34 pass, hover 22/23 pass, loops 27/34 open;
  DOM 6/6, pixels 1.0, hydration clean, safety passed; JS gz 99 / 244 KB. `rp` elements hide again on leaving, as in the original.
- Fixed (general): (1) loops paired by pattern only (script loops have no duration; parchaa showed 1/20); (2) reveal capture non-deterministic on timer / first-scroll pages: a reveal counts as scroll only when the element enters view
  (below the screen before the step, ≤ 1.35 viewport heights below the top after: `SCROLL_REVEAL_MAX_TOP_AFTER`), else `timed`, never rebuilt; (3) a stalled page killed inspect at 420 s: pages are abandoned 5 s before the limit
  (`inspect.js PAGE_LIMIT_MARGIN`, captured pages kept, rest linked live); (4) a local page missing `load` in 15 s failed the fit pass: `verify/goto.js gotoLocal` retries once with double time. (3)/(4) seen with ~1.8 of 8 GB free.
- Determinism (two panscience recreates): hover 23/24, loops 34/34, fidelity 80/80, visual diff 79/79; scroll reveals 34/76 (`/media` 0 or 27, `/ecosystem` 0 or 3: depends on when the page's timer fires). Consistent within one run.
- Calibration: Motion thresholds separate real cases (reveal/hover 86–100 %, loops 79–80 % for real limits). Visual diff 65 and fidelity 80 unchanged (final: fidelity 80–91, diff 79–89, widths 73–76). Motion CSS small (parchaa 11 of 318 KB; 38 effects for 41 elements, not clustered).
- Timing: panscience Recreate ~9.5 of 12 min (inspect ~2, sweep ~3.5, responsive ~1.5); motion capture +7–8 s/page; re-audit motion ≤ 10 s hover + ~25 s/page, ≤ 6 pages.

### Phase 6 (approved plan, branch `phase-6`) — merged
Every recreate can be built as **four stacks** from the same saved IR (`ir/site.json`), each checked against the plain-HTML build (the reference: fit pass, `dist/`, fidelity): Plain HTML, React + Vite, Next.js (App Router, static export),
MERN (React client + Express server storing form submissions in MongoDB). The project's stack is built right after the recreate; others later from the saved IR without recapture; each has its own preview, zip and re-audit.
Steps (all ✅): 6.1 zip · 6.2 foundation · 6.3 React+Vite · 6.4 Next.js · 6.5 MERN · 6.6 re-audit + UI · 6.7 real-site verification.
**Decisions (approved)**: toolchains on demand; React/Next hydrate and the checklist shows the JS cost; MERN v1 = form endpoint + MongoDB (no e-mail, CMS, accounts; login, search, file-upload forms left alone and reported);
export without recapture; Next.js `trailingSlash: true` (`about.html` → `/about/`, with `_redirects` + `vercel.json`, canonical/sitemap on new URLs); Next.js pinned 15.5.27 (15.3.3 flagged vulnerable, CVE-2025-66478).
**How every stack is verified** (nothing kept on failure): source scan → pinned build → app-rule scan (`verify/appProfiles.js`: only the framework's scripts, never `unsafe-inline`) → links/assets/HTML → **equivalence with the HTML build**
(`verify/equivalence.js`: same DOM (URLs resolved, moved pages mapped), ≥ 97 % pixels on every page/view with JS off; hydration without errors/DOM change with JS on = warning otherwise). Fidelity not re-measured (needs in-memory trees):
`outputs[stack].fidelity = { score: <HTML build's>, basis: 'equivalent-to-html' }`.

**6.1 zip** (`recreate/export/zip.js`, `GET …/recreate/:recreateId/download`): streamed (archiver, nothing stored/buffered); `<host>-<stack>/{README.md, RECREATE-REPORT.md, site/ (= dist/), unminified/ (readable css/js differing from dist)}`;
never capture/, fidelity/, ir/, report.json, dotfiles or links. Limits 350 MB / 5000 files (413 before the first byte); webp/png/woff2/mp4… stored, rest deflated. Only with `report.safety.safe` and a matching `?stack=`.
HEAD plans without streaming (app checks first, shows `X-Download-Error`). Test: `recreate-export.test.js`.

**6.2 foundation**
- Registry (`recreate/emit/index.js`): per stack id (`html`, `react-vite`, `nextjs`, `mern`) `{ id, label, status, toolchain, scripts, assetsTarget, emit(ir, opts) → { files: Map, assets: Set }, build?(o) }`. `projects.js STACKS` and the Recreate gate
  (`isReadyStack`) come from it; `GET /api/stacks` lists them with `toolchainInstalled` (+ `setup` command).
- Walker (`emit/walk.js`): `refValue` (resolves `{asset,page,anchor,live,external}` via `refs`: `assetHref`, `pageHref`, `stylesheetHref`, `useAsset`), `describeNode`, `headTags`, `safeJsonLd`, `relativeRefs`. `emit/html.js` only serialises
  (output byte-identical to before on 8 real IRs). `emit/write.js writeProject` (was `generate.js writeSite`) writes files + hard-linked assets to `assetsTarget`.
- Report: `report.stack`; `report.outputs[stackId] = { status:'ready', dir, … }` (`html` → `dist`, set by build; others by export). Pre-6.2 reports count as `{ [stack]: dist }` (`reportOutputs`).
- Export (`export/fromIr.js`, `POST …/recreate/:recreateId/export { stack }`): `ir/site.json` + `assets/manifest.json` → `emit` → `stacks/<stack>.tmp` → optional `build` → `stacks/<stack>/`; outputs written to DB row + `report.json`.
  Idempotent (200 existing / 201 new), under the global lock, 409 planned stack or missing toolchain, 404 IR/assets pruned, nothing left on failure. Lives in the recreate folder (retention covers it).
- Toolchains: `npm run setup:toolchains -w server -- react-vite` (`--ignore-scripts`; no argument = status). `src/toolchains/index.js toolchainStatus(id)`. Tests: `recreate-stacks.test.js`.

**6.3 React + Vite** (`scripts: true`, toolchain `react-vite`, `recreate/emit/react/`)
- `jsx.js` (React prop names, boolean attrs, `defaultValue`/`defaultChecked`, `style` → objects, text/attrs as JS strings when JSX would change them, adjacent text merged, inline SVG = `<svg>` + `dangerouslySetInnerHTML`),
  `components.js` (subtrees identical on ≥ 2 pages and ≥ 6 nodes → shared component, structural signature, maximal subtrees, named from the semantic class), `scaffold.js` (package.json pinned, vite.config, `src/pages.js`, `main.jsx`,
  `entry-server.jsx`, `scripts/prerender.mjs`, README), `index.js` (`emitReact`). URLs **root-relative** (deploy at a domain root).
- `npm run build` = `vite build` + `vite build --ssr` + prerender: each page as HTML at its path (`dist/about/index.html`), hydrated by `main.jsx` (no top-level await: deadlocks with the shared chunk). Heads from `headTags` → `src/page-meta.json`;
  `#root { display: contents }`; React 19 image preload hints stripped (`fetchpriority` kept).
- `build/toolchain.js runToolchain`: junction `node_modules` → toolchain, `node vite.js` child process (minimal env, 4-min limit, output tail in errors), junction removed with `rmdir` (never recursive). No download, no scripts.
- `emit/react/build.js buildReact`: (1) `scanProject`; (2) build; (3) safety v2 `scanSite(dist, { app: true })`: only `<script type=module src=/_app/*.js>` + `modulepreload` of `/_app`; JS must not use eval / new Function / document.write / importScripts /
  XHR / WebSocket / EventSource / sendBeacon / fetch / import() of another origin (page/component chunks skipped: covered by DOM equivalence); (4) `verifySite`; (5) equivalence (DOM equal, ≥ 0.97 on 3 views, lazy images loaded; hydration problem = warning).
  DOM/visual difference fails the export → `outputs[stack] = { status: 'failed', error }`. Output also: `build` (steps, JS/CSS bytes + gzip), `safety`, `verify`, `equivalence`, `hydration`, `warnings`, `dist: 'dist'`.
- Wiring: a non-HTML project stack queues `exportStack` after the job (`recreate/jobs.js queueStackExport`; failure never discards the recreate); preview serves the stack output when ready, else `dist` (`latestBuild`);
  `previewHeaders({ scripts })` adds `script-src 'self'`, `info.scripts` → `allow-scripts`; `startPreview` keyed by recreate + folder + script policy. Zip of a stack = project source (no `dist`, `.ssr`, `node_modules`) + report with a build section.
- Saved real IRs: panscience (2 components, 98 KB gz), parchaa (6, 97 KB), a clone (42, 107 KB), fixture — all DOM-equal, visual 1.0, hydration clean. Tests: `recreate-react.test.js` (incl. a deliberate emitter bug caught).

**6.4 Next.js** (`scripts: 'inline'`, toolchain `next`, `recreate/emit/next/`)
- App Router, `output: 'export'`, `trailingSlash: true`. Pages `app/<group>/<route>/page.jsx`, shared `components/*.jsx` (`@/components/…` via jsconfig), `app/site.css` imported by each root layout, plain `<a>` links.
  No `app/layout`; one route group `(site)`, `(site-2)`… per distinct `<html lang class>` + `<body class>`. Head: `<title>/<meta>/<link>` + JSON-LD as elements (hoisted; JSON-LD stays in body); charset/viewport left to Next;
  bare attributes written as `""` (else hydration duplicates a preload).
- URL changes (`next/routes.js`): `about.html` → `/about/`, `blog/first-post.html` → `/blog/first-post/`; folder pages and `/` unchanged; segments made router-safe (no leading `_`/`.`, brackets, parens, spaces), collisions `-2`.
  `outputs.nextjs.urlChanges = [{ from, to }]` + warning; `public/_redirects` + `vercel.json` only when something moved; canonical, `og:url`, sitemap use new URLs (robots.txt, llms.txt, JSON-LD copied as is). README lists moves.
- Build (`next/build.js buildNext`): 6-min limit, env `NEXT_TELEMETRY_DISABLED`, `NEXT_IGNORE_INCORRECT_LOCKFILE`; `.next` removed; `dist = 'out'`. Same stages as React; moved pages compared at the new URL (`urlMap`).
- Safety profile `next`: `<script src=/_next/static/…js>` (no type) and inline `self.__next_f.push(<JSON array>)` (must parse); sink scan allows `fetch()` and `XMLHttpRequest`; `chunks/app/*` skipped. `scanProject` covers `app/` layouts + root config, not `page.jsx` / `components/`.
- Preview: per HTML response `script-src 'self' 'sha256-…'` for its inline scripts (`recreate/inlineScripts.js`), never `'unsafe-inline'`.
- Equivalence ignores `<script>`, `next-route-announcer`, empty `div[hidden]`; JSON-LD read from the whole document; `/x/` = `/x/index.html`; hydration on `#root` or `document`. Zip excludes `out`, `.next`.
- JS ~243 KB gz vs ~98 KB React. Tests: `recreate-next.test.js`.

**6.5 MERN** (`scripts: true`, toolchain `mern`, `recreate/emit/mern/`)
- `client/` = React emitter output with forms rewired; `server/` = fixed template (`template/server/**`) + generated `forms.json` + `package.json`; root `package.json` (`install:all`, `build`, `start`, `dev:client`, `dev:server`, `test`), `docker-compose.yml` (local MongoDB), README, `.gitignore`.
- Server: Express serves `client/dist` (CSP, nosniff, Referrer-Policy, X-Frame-Options, COOP, Permissions-Policy, compression, immutable `/assets` + `/_app`, `404.html`), `GET /api/health`, `POST /api/forms/:id`, `GET /thanks`.
  Env: `PORT`, `SITE_DIR`, `MONGODB_URI`, `FORMS_DB`, `FORMS_COLLECTION`, `FORMS_STORE=memory`, `TRUST_PROXY`. No/unreachable MongoDB → site served, endpoint 503; write failure = 503 without the reason.
- Forms (`mern/forms.js`): a form with named fields → `{ id: <page>-<n>, page, fields }`, posts to `/api/forms/<id>` (`action` + `method=post`, `enctype` dropped; no-JS → `/thanks`). Skipped + reported: GET / search forms, password (login) or file inputs,
  no named fields. Hidden inputs never stored. Validation: defined fields only, required, email/url/number (min/max), choices, length caps (maxlength, 2000 / 10000), non-strings rejected, control chars removed, `pattern` not evaluated (ReDoS);
  same-site `Origin` (403), rate limit 20/hour/address (429 + Retry-After), 100 KB body. Stored `{ formId, page, values, receivedAt, userAgent }`.
- Build (`mern/build.js buildMern`): client via `buildReact` (`sigOptions: { ignoreFormActions }`), then 15 server tests (`node --test`, junction): validation, store vs a stand-in driver, app (headers, static, JSON + browser posts, 422/404/403/400/413/503/429),
  `site.test.js` (every page of the real `client/dist` served, every form present with its action). Output: `dist: 'client/dist'`, `forms: { stored, skipped }`, `server.tests`. Zip: client + server sources, `.gitignore` + `.env.example` kept,
  `node_modules`/`.ssr`/`.next` anywhere and `dist`/`out` at top or under client/server left out; report has a forms section.
- Tests: `recreate-mern.test.js`; shipped tests `template/server/test/*.test.js`.

**6.6 re-audit + UI know the stack**
- `export/fromIr.js`: `outputRoot`, `targetStack(report, projectStack)` (project stack if ready, else HTML — same rule as the preview), `outputPages(report, stack)` (`[{ outPath, path }]`). `runReaudit` serves that folder
  (`servePreview({ connectSelf, scripts })`, so Lighthouse measures what visitors get), seeds the crawl with the output's URLs, stores `stack` / `stackLabel`. `compareAudits({ output })` pairs pages at new URLs (`scope.js pathOnNew`).
- Runtime rows: an OLD platform the output ships on purpose (`emitter.runtimes`: react-vite `react`, nextjs `nextjs`+`react`, mern `react`) → `na`, "<Name> runtime kept on purpose (<Stack> output)"; others `fixed` when gone. `finish()` honours `preset` + `statusLabel`.
- **JavaScript shipped** (`stack.javascript`, performance): before = Lighthouse `resource-summary` script transfer size; after = build's **gzipped** bundles (`outputs[stack].build.js.gzipBytes`; local preview doesn't compress), or Lighthouse's figure without bundles.
  `fixed` (none left), `improved` (< 90 %), `regressed` (> 110 %), else `changed` ("About the same" / "Not compared"). `checklist.stack = { id, label, jsBytes }`.
- Contract: `audit.recreate.stack`, `stackLabel`, `output`; stale reason `'stack'` (target build changed or finished after the re-audit). Preview reports `stack`. `exportStack` records every failure as `{ status: 'failed', error }`.
- UI: `client/src/stacks.js` (`outputsOf`, `outputState` ready|failed|building|none, `shownStack`, `pageOf`). NEW panel: stack chip (warn when HTML fallback; "Building…"), page picker / URL follow output URLs, polling of the queued build (preview then moves
  onto it, audit reloads), `StackOutput` card (building / failed + "Build again" / not built + "Build" / ready: equivalence, hydration, safety, JS shipped, fidelity, URL changes, forms + server tests, warnings), MERN **forms note**
  ("this preview shows the client only; run `npm start`"), footer stack picker + Download ("Build & download" when not built). `FixReport`: stack badge, footnote of the audited build, stale text. `RECREATE_STACKS` has all four.
- Tests: `reaudit-stack.test.js`. Checked in the real app with projects in each state.

**6.7 real-site verification** (API on a temp data dir, default page limit, Analyze → Recreate with an app stack → other stacks exported → every stack re-audited + downloaded; 0 errors)
| Site | Stack | Build | JS gz | Equiv. DOM/px/hydr. | LH mobile perf·SEO·a11y (orig → now) | Checklist fixed/regr/open | JS shipped |
|---|---|---|---|---|---|---|---|
| parchaa.com (Framer, GTM; fidelity 88) | HTML | ref | none | ref | 38·92·89 → 40·100·91 | 13/2/14 | fixed (655 KB → 0) |
| | React+Vite | 41 s | 103 KB | 6/6·1.0·6/6 | → 58·92·91 | 12/2/14 | improved |
| | Next.js | 70 s | 237 KB | 6/6·1.0·6/6 | → 65·100·91 | 10/3/15 | improved |
| | MERN | 40 s | 103 KB | 6/6·1.0·6/6 | → 59·92·91 | 12/2/14 | improved; 1 form stored, server tests 15/15 |
| panscience.xyz (Next.js; fidelity 80) | HTML | ref | none | ref | 76·100·91 → 78·100·91 | 7/3/6 | fixed (160 KB → 0) |
| | React+Vite | 48 s | 96 KB | 6/6·1.0·6/6 | → 69·100·91 | 6/3/6 | improved; "No Next.js runtime left": fixed |
| | Next.js | 78 s | 237 KB | 6/6·1.0·6/6 | → 68·100·91 | 3/5/7 | **regressed** (160 → 237 KB); runtime row N/A |
| | MERN | 47 s | 96 KB | 6/6·1.0·6/6 | → 69·100·91 | 6/3/6 | improved; no text form, 15/15 |
Every zip (parchaa 3.1 MB, panscience 9.7 MB) also worked standalone: React `npm install` 11–17 s + build 6–8 s; Next install ~52 s + build ~66 s (8 HTML: pages + `404`, `_not-found`); MERN `npm run install:all` 25–42 s, build, `npm test` passed.
Honest regressions: render-blocking + unused CSS (shared stylesheet, deferred since 5.5), contrast 14 → 27 on panscience, Next.js "legacy JavaScript". Local Lighthouse varies by several points (parchaa HTML 40 vs React 58 mostly noise): compare stacks by the JS row and audits.

**Post-merge bug `flex: revert` (nyaayai.com, fixed in c1d4ca3, general)**: Next.js build rejected by equivalence (`/platform/` tablet 71 %, 10859 vs 10303 px), on both recreates; React fine. Cause: the IR resets a shorthand with a CSS-wide keyword
(`flex: revert`); Next's bundled `postcss-flexbugs-fixes` rewrites it to `flex: revert 1` (also `revert-layer 1`), invalid, so the browser dropped the reset. Fix: `emit/css.js declarations()` writes `revert` / `revert-layer` of `flex` as
longhands (`flex-grow`, `flex-shrink`, `flex-basis`). Regression test in `recreate-next.test.js` (CSS through Next's plugin unchanged + control). The equivalence check caught it; nothing broken was shown or downloaded. A failed stack build is not
retried automatically ("Build <stack> again" or `POST …/export` rebuilds from the IR). Re-export: build 97 s, fidelity 83, DOM 6/6, pixels ≥ 0.988 (mean 0.999), hydration clean, safety passed, JS 237 KB, 8 HTML files, zip 200 (`nyaayai.clone.com-nextjs.zip`).
Lesson: a bundler's CSS plugins can change valid CSS — keep every stack behind the equivalence check.

**Known open items**: MERN preview = client only (forms need `npm start`); only the latest 2 recreates keep their IR (stacks buildable only from those); Next.js ~237 KB gz runtime (React ~100 KB, HTML none); re-audit measures stacks uncompressed
locally vs the original's real transfer size (gz size used for the stack side); a second app stack builds one at a time under the lock (Next ~70 s, React/MERN ~45 s); per-page / critical-CSS split would remove the CSS regressions.

### Phase 5 (approved plan) — merged
After every successful Recreate the server audits the recreated site again (same Analyze pipeline on its build, throwaway loopback port) and compares it check by check with the analysis the recreate came from → the **fix checklist** in NEW
(Lighthouse before → after, status chips, category sections with before / now, recreate evidence, review flags for auto-generated text). Only recreated pages are compared; deploy checks N/A; CPU-timing audits never regress; network-level link
failures = recheck. Every recreate ships `sitemap.xml` + `robots.txt` (+ the original's `llms.txt` when it has one). Re-audit button; stale results flagged. **Nothing site-specific**: comparator, page mapping and emitter work from general data
(recreate report, analyzer keys, URL paths); real sites only verify.
Steps (all ✅): 5.1 job foundation · 5.2 comparator + sitemap/robots · 5.3 API + `audit.recreate` · 5.4 UI · 5.5 verification + docs.
**Decisions (approved)**:
- Trigger: automatic after each successful Recreate (separate job from the Recreate's `after` hook; a failed re-audit never discards a recreate) + manual Re-audit button.
- Statuses: ✓ fixed · ◐ improved · ✗ still open · ↓ regressed · ~ changed (CPU timing, noisy locally) · ⟳ recheck (network-level link failure) · ⚠ manual (never ✓) · n/a (deploy check, e.g. HTTPS, TTFB). Passing on both = grouped.
- Scope: only pages recreated on both sides; OLD issues on other pages are "out of scope", never "fixed". OLD re-scored with the same analyzers on its saved per-page facts (`crawl.json`).
- Matching: SEO/AEO/crawl by item key; axe by rule id + count (no selectors); broken links by normalized URL; Lighthouse by category score + failing audit id; manual from OLD `manualRebuild` + the recreate's "Manual rebuild needed".
  Performance labelled "measured on local preview, simulated throttling".
- One global lock for Analyze / Recreate / Re-audit (all drive Chromium); one re-audit per project; 5-min Analyze budget. Full PreviewManager deferred (5b); the re-audit uses its own throwaway server.
- From 5.5: (1) **llms.txt copied** (`fetchLlmsTxt`, SSRF-guarded, soft 404 ignored, 256 KB limit — a file reaching it is never copied cut, a warning asks to copy it by hand) via `ir/crawlFiles.js` into `ir.files`; `report.fixes` `crawl-files` says
  "…, llms.txt copied"; evidence for `aeo.llms-txt`. (2) Same severity but more affected = **regressed** (contrast 14 → 27); fewer = improved. (3) NEW-only broken link with `REFUSED` / `DNS` / `TIMEOUT` (`NETWORK_FAILURES`) → `links.broken-recheck`,
  status **recheck** (`RECHECK_NOTE`, `summary.recheck`, own chip/list, not in the 3-status list); HTTP errors stay `links.broken-new` (regressed). (4) **Deferred**: one shared `css/site.css` causes "unused CSS" / render-blocking regressions;
  a per-page / critical-CSS split comes later, reported honestly until then.
- Found and fixed in 5.5: the broken-links fixer left `<a>` without `href` (Lighthouse "Links are not crawlable", panscience SEO 100 → 92); unlinked links now become a `<span>` (text/class/id kept, no link-only attributes); look unchanged.

**5.1 job** (`server/src/reaudit/`, `routes/reaudit.js`): `runReaudit` serves `dist/` via `servePreview` (CSP/Host checks) on a throwaway 127.0.0.1 port (never the app's preview) and runs `runAnalysis` with
`createNetPolicy({ internalPorts: [port], allowLoopback: <user flag> })` (only that loopback port; Lighthouse Chrome via the egress proxy, `<-loopback>`). Steps: `serve` + Analyze steps without `screenshots`; stack detection runs.
`runAnalysis` options (Analyze never sets them): `url`, `outDir`, `skip`, `seedUrls` (recreated pages crawled first; page limit = their count). Raw results in `recreate/<recreateId>/reaudit/<reauditId>/`, never `audit/`; latest completed re-audit per recreate kept;
removing a recreate removes them. `reaudits` row: `recreate_id`, `analysis_id`, `result_json` = `{ reauditId, recreateId, analysisId, origin, pages, reauditedAt, audit }`. JobManager `after` hook also gets `payload`. Tests skip Lighthouse via `JOB_OPTIONS.skip` / `skip`.
Fixture: auto re-audit ~25 s, 6/6 pages, 11 links, 0 broken, axe clean, Lighthouse 100/92/100/100.

**5.2 comparator** (`reaudit/compare/{index,scope,rules}.js`, `recreate/ir/crawlFiles.js`)
- Last step `compare`: OLD (`analyses` row of `report.analysisId` + `audit/<analysisId>/` crawl.json, lighthouse-*.json) vs NEW → `compareAudits()` → `result.checklist`. Missing OLD analysis fails ("Run Analyze and Recreate again").
- Scope (`scope.js`): each report page paired with its OLD and NEW crawl page (`normUrl`: no www/protocol/hash/trailing slash); both re-scored (`analyzeSeo`, `crawlErrorsItem`, `analyzeAeo`, `analyzeCrawl`) on paired pages → `scope.mode: 'pages'`;
  `outOfScope`, `missingInNew/Old`. Without both crawls or the homepage pair → `mode: 'site'` (stored rows, with a note). Checks the re-score can't repeat (no `renderedTextLength` in old analyses) keep the stored row. `toOriginalUrl` maps NEW URLs back.
- Keys: SEO/AEO items carry `key` (`itemKey(section, title)`, e.g. `seo.meta-description`; old audits get it from the title) and `count`; multi-problem checks list `parts` (title/description: `missing` / `duplicate` / `length`; headings: `none` / `many`),
  compared part by part (`seo.title-tag.missing`). `crawl.metaTags.count` = missing tags. Additive.
- Rows: SEO/AEO by key/part; crawl (`crawl.sitemap|robots|meta-tags`); axe by rule + count (critical/serious = fail); links (`links.broken` with `links.fixed/open`, `links.broken-new`, `links.broken-recheck`); Lighthouse **performance + best-practices**
  audits (worst of mobile/desktop; binary/numeric/metricSavings only; `metrics`/`hidden` left to the score strip), rows only when failing on a side; platforms: every OLD `techStack` id except `custom` → "No <name> runtime or CDN left"; manual (status `manual`).
- `classify` (`rules.js`): rank pass 0 / warn 1 / fail 2 (Lighthouse ≥ 0.9 / ≥ 0.5). fixed, improved (lower rank, or same rank with lower count / score +0.05), open, regressed (worse rank, or same rank + higher count), pass, na (`DEPLOY_CHECKS`: HTTPS,
  compression, cache TTL, HTTP/2, server response time, redirects, CSP/HSTS/COOP/XFO, bf-cache; or not measured on NEW). CPU timing (`isCpuTiming`: `numericUnit` millisecond, not an `opportunity` — main-thread work, JS boot-up) that would regress → **`changed`**
  (`NOISY_NOTE`, `summary.changed`). Status order: regressed, open, changed, recheck, improved, fixed, manual, na, pass.
- Evidence (`rules.js EVIDENCE`): check key → fixer ids (`report.fixes`) + `report.autoGenerated` fields; fixed/improved with auto-generated values → `review: true`.
- Checklist: `{ version, comparedAt, analysisId, recreateId, scope, summary{regressed,open,improved,fixed,manual,na,pass,total}, scores{before,after}, metrics{before,after}, categories[{id,label}], items[{ key, category, title, status,
  before{status,detail,count?,score?}, after{…}, note?, evidence?, review?, links?, helpUrl? }], notes[] }`; items by category (performance, seo, aeo, accessibility, links, crawl, best-practices, platform, manual) then status.
- sitemap/robots (`ir/crawlFiles.js`, in `prepareSite` → `ir.files`): sitemap = recreated pages without noindex at `baseUrl` (canonical if on that origin), no invented lastmod/priority; robots = `Allow: /` (or `Disallow: /` if the original blocked all)
  + the original's AI-crawler blocks + `Sitemap: <baseUrl>/sitemap.xml`. In `report.fixes` (`crawl-files`) and `report.autoGenerated`.
- `runAnalysis({ deployOrigin })` reads sitemaps robots.txt lists at `report.baseUrl` from the build (never the live site). Throwaway server adds `connect-src 'self'` (`connectSelf`; Lighthouse reads robots.txt from the page); the app preview stays strict.
  Analyze's `crawl.json` stores `renderedTextLength`.
- Tests: `reaudit.test.js`, `reaudit-compare.test.js`.

**5.3 contract** (`reaudit/contract.js`, `routes/projects.js`): `GET …/audit` builds `audit.recreate` at read time (`recreateSection`) from the latest completed re-audit, latest completed recreate and the running job; stored analyses unchanged; never-analyzed = whole dummy.
- Real: `{ isDummy: false, status: 'done'|'queued'|'running', reauditId, recreateId, analysisId, reauditedAt, stale, staleReasons ('recreate' | 'analysis' | 'stack'), job { id, status, step, pct, message }, lastError, checklist, version, summary, scores, metrics, categories, items, scope, notes }`.
- `checklist` keeps the **3-status contract** (`fixed` / `open` / `manual` + `key`, `detail`; improved/regressed → open; pass/na dropped: `legacyChecklist`); full statuses in `items`.
- Sample (none finished): dummy checklist, `isDummy: true`, `status` (`not-started` | `queued` | `running` | `failed`), `recreateId`, `job`, `lastError`.

**5.4 UI**: store (`useProjects.js`) job kind `reaudit` (`startReaudit` / `getCurrentReaudit` / `subscribeReaudit`, same SSE + reconnect); after a Recreate `followReaudit` attaches to the queued re-audit; finished re-audit reloads the audit; 409 → follow;
selection reattaches. NEW "Fix checklist": progress (`AnalyzeProgress kind="reaudit"`); sample + recreate → CTA "No fix checklist for this recreate yet" + **Re-audit now**; real → `components/recreate/FixReport.jsx`: header (time, pages compared / not recreated) +
Re-audit button (disabled while a job runs); stale and last-error banners; **score strip** (Mobile/Desktop, before → after ± delta, LCP/TBT/CLS/size, local-preview footnote); **status chips** filtering rows (aria-pressed, "Show all");
category `<details>` (open when they hold open/regressed or match the filter); rows: mark, title, "Review" badge, label; expanded: Before / Now, link lists, evidence, review hint, note, axe "How to fix"; "Passing on both sides (N)"; notes. Tokens only, focus rings, 2-column scores < 560 px.

**5.5 real sites** (API, temp data dir, default page limit):
| Site | Platform | Fidelity | Checklist | LH mobile before → after | Notes |
|---|---|---|---|---|---|
| parchaa.com | Framer | 89 | 48 rows: 13 fixed, 1 improved, 13 open, 1 regressed, 2 manual, 4 N/A | perf 51 → 70, SEO 92 → 100, a11y 89 → 91 | Framer + GTM gone; headings fixed (23 skipped levels, several h1); link names fixed (review); unused CSS regressed; no llms.txt → open |
| panscience.xyz | Next.js | 80 | 38 rows: 6 fixed, 5 open, 3 regressed, 1 recheck, 3 N/A | 83 → 83, 100 → 100, 91 → 91 | Next.js runtime gone; broken link unlinked; llms.txt copied; regressions: render-blocking + unused CSS, contrast 14 → 27; recheck: medium.com refused once |
| Recreate fixture | — | 98 | 35 rows | SEO 100 → 100 | |
| Seeded Analyze fixture | — | 98 | 33 rows: 11 fixed | SEO 83 → 100, a11y 86 → 100 | real regression: render-blocking CSS/font preload (~70 ms) |

### Phase 4a — Recreate → plain HTML (done)
From a completed Analyze, Recreate produces a clean static HTML/CSS copy. Steps and commits: 4a.1 job foundation (`64a559f`, `6464957`) · 4a.2 discovery + capture (`385c00d`) · 4a.3 assets (`26bfff5`) · 4a.4 IR + HTML emitter (`1bdd007`) ·
4a.5 fixers + WP REST (`f21f10d`, `813dd37`) · 4a.6 build, verify, preview (`fd8d826`) · 4a.7 real-site fixes (`9d129c3`, `4657970`…`1ef3342` on `phase-4a-fix`, `e8a23c2`) · 4a.7 UI + dev polish (`82f0ece`, `5814686`, `b387d39`, `08b3daf`, `959577d`, `06355f7`, `15a62da`).
Real sites: parchaa.com (Framer) **88–89** (was 55; 10/10 pages, homepage 68 → 84), panscience.xyz (Next.js) **80** (was 75, all images on /media), Framer test site 97–98, fixture 98 (28 links / 27 assets / 6 pages valid).
Open: parchaa `/solutions` mobile (view alignment mixes list items across breakpoints), panscience `/ventures` tablet/desktop drift.

**Job** (4a.1): SSE progress, one global lock shared with Analyze (`jobs/manager.js`), `recreate_pages` (default homepage + 5, 0–20) / `target_domain` settings, written to `<recreateId>.tmp` → renamed on success, deleted on failure/timeout; latest 2 completed kept.
Needs a completed Analyze (> 7 days old = warning). Budget 12 min (10 + 2 for the sweep), `SAS_RECREATE_MINUTES` (1–60); inspect ≤ 7 min, stops starting pages when one more (slowest pace so far) would not fit before a 2.5-min reserve (rest linked live + warning).
Parallel page capture and shorter load waits were tried and rejected (broke animation-heavy captures). Tests use a temp DB per file (`test/run-tests.js`), never `data/app.db`.
Output `data/projects/<id>/recreate/<recreateId>/`: `capture/`, `assets/`, `site/` (readable), `dist/` (production), `ir/site.json`, `fidelity/`, `report.json`; site assets hard-linked to `assets/` (copy fallback).

**Discovery** (4a.2, `discover.js`): fresh SSRF-guarded mini crawl (robots respected): homepage, its links (in order), sitemap, rest of crawl. Login/cart/checkout/account/admin skipped → "Manual rebuild needed"; query-string URLs, non-HTML, robots-blocked skipped with a reason.
Paths kept: `/` → `index.html`, `/about.html` → `about.html`, `/about/` → `about/index.html`. Links to pages beyond the limit point to the live URL and are reported.
**Capture** (`capture/`, `inspect.js` = step 1): every page at each view → `capture/<slug>/<view>.json` (DOM + computed styles as diffs: inherited vs parent, others vs the tag's default; width/height dropped, `rect` kept; pseudo-elements, inline SVG, lazy attrs,
head, :root custom props, @font-face, @keyframes, media queries, resources) + fold/full WebP, `capture/manifest.json`; desktop required. Robustness: real mouse-wheel scrolling (scripts undo `scrollTo`; fallback kept), `domcontentloaded` (one retry), `load` +20 s not required;
rotated/scaled elements captured with their untransformed size. **Scroll-reveal**: scroll in steps < 1 viewport; elements starting at opacity ≈ 0 and shown by the page get their transitions / Web Animations finished and settled opacity/transform/filter recorded;
back at top that state is pinned (inline `!important`, MutationObserver, transitions finished) on elements hidden again, except ones entirely in the first screen and stacked siblings (carousel/tab slides); never-revealed elements (menus, dialogs) stay hidden.

**Assets** (4a.3, `assets/{index,collect,css,download,cdn}.js`): images (img, srcset, lazy attrs, CSS backgrounds, pseudo content, posters, og:image, svg href), icons, fonts, media → `assets/{images,icons,fonts,media}/<name>-<sha256:10>.<ext>` + `assets/manifest.json`
(`map`, `files`, `skipped` + reasons, `fontFaces`, `keyframes`). Every download via `guardedFetch` (`audit/http.js`: precheck + connect-time IP check on every redirect hop). Dedupe by URL (fragment stripped, query kept) and content hash.
Limits: image 15 MB/20 s, icon 1 MB/15 s, font 5 MB/20 s, media 40 MB/60 s; per recreate 800 files, 300 MB, 6 parallel. Only fonts of used families. Unreadable cross-origin stylesheets downloaded and parsed (@font-face, @keyframes, @import).
Skipped files are **never linked live** (`report.assets.skipped`); oversized media and undownloadable platform-CDN files also → "Manual rebuild needed". CDN hosts = `cleanup.cdnHosts` of the rules. srcset: only the candidate each view used (`currentSrc`);
an unloaded image gets the smallest candidate covering width × DPR (`pickCandidates`; Next.js-style 16-width srcsets no longer fill the budget).

**IR** (4a.4, `ir/{index,tree,styles,names,head,links}.js`, `emit/{html,css}.js`): one merged tree per page. Views aligned child by child (same tag sequence → index, else LCS on tag + text); single-view elements kept and hidden elsewhere; builder Desktop/Tablet/Phone
sibling copies (same content, disjoint visibility) merged into one element; plain wrappers (no style, one child, same box) removed; `div[role=navigation|banner|contentinfo|main|complementary]` → `nav|header|footer|main|aside`.
`ir/site.json` = `{ version, baseUrl, breakpoints, tokens, fontFaces, keyframes, boxSizingReset, rules, files, pages[{ head, body }] }`; refs `{asset}`, `{page,hash}`, `{live}`, `{external}`, `{anchor}`, `url("asset:…")`, so stack emitters only resolve them.
- **Styles**: one class per distinct style, desktop-first base + `@media (max-width)` overrides; breakpoints from the site's own queries (widest boundary between captured widths; defaults 1023.98 / 767.98, laptop since 4b). A value missing in a later view = `inherit` or `revert`;
  a reset makes links, headings and form controls inherit. Captured boxes restore intent: equal side margins → `margin: auto` + max-width; narrower block → `%` if the ratio holds in every view, else `max-width` px; images/SVG/video/fields → `100%` or px;
  empty boxes keep size; absolute boxes one anchor per axis + size; px grid tracks filling the container → `fr`; containers taller than content → `min-height`; content-box vs border-box respected; `* { box-sizing: border-box }` once when most use it.
  Colours → hex; equal to a `:root` token → `var(--token)` (builder tokens renamed `--color-N`). Only used `@keyframes` / `@font-face`.
- **Flex/grid sizing** (4a.7): layout parent skips `display: contents`; a box with no in-flow children (all absolute/fixed/hidden, through `display: contents`) keeps its size; a content-sized flex/grid item (row: no grow; column: not stretched;
  grid: `justify-self` not stretch) gets `width` when its text wraps in any view (content box), it wraps a `flex: 1 0 0` child, fills its parent, or has no text — px if equal in every view, % if the ratio is, else px (text +1 px) + `max-width: 100%` unless it overflows on purpose
  (marquees). Small boxes (≤ 400×200, not filling the parent) with text and small inline-level boxes get `min-width` (captured − 1 px) / `min-height`; a spreading flex column (space-between…) uses the sum of its children for `min-height`. Absolute boxes keep size whatever the transform.
- **Class names**: original only when human-written; builder patterns (`cleanup.classPatterns`), hashed CSS-in-JS, utility and visibility classes never. Else role-based (`site-header`, `main-nav`, `title`, `button`, `card-image`…) prefixed by the nearest named block.
  Ids kept when meaningful or referenced (`for`, `aria-*`, `#anchor`).
- **Head**: original title/description/canonical/OG/Twitter/icons/robots/JSON-LD kept (generator/platform meta dropped). Missing ones filled from the page only: title ← first h1 (+ site name), description ← og:description or first paragraph ≥ 50 chars (clipped 160),
  canonical ← target domain or original origin + path, og:* ← title/description/canonical/first image ≥ 200 px, icon ← homepage icon or a generated letter favicon. All in `report.autoGenerated` (`page`, `field`, `value`, `source`); missing `lang` reported
  (`pages[].head.missing`), never guessed. Site name: og:site_name → JSON-LD → logo text → host. canonical/sitemap/OG use the original origin unless `target_domain` is set. Missing text uses heuristics only (no LLM).
- **Links**: recreated pages → relative paths in original form (`about/`, `../`); other same-site links stay live (`report.generate.liveLinks` + reason); `www.` = bare host; `javascript:`/`data:` hrefs dropped; `target=_blank` gets `noopener`.
  Undownloaded images left out; forms keep markup, lose `action`, → "Manual rebuild needed".
- **Fit pass + fidelity** (`recreate/verify/`): site served on 127.0.0.1 (random port), page JS off, other requests aborted. Generate renders every page/view, compares element boxes with the capture (`data-sas-id` in the in-memory measurement build only),
  adds widths (top-down, under a matching parent) and min-heights (bottom-up), ≤ 2 rounds, a round that lowers the score is undone. Build scores each page/view: `sizes` (±3 px / 3–5 %), `boxes` (IoU ≥ 0.6), rough `visual` (96 px wide) = 35/25/40 %;
  shots in `fidelity/<slug>/<view>-full.webp`.

**Safety** (4a.5): the generated site has no script (except the 4b `motion.js`) and no external reference.
- SVG sanitizer (`fixers/svg.js`): parse (htmlparser2, XML) and **rewrite from an allowlist** (drawing, text, paint servers, filters, animation, `<style>`); dropped with content: `script`, `foreignObject`, `iframe`, `metadata`, editor namespaces; dropped attributes:
  `on*`, `xml:base`, prefixed editor attrs, `javascript:`/`vbscript:` values, animations targeting href/on*/style, `@import`. References may only be `#fragment`, a local asset (`asset:<file>` inline) or raster `data:image/*`; SVG `<a href>` also http(s)/mailto/tel/relative.
  Comments, PIs, DOCTYPE dropped; text re-escaped. Runs on every SVG download (end of assets step, in place; no `<svg>` root → deleted, `not-an-asset`) and every inline SVG (IR build).
- HTML guard (`fixers/html.js`): drops `on*`, `srcdoc`, `formaction`, `ping`, legacy URL attrs, script/HTML `data:`; `object`/`applet`/`frame`/`base`/`script`/`template`. JSON-LD parsed and rewritten with `< > &` as `\u` (invalid dropped); `hreflang` alternates http(s) only.
- Safety gate (`verify/safety.js`, build step): every HTML/SVG/CSS of `site/` and `dist/` re-parsed; non-JSON-LD `<script>`, `on*`, script URLs, `srcdoc`, meta refresh, active elements, non-local SVG refs, CSS `@import` / external `url()` / `expression()` = issue → job fails (`report.safety`).
  Preview defence in depth: own port, CSP without script, framed `sandbox="allow-same-origin"` while the site has no JS. Any later JS must be generated by us and pass the gate.

**Fixers** (`fixers/`, generate step, on merged trees before styles; font fixes on each IR build). `report.fixes[] = { id, title, status: fixed|partial|open, count, open, items, openItems? }`:
- `img-alt`: `title`/`aria-label` → `<figure>` caption → readable file name (hashes, sizes, `IMG_1234` rejected); in a link/button with text or `role=presentation` → `alt=""`; else `alt=""` + open (review). All in `report.autoGenerated` (`field: 'alt'`).
- `accessible-names`: links/buttons get `aria-label` (or their icon's alt) from target page title, "Site home", a known service (GitHub, LinkedIn…) or host, `Email …`/`Call …`, a class/id/icon hint (`menu` → "Open menu", `search`, `close`…). Fields: placeholder or name. Nothing → open.
- `headings`: one h1 (extras → h2; none → first heading in `main` promoted); skipped levels fixed by outline (one below the nearest earlier higher heading); headings before the first h1 untouched; old UA margins written explicitly.
- `broken-links`: targets in `audit.brokenLinks.broken` or discovery HTTP errors → `<span>` (text/class/id kept, link-only attributes dropped). Unverified (401/403/429/timeouts) kept.
- `image-loading`: per desktop and mobile, the largest first-screen image (≥ 150×100) gets `fetchpriority="high" loading="eager"`; images below the first screen in every view `loading="lazy" decoding="async"`; such iframes `loading="lazy"`.
- `font-display` (auto/block/missing → `swap`), `font-preload` (closest-to-400 normal face, woff2 preferred, of the ≤ 2 families carrying most text, `<link rel=preload as=font crossorigin>`), `wordpress-text`.
- **WordPress REST** (`fixers/wordpress.js`, only when `techStack` has `wordpress`): probe `/wp-json/wp/v2/pages`, fallback `/?rest_route=/wp/v2/`; list pages + posts (`_fields=id,link,type`, ≤ 3×100 each, totals from `X-WP-Total`), match by `link` (www = bare), read full items.
  SSRF-guarded (`fetchPage`), 10 s / request, 30 s total. Title/excerpt fill missing `<title>`/description first ("WordPress REST API"); leaf blocks (p, h1–h6, li, blockquote, figcaption, dt/dd, td/th, pre) aligned in order (same kind, word Dice ≥ 0.5, 40-block window):
  text-only blocks take REST text, inline-markup blocks stay rendered, REST-only blocks counted not inserted. `pages[].content` keeps sanitized content HTML (allowlist, no classes/styles/scripts/forms, https iframes) for emitters. `report.wordpress` totals;
  unrecreated posts/pages → "Manual rebuild needed". Unreachable → warning, rendered text used.

**Build step** (4a.6, `build/index.js`, "Building & verifying"): atomic `dist/` (`dist.tmp` → `dist`; esbuild CSS/JS minify via `build/minify.js`, no bundling/lowering, JSON compacted, HTML as emitted, assets hard-linked, `report.minify`;
an error fails with "The production build failed on <file>: <error>") → safety gate → verification → fidelity. Any failure discards the workspace.
- Verification (`verify/site.js`, `report.verify`): every emitted page/stylesheet/asset in `dist/`; internal `<a>`/`<area>` resolve (file or folder + `index.html`); every local ref (src, srcset, poster, icon/preload/stylesheet, SVG href, CSS `url()`, `<style>`, `style=""`,
  inside SVG) exists; other-origin assets = errors (iframes may stay external). html-validate `standard` + `document` (`require-sri` off): emitter-only rules (`parser-error`, `no-dup-attr`, `void-content`, `missing-doctype`, `doctype-html`, `element-name`,
  `no-raw-characters`, `unrecognized-char-ref`, `attr-delimiter`) = errors; others (carried over from the original) = warnings. Missing/broken/remote/error fails the job naming the first case; HTML warnings and missing `#anchor` links → `report.warnings` (confirmed by the user).
- Fidelity on `dist/`: `FIDELITY_THRESHOLD = 80`; views/pages/site get `low`; `report.fidelity` = `threshold`, `status` (ok | mixed | low), `lowPages`, `pages[].lowViews`; below = warnings, site kept.
- **Preview** (`recreate/preview.js`): one at a time, one recreate's `dist/` on 127.0.0.1, first free port 5100–5199. GET/HEAD only; Host must be this port on 127.0.0.1/localhost; paths realpath-contained, no dotfiles, folder → slash redirect (same-origin).
  Headers: CSP `default-src 'none'` (img/media/font/style self, inline style, https frames, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors` = `APP_ORIGIN` + localhost/127.0.0.1 twin), nosniff, no-referrer, CORP same-origin, no-store.
  Step 5 "Starting preview" serves the new `dist/` on a throwaway port and requests every page + the stylesheet (`report.preview`). Started after a successful job and by `POST /preview` (also after a restart); retention / project delete stop it. Port never stored.
- NEW panel: sandboxed iframe (no scripts until 4b), viewport + page picker, fidelity + verification report card.

**UI + dev (4a.7)**: collapsible sidebar; SSE `ping` every 15 s, client reconnects a dropped/silent (40 s) stream with backoff up to 2 min ("reconnecting…"); a job lost to a restart says "Run it again". **Sync scroll**: pill on the OLD/NEW divider;
on = both websites scroll by the same share of their height (OLD shows its screenshot since a cross-origin frame can't be scrolled — Live returns when off; NEW draws the page at full height from the report in an app-owned scroll box); off by default, not remembered.
**Matching page**: OLD follows the NEW page picker — Live frames that page's original URL, Shot shows the Recreate capture (`capture/<slug>/<view>-full.webp` via `GET …/recreate/:recreateId/captures/:slug/:file`; `report.pages[].slug` filled for old reports); homepage keeps Analyze shots.
Dev runner `server/scripts/dev.js` (see Known issues).

Known environmental issue: 2 `netGuard` tests fail on this Windows machine (`*.localhost` → DNS ENOTFOUND); not a regression.

### Phase 3 — OLD preview (done)
Live site in a sandboxed iframe when framing is allowed, else the Analyze screenshot; Live/Shot toggle always available. Screenshots on **every** analysis (also feed the 4b visual diff) at 1440/768/375, fold + full, WebP; latest 3 analyses per project keep them.
Viewport toggle renders at the real width scaled to the panel, synced with the metrics Mobile/Desktop toggle. Metric chips (load time = TTI, LCP, TBT, page size) from Lighthouse per device (`audit.metricsByDevice`).
Decisions: Live view (CDP screencast) deferred to 3b; a header-stripping reverse proxy rejected (site JS would run on the app origin); no intranet allowlist for user URLs.

## Key decisions
- **Stack-agnostic recreate**: always from the *rendered output* (Playwright DOM, computed CSS, screenshots, network assets), never source. Pipeline: Capture → platform-free IR → Fixers → Emitter(stack).
- **Stack detection**: generic engine + one JSON rule file per platform (`server/src/detection/rules/<id>.json`: signals + weights, limitations, cleanup, manualRebuild; 15 platforms). New platform = new file, no engine change. No match → "Custom/Unknown".
- **Platform cleanup**: never copy builder classes/wrappers (`framer-*`, Webflow `w-*`, Wix ids); semantic class names; all assets local, zero platform-CDN refs (framerusercontent.com, wixstatic…); Desktop/Tablet/Phone variants merged into one responsive layout;
  WordPress content from `/wp-json/wp/v2/` when reachable.
- **Fixes are general, never site-specific** (no per-URL code); platform knowledge lives in the rule JSON files. Real sites only verify.
- **Fix checklist** = same audit pipeline on NEW, diffed against OLD. Nothing hardcoded.
- **Authorization**: New Project requires an "I'm authorized" checkbox (server rejects without `authorized: true`) + a permanent note at the foot of the sidebar (`Disclaimer.jsx`: "Authorized websites only" with the full sentence on hover and for screen readers; the shield alone in the collapsed rail; moved out of the top bar on the user's request, 2026-10-08).
- Recreate page limit configurable (default homepage + 5).
- Non-automatable things (form backends, login, cart/checkout, CMS data, plugin behaviour, WebGL) go to "Manual rebuild needed", never faked.
- Tests use only the fixture site (localhost:4100); never external requests from tests.

## Analyze (Phase 2) rules
- **Time limit** 6 min (was 5), 2 kept for Lighthouse; earlier steps are cut short or skipped rather than use them. A step that would start after the limit is skipped and listed in `audit.errors`. One analysis at a time; others queue.
- **Retry after sleep / network outage** (`audit/interruptions.js`, Analyze only, branch `net-retry`, WIP): a step failing with a timeout or network error (`ERR_INTERNET_DISCONNECTED`, `ERR_NETWORK_CHANGED`, `ERR_NAME_NOT_RESOLVED`, socket resets…) is explained first:
  (1) a 1 s timer firing ≥ 5 s late = sleep / frozen process (`watchPauses`); (2) HEAD to the site (any status = reachable); (3) if no answer and nothing says the network is down, a DNS query to the configured resolver (no OS cache): an answer = network up, site hangs → reported, no waiting.
  Sleep or outage → wait for the site (probe every 5 s, ≤ 2 min × `SAS_TIMEOUT_SCALE`; homepage fetch ≤ 30 s so a down site fails fast) and run the step **once more** with the time it had left (deadline moves, ≤ 5 min × scale total; parallel steps failing in the same outage share one extension).
  A second failure is reported with what happened ("… (the computer was asleep for 42 s; tried again once)"). A timeout on a working network without sleep is never retried. **Short outages** (user's Wi-Fi off/on test: off 20–30 s during render, goto timed out at 67.5 s after
  the network was back, the browser's dead connection never recovered): DNS check of the site's host every 3 s for the whole analysis (`watchNetwork`, nothing sent to the site); a step overlapped by an outage is retried even if the network is back.
  Each decision logged (`[analyze <id>] <step>: "<error>" — network down N s during the step … → trying again` / `… → not retried`). Recreate not covered yet. Tests: `interruptions.test.js`.
- **Keep-awake during jobs** (`jobs/keepAwake.js`, branch `max-parallel`, WIP): on the user's laptop (Pentium Gold 7505, 8 GB, Modern Standby) timeouts / "Connection to the server dropped" matched Modern Standby mid-job (one analysis 31 min) or starting right after waking;
  four scratch runs (normal, 180 MB free, app open) passed in 81–90 s, so RAM was not the cause. The global lock (`manager.js exclusive()`) holds a keep-awake request while a job runs or is queued, released 30 s after the last: Windows = hidden PowerShell helper with
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)` (display flag blocks screen-off → standby), exits when the server dies; macOS `caffeinate -di -w <pid>`; Linux `systemd-inhibit`. Lid/power button still sleep.
  `SAS_KEEP_AWAKE=0` = off (test suite); failure logged once, never fails a job. `GET /api/health` → `keepAwake`. Tests: `keep-awake.test.js`.
- **Concurrency cap** (`audit/resources.js maxParallel`, branch `max-parallel`, WIP): `SAS_MAX_PARALLEL` (1–8) caps browser contexts in every step (`parallelism()`), even below a step's minimum; `1` also disables the background sweep next to generate/build (unless `SAS_RECREATE_OVERLAP=1`).
  Unset = memory rule. Slower (2 views: ~212 s vs ~120 s for six pages), so pair it with more time.
- **Slow / busy machines** (`audit/index.js analyzeTiming`, `server/.env.example`): `SAS_TIMEOUT_SCALE` (1–4) multiplies every step limit, page-load and axe waits, Lighthouse reserve and total; `SAS_ANALYZE_MINUTES` (1–30) sets the total alone. Room for one page only →
  screenshots wait for the homepage render. Timeouts with < 1 GB free at start add a `memory` row to `audit.errors`. No `.env` required; a missing one never shortens a limit.
- **Links**: 4xx/5xx, DNS failure, refused, bad TLS = **broken**; 401, 403, 429, 999, timeouts = **unverified**. ≤ 500 unique links.
- **Scope**: Lighthouse (mobile + desktop), axe, stack detection on the **homepage only**; SEO, AEO, meta and links on all crawled pages (`max_pages` default 25, depth 3).

## Preview & network security (Phase 3) rules
- **SSRF guard** (`server/src/security/`): user URLs reach **public** addresses only; loopback, private (RFC 1918, CGNAT, ULA), link-local (cloud metadata), reserved ranges blocked, incl. IPv4 in IPv6. Checked on the **resolved IP at connect time** (anti DNS rebinding) and **every redirect hop**.
  Node: undici Agent whose connector resolves, checks and pins the IP. Playwright + Lighthouse Chrome: per-analysis local egress proxy (`egressProxy.js`) doing the same.
- Dev flag `SAS_ALLOW_LOCALHOST=1` (e.g. `server/.env`, gitignored): loopback only, never port 4000. No allowlist for private ranges.
- Internal allowlist: `createNetPolicy({ internalPorts })` for the platform's own loopback ports, via `runAnalysis({ netPolicy })`, never from user input; the analyze route always uses the default policy.
- **Frame check** (`audit/frame.js`): CSP `frame-ancestors` (all policies must allow `APP_ORIGIN`, default `http://localhost:5173`) overrides X-Frame-Options; Report-Only and `<meta>` ignored; ALLOW-FROM / frame-busting scripts only set `confidence: 'uncertain'`.
- **Iframe**: `sandbox="allow-scripts allow-same-origin"` (no top navigation, forms, popups), `allow=""`, no referrer; the app never frames its own origin.
- **Screenshots**: 1440×900 (DPR 1), 768×1024 (DPR 1), 375×812 (DPR 2, mobile UA); fold + full each, full ≤ 8,000 CSS px, WebP q75, in `data/projects/<id>/audit/<analysisId>/screens/`, served by a whitelisted route with immutable caching; latest **3** completed analyses keep `screens/`.

## Conventions
- **All product text in English** (UI, API errors, dummy data, comments, docs), though the user chats in Hinglish.
- Theme: **calm light theme with a warm orange accent** (`--accent` #c2410c, white text on it 5.2:1; amber tints; `--accent-rgb` for shadows; user, 2026-10-08: blue → orange/yellowish). Calm blue from UI redesign U1 until then (same token names). Sidebar: each website shows its own favicon (`routes/favicon.js`, `GET /api/projects/:id/favicon`: homepage `<link rel=icon>` or /favicon.ico through the SSRF guard, images ≤ 256 KB, SVG sanitized, sandbox CSP, kept as `favicon.bin` + `favicon.json` in the project folder, none = retried after a day; `Sidebar.jsx SiteIcon` falls back to the letter). Before it, "Aurora light": violet accent `#6D4AFF`, violet-to-pink brand gradient, indigo-tinted neutrals, lavender / sky / blush mesh background with drifting blurred blobs (`AppShell .aurora`), white glass cards (blur + coloured shadows), Inter + JetBrains Mono (local @fontsource).
  Colours, gradients (`--grad-*`), radii, shadows, motion (`--ease`, `--dur`) are tokens in `client/src/styles/tokens.css`; **colours only via tokens**. Keyframes in `styles/global.css`, used from CSS modules via variables (`animation: var(--k-fade-up) …`; `:global()` in `animation` breaks the build).
  Motion: staggered fade-up, hover lifts, gradient buttons with shine, animated score rings + count-up (`components/common/CountUp.jsx`), shimmering progress, pulsing NEW chip; all off under `prefers-reduced-motion`.
  Gotcha: a flex child with `overflow: hidden` is squashed in the panels' flex column — give it `flex: none`.
- OLD panel = sky-blue gradient rail/chip; NEW = violet-to-pink.
- The audit JSON shape (`server/src/dummy/audit.js`) is the UI contract; `audit/assemble.js` produces it; new fields additive only (`test/analyzers.test.js` checks keys).

## Structure
```
client/src/  layout/ (AppShell, Sidebar, OldPanel, NewPanel)
             components/{common,audit,preview,project,recreate,report}/  (preview/SitePreview.jsx = iframe/screenshot,
             recreate/RecreateReport.jsx = fidelity + verification card, FixReport.jsx = fix checklist, StackOutput.jsx = stack build card)
             store/useProjects.js, api/client.js, constants.js (STACKS), stacks.js (outputs of a recreate), styles/
server/src/  index.js, db/index.js (schema + migrations), routes/{projects,analyze,screens,recreate,reaudit,stacks,report}.js, dummy/audit.js
             toolchains/index.js (status of server/toolchains/<id>, pinned versions)
             jobs/ manager.js (JobManager + global lock), sse.js, keepAwake.js
             reaudit/ index.js (serve build + runAnalysis + compare, STEPS), jobs.js, contract.js, motion.js, compare/{index,scope,rules}.js
             recreate/ index.js (pipeline + STEPS + budget), jobs.js, inputs.js, workspace.js, errors.js, discover.js, inspect.js, sweep.js, responsive.js, views.js,
                    capture/{index,snapshot,interactions,reveal,loops,measure,sweep}.js, assets/{index,collect,css,download,cdn}.js,
                    ir/{index,tree,styles,names,head,links,fluid,motion,crawlFiles}.js, emit/{index,walk,write,html,css,motionScript}.js,
                    emit/react/{index,jsx,components,scaffold,build}.js, emit/next/{index,routes,build}.js, emit/mern/{index,forms,build}.js + template/,
                    export/{fromIr,zip}.js, inlineScripts.js, build/{index,minify,toolchain}.js, generate.js, preview.js,
                    fixers/{index,svg,html,a11y,perf,wordpress}.js,
                    verify/{server,layout,fidelity,safety,site,equivalence,appProfiles,visualDiff,responsive,refine,goto}.js
             report/{collect,render,pdf}.js
             security/ netGuard.js, egressProxy.js
             audit/ index.js (pipeline + STEPS), jobs.js, resources.js, sharedCache.js, interruptions.js, http.js, robots.js, sitemap.js, crawler.js, extract.js,
                    linkChecker.js, render.js, screenshots.js, retention.js, frame.js, assemble.js, lighthouse/{run,worker}.js,
                    analyzers/{seo,aeo,crawlChecks,a11y,metrics,weaknesses}.js
             detection/ engine.js, manual.js, manual-rules.json, rules/<platform>.json
server/toolchains/ react-vite, next, mern (pinned package.json; node_modules on demand, gitignored)
server/test/ *.test.js (node --test via run-tests.js + setup-data-dir.js: temp DB per file), serve-fixture.js,
             fixtures/site (seeded audit issues), fixtures/recreate-site (responsive site + small /wp-json/wp/v2/ + unsafe-SVG / fixer seeds)
data/        app.db + projects/<id>/audit/<analysisId>/{crawl,axe,lighthouse-*}.json + screens/*.webp, projects/<id>/recreate/<recreateId>/ (gitignored)
```

## Run
Ports: client **5173**, API **4000**, fixture **4100**, previews **5100–5199**. For local testing put `SAS_ALLOW_LOCALHOST=1` in `server/.env`. "Cannot reach the API server" = nothing (or something else) on 4000.
```bash
npm install
npm run dev          # client :5173 + server :4000
npm run dev:server   # or dev:client
npm run build        # client production build
npm test -w server   # temp DB per test file (OS temp, deleted), never data/app.db
npm test -w server -- test/crawl.test.js
npm run fixture-site -w server              # seeded site on :4100 (needs SAS_ALLOW_LOCALHOST=1 to analyze)
npm run fixture-site -w server -- recreate  # Recreate fixture instead
npx -w server playwright install chromium   # one-time
npm run setup:toolchains -w server -- react-vite next mern   # no argument = status
```
API: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (PATCH: `max_pages`, `recreate_pages` 0–20, `target_domain`), `GET …/:id/audit`, `GET …/:id/report`,
`POST …/:id/analyze`, `GET …/:id/analyze/current`, `GET …/:id/analyze/:analysisId/events` (SSE progress/done/failed), `GET …/:id/analyses/:analysisId/screens/:file` (`{desktop,tablet,mobile}-{fold,full}.webp`),
`POST …/:id/recreate`, `GET …/:id/recreate` (latest attempt + report), `GET …/:id/recreate/current`, `GET …/:id/recreate/:recreateId/events` (SSE), `GET …/recreate/:recreateId/captures/:slug/:file`, `GET …/recreate/:recreateId/fidelity/:slug/:file`,
`GET/POST/DELETE …/:id/preview` (`{ preview: { url, port, recreateId, … } | null }`; POST 404 without a recreate, 503 without a free port),
`POST …/:id/reaudit` (409 without a recreate or while one runs), `GET …/:id/reaudit` (`{ last, result, stale }`), `GET …/:id/reaudit/current`, `GET …/:id/reaudit/:reauditId/events` (SSE),
`GET …/recreate/:recreateId/download[?stack=]` (zip), `POST …/recreate/:recreateId/export`, `GET /api/stacks`, `GET /api/health`.

## Currently dummy / known issues
- Never-analyzed projects get the **dummy** audit (`isDummy: true`, "Dummy data" badge) and a wireframe OLD preview. The fix checklist is the sample (`isDummy: true`) + re-audit state until a re-audit finishes.
- One preview per project (`recreate/preview.js`, own port each in 5100–5199): two tabs on two websites no longer take each other's preview (they did, every few seconds, once tab focus re-requested it). A newer recreate / stack build replaces only that project's preview. A link to a non-recreated page opens the live original inside the preview frame (without script).
- Recreate CSS: font sizes / line heights are px per breakpoint unless fluid type was adopted; between captured widths layout relies on %/max-width/fr heuristics.
- A Lighthouse run takes ~20–40 s (mobile, then desktop); a healthy site's analysis is a little over a minute; slow sites/machines up to the 6-min limit.
- Pre-Phase-3 audits have no screenshots / desktop metrics (UI asks to re-run Analyze).
- Some frameable sites render blank in the iframe (frame-busting, cookie walls): use Shot. Cookie banners appear in screenshots. Full-page shots stop at 8,000 CSS px.
- The SSRF guard pins the first resolved IPv4 (no IPv6→IPv4 fallback). Blocked requests a page makes are listed in `audit.blockedHosts`.
- Bot-protected sites (Cloudflare challenge) fail with a clear message, never bypassed.
- Jobs live in memory; a server restart marks running jobs failed. So the dev server does **not** use `node --watch` (on Windows it restarted with nothing edited: NTFS last-access updates on imported files, node_modules included).
  `server/scripts/dev.js` watches only `src/` and `.env`, restarts only when a regular file's content hash changed (folder events ignored, unreadable files retried/ignored, watcher errors survived), and waits while `GET /api/health` reports `busy`.
  **Agents**: a real edit to `server/src` still restarts the user's dev server once no job runs — work in a git worktree while the user tests.
- Project delete uses `window.confirm`. LF→CRLF warnings on Windows are harmless.
