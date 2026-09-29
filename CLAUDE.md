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
- Planned (Phase 4+): archiver, get-port, execa.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project CRUD (SQLite), stack modal, dummy audit | ✅ Done |
| 2 | Analyze job + SSE progress: Lighthouse (mobile+desktop), stack detection, crawler (broken links, sitemap, robots, meta), SEO, AEO, axe a11y, manual-rebuild detector | ✅ Done |
| 3 | OLD preview: frame check (XFO + CSP3 frame-ancestors), sandboxed iframe, screenshots 1440/768/375 (fold + full, WebP, keep latest 3), per-device metrics, SSRF guard | ✅ Done |
| 3b | Live view (CDP screencast, view + scroll + click, no keyboard) — deferred by the user | ⏳ Later |
| 4a | Recreate → plain HTML: page discovery (sitemap, limit), Playwright capture, local assets, IR, variant merge, semantic classes, fixers | 🚧 4a.5 done |
| 4b | Motion + responsive fidelity: hover, scroll reveal, continuous animations, widget JS, visual diff score | ⏳ |
| 5 | PreviewManager (ports 5100–5199), NEW iframe, re-audit → fix checklist | ⏳ |
| 6 | React+Vite / Next.js / MERN emitters + Download zip | ⏳ |

**Current status:** Phases 1, 2 and 3 are complete. Phase 4a is in progress on branch `phase-4a`, one sub-step at a time
(stop after each, WIP commit, wait for the user's "next"; never push):
4a.1 job foundation ✅ · 4a.2 discovery + capture ✅ · 4a.3 assets ✅ · 4a.4 IR + HTML emitter ✅ · 4a.5 fixers + WP REST ✅ · 4a.6 build, verify, fidelity, preview · 4a.7 tuning + docs.

### Phase 4a progress
| Step | Status | Commits | Summary |
|---|---|---|---|
| 4a.1 Job foundation | ✅ Done | `64a559f`, `6464957` | Recreate job + SSE progress, global one-job lock shared with Analyze, 10-min budget (`SAS_RECREATE_MINUTES`), tmp → final workspace with keep-latest-2 retention, stale-analysis warning, `recreate_pages`/`target_domain` settings, Recreate button. Tests run on a temp DB per test file (`test/run-tests.js`), never `data/app.db`. |
| 4a.2 Discovery + capture | ✅ Done | `385c00d` | `discover.js` (homepage → homepage links → sitemap → crawl, limit, skip reasons, links-to-live), `capture/` (DOM + computed-style diffs, pseudo-elements, SVG, head, tokens, fonts, resources, fold/full WebP at 1440/768/375), `inspect.js` = step 1; `fixtures/recreate-site` + `recreate-capture.test.js`. |
| 4a.3 Assets | ✅ Done | `26bfff5` | Images, icons, fonts and media downloaded into `assets/` (no platform CDN links left; skipped files are reported, never linked live). SSRF guard on every download: URL precheck + connect-time IP check on every redirect hop (defeats DNS rebinding) via `guardedFetch` in `http.js`. Dedupe by URL and by content hash (sha256). Per-file size/time limits by kind plus a per-recreate budget (800 files, 300 MB). Cross-origin stylesheets downloaded and parsed (@font-face, @keyframes, @import). Modules: `assets/{index,collect,css,download,cdn}.js`; fixture `/cdn/` second origin + `recreate-assets.test.js`. SVG files are sanitized at the end of this step since 4a.5. |
| 4a.4 IR + HTML emitter | ✅ Done | `1bdd007` | Fixture fidelity **99/100** (every page 96–100). `ir/` (tree: view alignment, **responsive merge** of builder Desktop/Tablet/Phone copies into one element with base + tablet/mobile media queries, wrapper cleanup; styles: one class per distinct style, sizes restored from captured boxes; names: **semantic classes**, original names only when human-written, never builder/hashed/utility names; head: original tags kept, missing ones **auto-filled from the page and listed in `report.autoGenerated`**, missing `lang` reported not guessed; links: recreated pages relative, others live + reported), `emit/` (pages at original paths, `css/site.css`, **assets linked by relative local paths**, hard-linked files), `ir/site.json`. **Forms** keep markup, lose `action`, go to **Manual rebuild needed**. Generate step = IR + emit + fit pass; build step = basic fidelity (`verify/`). Fixture `work.html` + `recreate-generate.test.js`. Inline SVG is sanitized in the IR build since 4a.5. |
| 4a.5 Fixers + WP REST | ✅ Done | `f21f10d`, `813dd37` | **SVG sanitizer** (`fixers/svg.js`, allowlist rewrite) on every downloaded SVG file (assets step) and every inline SVG (IR build); HTML attribute guard (`fixers/html.js`); JSON-LD re-serialized; **safety gate** (`verify/safety.js`) re-parses `site/` and `dist/` and fails the job on any finding. Fixers (`fixers/`): alt text, accessible names, heading hierarchy, broken links, LCP `fetchpriority` + lazy loading, `font-display: swap`, font preloads → `report.fixes` + `report.autoGenerated`. **WordPress REST** (`fixers/wordpress.js`): clean text + head fields, IR `pages[].content`, post/page totals. **Production build** `dist/` (esbuild-minified CSS/JS, `build/minify.js`). Fixture: `/wp-json/wp/v2/`, WP-style contact page, fixer + unsafe-SVG seeds on `/work.html`; `recreate-fixers.test.js`. |
| 4a.6 Build, verify, preview | ⏳ Next | — | |

4a.5 manually verified via UI end-to-end on fixture (recreate cc12277c) — site renders correctly in browser, dist/ minified build confirmed.

> ✅ **SAFETY — resolved in 4a.5:** the generated site contains no script and no external reference. Every SVG file and
> every inline SVG is rewritten by the allowlist sanitizer; `on*`/`srcdoc`/`formaction`/script-URL attributes and active
> elements are removed in the IR build; JSON-LD cannot close its `<script>`. The generate step then re-parses every HTML,
> SVG and CSS file of `site/` and `dist/` (`verify/safety.js`) and **fails the job** if anything is found, so an unsafe site
> is never kept (`report.safety`). The site may now be previewed. Keep the defence in depth for Phase 4a.6/5 anyway:
> serve it from its own port (never the app origin) in a sandboxed iframe; while the site has no JS (until 4b), the
> sandbox needs no `allow-scripts`. Any JS added later (4b widget JS) must be generated by us and pass the safety gate.

Known issue: 2 `netGuard` tests fail on this Windows machine because `*.localhost` names don't resolve (DNS ENOTFOUND);
environmental, not a regression.

### Phase 4a decisions (approved)
- Minimal static preview server in 4a (one active preview, ports 5100–5199); full PreviewManager in Phase 5.
- Internal links to pages beyond the page limit point to the original live URL and are marked in the report.
- Missing text (meta description, alt) is generated by heuristics only (no LLM) and marked "auto-generated".
- Recreate needs a completed Analyze; an analysis older than 7 days gives a warning.
- One global lock: only one Analyze **or** Recreate job runs at a time (`server/src/jobs/manager.js`).
- Time limit 10 minutes, configurable with `SAS_RECREATE_MINUTES` (1–60).
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
- Safety gate (4a.5, `verify/safety.js`): after the fit pass, every HTML/SVG/CSS file of `site/` and `dist/` is parsed
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
  - **broken links**: targets in `audit.brokenLinks.broken` or discovery skips with an HTTP error lose `href`/`target`;
    the text stays. Unverified links (401/403/429/timeouts) are kept.
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
  `site/` stays readable. 4a.6 builds on and verifies `dist/`.

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
             components/{common,audit,preview,project,recreate}/  (preview/SitePreview.jsx = iframe/screenshot)
             store/useProjects.js, api/client.js, constants.js (STACKS), styles/
server/src/  index.js, db/index.js (schema + migrations), routes/{projects,analyze,screens,recreate}.js, dummy/audit.js
             jobs/ manager.js (JobManager + global one-job lock), sse.js
             recreate/ index.js (pipeline + STEPS + budget), jobs.js, inputs.js, workspace.js (tmp → final, retention),
                    errors.js, discover.js (page selection), inspect.js (step 1), capture/{index,snapshot}.js (Playwright capture),
                    assets/{index,collect,css,download,cdn}.js (step 2: local assets),
                    ir/{index,tree,styles,names,head,links}.js (IR), emit/{html,css}.js (plain HTML emitter),
                    fixers/{index,svg,html,a11y,perf,wordpress}.js (sanitizers + audit fixers + WP REST), build/minify.js (dist/),
                    generate.js (step 3: IR + fixers + emit + fit pass + dist + safety gate),
                    verify/{server,layout,fidelity,safety}.js (local render, fidelity = step 4, safety gate)
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
Ports: client **5173**, API **4000**, fixture site **4100**, Phase 5 previews **5100–5199** (planned).
For local testing, create `server/.env` (gitignored) with `SAS_ALLOW_LOCALHOST=1` so the fixture site can be analyzed.
If the frontend says "Cannot reach the API server", the server on 4000 is not running (or something else holds the port).
```bash
npm install
npm run dev          # client :5173 + server :4000 (concurrently)
npm run dev:server   # or: npm run dev:client
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
`GET /api/projects/:id/recreate/:recreateId/events` (SSE), `GET /api/health`. PATCH `/api/projects/:id` also takes `recreate_pages` (0–20) and `target_domain`.

## Currently dummy / known issues
- Analyze is real. Projects that were never analyzed still get the **dummy** audit (`isDummy: true`, "Dummy data" badge).
- Never-analyzed projects show a wireframe in the OLD preview. Still dummy: the NEW preview and the fix checklist
  (`audit.recreate`, which has `isDummy: true`; Phase 5).
  Recreate (Phase 4) and Download (Phase 6) stay disabled.
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
- Jobs live in memory; a server restart marks running analyses as failed.
- Project delete uses `window.confirm`. Git shows LF→CRLF warnings on Windows, which are harmless.
