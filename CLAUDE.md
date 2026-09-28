# Site Audit Studio — Website Audit & Recreate Platform

Internal tool that keeps all company websites in one place, audits them, and automatically
recreates an improved version in a chosen stack. For company-owned or authorized sites only.

## Layout (3 columns)
- **Sidebar**: "New Project" button + saved websites list. Clicking one loads it into the OLD panel.
- **OLD panel**: URL + Analyze → original site preview (iframe, or screenshot/live-view fallback
  when blocked) → performance metrics → audit report (tech stack + confidence, weaknesses,
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
- Planned (Phase 3+): sharp, archiver, get-port, execa.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project CRUD (SQLite), stack modal, dummy audit | ✅ Done |
| 2 | Analyze job + SSE progress: Lighthouse (mobile+desktop), stack detection, crawler (broken links, sitemap, robots, meta), SEO, AEO, axe a11y, manual-rebuild detector | ✅ Done |
| 3 | OLD iframe + screenshot fallback + live view (CDP screencast). The X-Frame-Options/CSP check already exists (`audit.frame`) | ⏳ Next |
| 4a | Recreate → plain HTML: page discovery (sitemap, limit), Playwright capture, local assets, IR, variant merge, semantic classes, fixers | ⏳ |
| 4b | Motion + responsive fidelity: hover, scroll reveal, continuous animations, widget JS, visual diff score | ⏳ |
| 5 | PreviewManager (ports 5100–5199), NEW iframe, re-audit → fix checklist | ⏳ |
| 6 | React+Vite / Next.js / MERN emitters + Download zip | ⏳ |

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

## Conventions
- **All product text in English** (UI, API errors, dummy data, comments, docs), even though the user chats in Hinglish.
- Theme: light, indigo accent `#4F46E5`, slate neutrals, Inter + JetBrains Mono (local via @fontsource).
  Colors only via tokens.
- OLD panel = slate rail/chip; NEW panel = indigo rail/chip.
- The audit JSON shape (`server/src/dummy/audit.js`) is the contract the UI renders. `server/src/audit/assemble.js` produces it; new fields must be additive (`test/analyzers.test.js` checks the keys).

## Structure
```
client/src/  layout/ (AppShell, Sidebar, OldPanel, NewPanel)
             components/{common,audit,preview,project,recreate}/
             store/useProjects.js, api/client.js, constants.js (STACKS), styles/
server/src/  index.js, db/index.js (schema + migrations), routes/{projects,analyze}.js, dummy/audit.js
             audit/ index.js (pipeline + STEPS), jobs.js (queue, 1 at a time), http.js, robots.js, sitemap.js,
                    crawler.js, extract.js, linkChecker.js, render.js, frame.js, assemble.js,
                    lighthouse/{run,worker}.js, analyzers/{seo,aeo,crawlChecks,a11y,metrics,weaknesses}.js
             detection/ engine.js, manual.js, manual-rules.json, rules/<platform>.json (15 platforms)
server/test/ *.test.js (node --test), serve-fixture.js + fixtures/site (seeded issues, port 4100)
data/        app.db + projects/<id>/audit/<analysisId>/{crawl,axe,lighthouse-*}.json (gitignored)
```

## Run
```bash
npm install
npm run dev          # client :5173 + server :4000 (concurrently)
npm run dev:server   # or: npm run dev:client
npm run build        # client production build
npm test -w server   # unit tests
npm run fixture-site -w server   # seeded test site on :4100
npx -w server playwright install chromium   # one-time
```
API: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (PATCH takes `max_pages`), `GET /api/projects/:id/audit`,
`POST /api/projects/:id/analyze`, `GET /api/projects/:id/analyze/current`, `GET /api/projects/:id/analyze/:analysisId/events` (SSE: progress/done/failed), `GET /api/health`

## Currently dummy / known issues
- Analyze is real. Projects that were never analyzed still get the **dummy** audit (`isDummy: true`, "Dummy data" badge).
- Still dummy: the OLD preview wireframe (Phase 3), the NEW preview and the fix checklist (`audit.recreate`, which has `isDummy: true`; Phase 5).
  Recreate (Phase 4) and Download (Phase 6) stay disabled.
- Lighthouse, axe and stack detection run on the **homepage only**. SEO/AEO/links cover the crawled pages (max_pages, default 25, depth 3).
- Link check cap: 500 unique links. 401/403/429/999 and timeouts are `unverified`, not broken.
- Time budget: 5 min per analysis, one analysis at a time (others queue). A mobile Lighthouse run takes ~40s+.
- Bot-protected sites (Cloudflare challenge) fail with a clear message; they are never bypassed.
- Jobs live in memory; a server restart marks running analyses as failed.
- Project delete uses `window.confirm`. Git shows LF→CRLF warnings on Windows, which are harmless.
