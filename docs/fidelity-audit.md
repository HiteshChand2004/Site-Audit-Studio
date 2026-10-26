# Fidelity audit — Step 0 of CLONER_SPEC.md

Audit of the codebase as it stands on branch `exact-mode` (HEAD `bf657af` + uncommitted "every page recreated" work),
2026-10-14, against the version of `CLONER_SPEC.md` saved at 17:01 (the one with the SEO / performance phase). Nothing in
this document has been implemented for the spec yet. Sections 1–3 answer Step 0's questions 1, 2 and 4; section 2b answers
question 3 (the optimization and issue-fixing features); section 4 maps the spec onto the code; section 5 is the plan;
section 6 lists the decisions only you can make.

---

## 1. The pipeline today, end to end

Two apps in one repo: `client/` (React 19 + Vite, port 5173) and `server/` (Express 5, ESM, plain JavaScript, port 4000,
SQLite via `node:sqlite`). **No LLM anywhere** (every `llm` match in the code is `llms.txt`). Everything is deterministic.

### 1.1 Analyze (`server/src/audit/`)
`POST /api/projects/:id/analyze` → in-process job (`jobs/manager.js`, one global lock) → crawl (undici, SSRF-guarded), homepage
render + axe, screenshots at 1440/768/375, link check, Lighthouse (forked worker), stack detection
(`detection/engine.js` + one JSON rule file per platform: framer, webflow, wix, wordpress, nextjs, …). Bot challenges are
detected (`audit/http.js isBotChallenge`) and the analysis stops with a clear message.

### 1.2 Recreate (`server/src/recreate/index.js`, steps in `STEPS`)
1. **inspect** (`inspect.js`, `discover.js`, `capture/*`): discovery = SSRF-guarded mini crawl + the analysis's pages + a
   browser render for client-rendered shells. Each page is opened in **Playwright Chromium through a per-job SSRF egress
   proxy** at 4 views (1440 / 1024 / 768 / 375; exact mode adds 430), `domcontentloaded` → bounded `load` / `networkidle`
   waits → **real mouse-wheel scroll-through** (lazy content and IntersectionObserver reveals fire; revealed end states are
   pinned) → probes, per view:
   - `snapshot.js` — DOM + **computed styles** as diffs (pseudo-elements, inline SVG, `@keyframes`, `@font-face`, media
     queries, custom properties);
   - `asis.js` (exact mode) — the **rendered document** (scripts removed, open shadow roots as declarative shadow DOM) and
     **every stylesheet in cascade order**: `<link>` / `@import` bodies **from the network**, `<style>` text or its CSSOM
     when CSS-in-JS changed it, **`adoptedStyleSheets`** (document and shadow roots);
   - `interactions.js` — every `:hover` / `:focus*` / `:active` rule of readable sheets + cross-origin sheets fetched by
     `foreignCss.js`, then a **mouse probe** that hovers elements and diffs computed styles (JS-driven hovers, script
     "fingerprints" for Framer-like hovers, measured durations);
   - `reveal.js` (scroll reveals: declared animations + rAF sampling), `loops.js` (infinite CSS / WAAPI animations via
     `getAnimations()` + script-driven transform / opacity loops sampled per frame), `clicks.js` + `states.js` +
     `notices.js` (menus, accordions, tabs, carousels, dialogs), `feeds.js` (content changed by timers), `pointer.js`
     (cursor followers / parallax), `scrollstate.js` (sticky bars), `viewport.js` / `typography.js` (vh / fluid type);
   - screenshots (fold + full page).
   Exact mode also runs `exactCapture` (~20 viewport slots per page, frozen timers, box index, noise floor).
2. **assets** (`assets/*`): images, fonts, media, linked files downloaded through the SSRF guard, content-hashed, `url()`
   rewritten; SVGs sanitized (allowlist rewrite).
3. **generate** (`generate.js`, `ir/*`): one platform-free IR per page (`ir/site.json`). **Normal mode** rebuilds CSS from
   the computed styles (one class per distinct style, **semantic class names**, desktop-first media queries). **Exact mode**
   keeps the original markup, class names, ids, `data-*` and the original stylesheets verbatim (`ir/asis.js`), with
   per-width markup versions where the site's script rendered different DOM per width. Fixers (a11y, SEO, perf, contrast —
   most switched off in exact mode). Motion captured above becomes `data-motion` tokens + generated CSS
   (`emit/motionCss.js`) + **one fixed script of ours, `js/motion.js`** (`emit/motionScript.js`). **The original site's
   JavaScript is never copied** (a recorded decision; a "Mirror mode" that copied it was started and then reverted at your
   request on 2026-10-14).
4. **build** (`build/`): `dist/` minified with esbuild, **safety gate** (`verify/safety.js`: no script but ours, no
   external reference), link / asset / HTML verification, fidelity score.
5. **preview**, **exact** (pixel + box comparison at every slot, JS on, every non-local request aborted), **responsive**
   (7-width sweep), **stack** (React + Vite / Next.js / MERN built from the same IR by `emit/{react,next,mern}`, each checked
   for DOM + pixel **equivalence with the HTML build**).
6. **Re-audit** (`reaudit/`): the copy is analyzed with the same pipeline and diffed check by check; motion rows hold the
   copy's hovers (end values + timing), clicks, reveals, loops, feeds and pointer effects against the original's.

### 1.3 How it runs today
`npm run dev` (concurrently: Vite + `server/scripts/dev.js`). One Node process holds the API **and** every job: Playwright,
Lighthouse (forked child), preview servers on 127.0.0.1:5100–5199, stack builds (`build/toolchain.js` runs vite / next in a
child process with a minimal env, `--ignore-scripts` installs). Jobs live in memory (a restart marks them failed; Recreate
can resume from its checkpoint). Outputs on local disk under `data/`. Downloads are streamed zips. No Docker, no queue
service, no object storage, no LLM.

---

## 2. Where styles and behaviour are lost — the spec's checklist, verified in the code

| # | Known cause (spec) | Status here | Evidence / where |
|---|---|---|---|
| 1 | Styles from `getComputedStyle` lose `:hover`, `:focus`, `@keyframes`, `transition`, other breakpoints | **Normal mode: yes, by design** (rebuilt CSS), partly compensated: 4–5 captured views give the breakpoints, `@keyframes` are read, hover/focus come from the rule harvest + mouse probe and are re-emitted as `data-motion` rules. **Exact mode: no** — the original stylesheets are kept verbatim. | `capture/snapshot.js`, `ir/styles.js` vs `capture/asis.js`, `ir/asis.js` |
| 2 | Cross-origin `cssRules` `SecurityError` silently skipped | **Handled.** Exact mode reads sheet bodies from the network; the hover harvest fetches opaque sheets (`foreignCss.js`); unreadable sheets are counted in the report, not silent. | `asis.js recordSheetBodies`, `foreignCss.js`, `loops.js unreadableSheets` |
| 3 | CSS-in-JS via `insertRule` (empty `<style>` text) | **Exact: handled** (CSSOM used when it no longer matches the text). Normal: computed styles, so the result is right but the rules are rewritten. | `asis.js` (lines ~85–95) |
| 4 | Shadow DOM and `adoptedStyleSheets` | **Exact: open shadow roots + adopted sheets collected.** Closed shadow roots: not readable (browser limit). Normal: open shadow roots walked by the snapshot. | `asis.js:106–134`, `snapshot.js:258` |
| 5 | JS animation libraries dropped / frozen as one inline transform | **Partly.** No library is hooked (GSAP / ScrollTrigger / Lenis / Locomotive / AOS / Swiper / Lottie / Three.js are only named in comments). Their **visible effects** are measured and rebuilt by our own CSS + `js/motion.js`: scroll reveals, infinite loops (CSS / WAAPI keyframes), script loops **only through transform / opacity** (spin, x/y oscillation, opacity breathing, repeating drift), carousels / tabs / accordions as states, timed content as feeds, cursor followers. **Lost:** script motion through `left/top`, `filter`, `background-position`, SVG attributes; scale / rotation oscillations; pseudo-element loops not in a readable sheet; scroll-linked animations (reported); timeline sequencing (stagger is measured, a GSAP timeline is not); **Lenis smooth scroll** (native scroll in the copy); **Lottie / canvas / WebGL: emitted as a blank `<canvas>`, not reported** (found while auditing animations today). | `capture/loops.js findScriptLoops` (reads 5 properties), `ir/motion.js scriptLoop` / skip reasons, `capture/snapshot.js:239` |
| 6 | Capture before scroll | **Not an issue:** every view scrolls through with real wheel input before anything is read; reveal end states pinned. | `capture/index.js settle`, `reveal.js` |
| 7 | CSS through an LLM | **Not an issue:** no LLM. | — |
| 8 | Class names changed / hashed / purged | **Normal mode: renamed on purpose** (semantic names; builder / hashed / utility classes dropped) — consistent because the CSS is regenerated with them. **Exact mode: kept exactly.** No Tailwind purge, no CSS Modules anywhere. | `ir/names.js`, `ir/asis.js` |
| 9 | Original scripts on `DOMContentLoaded` before React mounts | **N/A** (no original script is lifted). Our own `js/motion.js` in React / MERN dev mode was fixed to load after the first render. | `emit/react/scaffold.js` |
| 10 | Broken relative `url()` in CSS | **Handled:** every `url()` resolved against its sheet and rewritten to a local asset; an undownloadable one becomes `url("data:,")` and is reported, never left pointing at the original. | `assets/css.js`, `ir/asis.js` |
| 11 | JS-driven hover (no `:hover` rule) | **Handled by state diffing**: mouse probe + script fingerprints (`will-change`, inline motion styles, `data-framer-*`-like attributes) + measured timing → generated `:hover` rules with a synthesized transition. Open bugs being fixed right now (in parallel): a button background not reproduced, hovering one link restyles neighbours. | `interactions.js`, `ir/motion.js synthTransition`, re-audit `motion.hover-match` |
| 12 | Framer appear animations stuck at inline `opacity:0` / `transform` | **Handled visually, not as animation:** the capture scrolls so Framer plays them and pins the end state; `ir/motion.js frozenEntrances` gives any box still caught in a first pose its end state + a rebuilt reveal; exact mode un-pins. **Framer's own appear config (`data-framer-appear-id` + its embedded JSON) is never parsed**, so timing/easing come from measurement, and an appear the capture never triggered gets a generic reveal. | `capture/reveal.js`, `ir/motion.js frozenEntrances`, `ir/asis.js unpin` |

Further losses found in this audit that the spec does not list:
- **Pages:** until today, login / account / cart / admin pages, 401/403/5xx pages, network failures, pages that failed
  capture and robots-closed pages were left out (fixed today, uncommitted: every page is recreated, see CLAUDE.md).
- **Normal mode between captured widths** relies on %/max-width heuristics (exact mode keeps the original media queries).
- **Narrow views** in exact mode: their hovers / reveals / loops are found but not all are placed (`notRebuilt` in the report).

## 2b. The SEO / performance optimization and issue-fixing features today (Step 0 question 3)

Both exist and run inside Recreate; the re-audit measures them. **Exact mode switches most of them off** (its "as-is
profile", `recreate/index.js` `ctx.exact` → `report.exact.asIs` lists each omission with the audit row it costs), because
it aims at pixel identity. The spec's Phase 5 keeps them and guards them instead — the main behavioural change ahead.

### Issue detection (what the tool knows is wrong with the original)
| What | Where | Scope |
|---|---|---|
| Lighthouse performance / SEO / a11y / best practices, mobile + desktop, failing audits with ids | `audit/lighthouse/*`, `audit/index.js` | homepage |
| axe-core violations (contrast, labels, alt, landmarks, headings, duplicate ids, …) | `audit/render.js`, `audit/analyzers/a11y.js` | homepage |
| SEO checks (title, description, canonical, OG / Twitter, headings, `lang`, robots meta, duplicates) | `audit/analyzers/seo.js` | every crawled page |
| AEO / structured data, `llms.txt`, FAQ signals | `audit/analyzers/aeo.js` | every crawled page |
| robots.txt, sitemap, meta tags | `audit/analyzers/crawlChecks.js`, `audit/robots.js`, `audit/sitemap.js` | site |
| Broken links (4xx / 5xx / DNS / refused = broken, 401 / 403 / 429 / timeouts = unverified, ≤ 500 links, SSRF-guarded) | `audit/linkChecker.js` | every crawled page |
| Mixed content, image / asset facts | `audit/extract.js` (facts) | every crawled page |
| Weaknesses summary, "manual rebuild needed" (forms, logins, CMS, WebGL …) | `audit/analyzers/weaknesses.js`, `detection/manual.js` | site |
| Console errors + failed requests of each viewport | `capture/exact.js` (exact baseline only) | exact mode |
| **Not detected today:** console errors outside exact mode, tap-target size / text < 12 px / per-element overflow at 390 px (only via Lighthouse audits), nested interactive elements, missing doctype | — | — |

### Fixes applied to the copy (`report.fixes`, one entry per fixer with fixed / partial / open + items)
| Fix | Where (pipeline stage) | Exact mode |
|---|---|---|
| Image `alt` (title / aria-label / figure caption / readable file name; decorative → `alt=""`) | `fixers/a11y.js fixAlt` (generate) | kept |
| Accessible names for links / buttons / fields (target page title, known service, icon hint, `stateRole` next / previous) | `fixers/a11y.js fixNames` (generate) | kept |
| Headings: one h1, no skipped levels, UA margins written explicitly | `fixers/a11y.js fixHeadings` (generate) | kept |
| Contrast: below 4.5 : 1 (3 : 1 large) → colour **mixed toward black or white in RGB** by the smallest amount (+0.08); axe findings decide for the homepage; text over images listed, not changed | `fixers/contrast.js` (generate, per view) | **off** |
| Broken links → `<span>` (text / class / id kept) | `fixers/perf.js fixBrokenLinks` (generate) | **off** (kept as links) |
| Loading: LCP image eager + `fetchpriority=high`, below-fold images `loading=lazy decoding=async`, LCP entrance animation removed | `fixers/perf.js fixLoading` (generate) | partly (no entrance removal) |
| Image variants: WebP / AVIF at displayed widths and 2×, never larger than the original, `srcset` + `sizes` | `assets/variants.js` (generate) | **off** (original bytes) |
| Fonts: `font-display: swap`, preload of the subset with most of the page's text, only used families downloaded, per-page `@font-face` subset pruning by `unicode-range` | `fixers/perf.js fixFonts`, `emit/css.js` | swap / preload kept, pruning **off** |
| Per-page CSS: only the classes, `@keyframes`, `@font-face` and custom properties a page uses; inline `<style>` per page; minified | `emit/css.js emitCss({ page })`, `emit/html.js`, `build/minify.js` (esbuild, **no renaming**) | as-is pages: their own sheets verbatim, minified |
| DOM size: state copies in `<template>`, unused SVG sprites removed, layout parts parked per width | `fixers/perf.js pruneSprites / markLayouts`, `ir/states.js` | sprites / parking **off** |
| JavaScript: none of the original's; one small deferred `js/motion.js` | `emit/motionScript.js` | same |
| Head: titles / descriptions outside length or duplicated rewritten from the page's own text, `theme-color`, `lang` detected, canonical / OG / Twitter filled, social image from the page's first screen | `ir/seoText.js`, `ir/head.js`, `generate.js addSocialImages` | rewriting **off**, filling kept |
| Structured data: WebSite + Organization on the homepage, FAQPage from question → answer pairs | `ir/structuredData.js` | kept |
| `sitemap.xml`, `robots.txt`, `llms.txt` | `ir/crawlFiles.js` | kept |
| Semantic HTML: `div[role=…]` → `nav / header / footer / main / aside`, plain wrappers removed | `ir/tree.js` | as-is pages keep the original tags |
| Safety: SVG allowlist sanitizer, HTML attribute guard, safety gate (no script but ours, no external reference) | `fixers/svg.js`, `fixers/html.js`, `verify/safety.js` | kept |
| Forms keep their markup and lose `action` (all forms), reported as "manual rebuild needed" | `ir/links.js`, generate | kept |
| WordPress text from `/wp-json/wp/v2/` | `fixers/wordpress.js` | kept |

### How "better than the original" is checked today
The re-audit (`reaudit/`) runs the same Analyze pipeline on the copy (served locally, gzipped like a host would) and compares
it check by check with the original's analysis: `fixed / improved / open / regressed / changed / recheck / manual / n/a`,
with evidence linking each fixed row to the fixer that fixed it (`reaudit/compare/rules.js EVIDENCE`), plus Lighthouse
scores and metrics before → after. A row that got worse is `regressed` — the spec's "no new problems" rule exists in this
form, but nothing reverts the fix that caused it.

### Gaps against the spec's Phase 5
- **No per-step guard:** fixes are applied together in generate; nothing re-runs the fidelity checks after each one or
  reverts one fix for one file. (The fit pass and the exact correction loop revert *their own* CSS rounds, not fixers.)
- **No `fixMode`** (`fix-all` / `balanced` / `fidelity`); exact mode is effectively `fidelity`, normal mode `fix-all`.
- **No `intentionalChanges.json`**, so the exact comparison counts a contrast fix as a difference.
- **Contrast does not keep saturation** (RGB mix toward black / white); the spec asks for lightness only.
- Tap targets, readable mobile font size, mobile overflow, focus styles, CLS space reservation: not fixed (Lighthouse may report them).
- No `noindex` by default (notice pages only), no footer marker, no deployment config (`vercel.json` exists only for Next.js
  redirects), no `dynamicClasses.json` safelist (per-page CSS pruning works on the IR's own classes, which is safe in normal
  mode but would not be for verbatim original CSS).

## 3. Deployment risks (Step 0 question 4)

| Spec concern | Today |
|---|---|
| Playwright inside the API process | **Yes.** Analyze / Recreate / Re-audit run in the Express process (`jobs/manager.js`), Lighthouse in a forked child. |
| Job queue | **In-memory FIFO + one global lock**; state mirrored to SQLite; lost on restart (Recreate resumes from a checkpoint). No Redis / BullMQ, no worker separation, concurrency 1. |
| Timeouts | Per step and per page load / asset / render; Analyze 6 min. **Exact mode deliberately has no overall limit** (your decision). |
| SSRF | **Present and strong:** `security/netGuard.js` (connect-time IP check, every redirect, IPv4-in-IPv6, private / loopback / link-local / metadata ranges) + a per-job egress proxy for Chromium and Lighthouse; tests exist. Missing vs spec: a single `blocked-url` failure code. |
| Generated code on the main server | **Yes:** stack builds (`vite build`, `next build`) and the MERN tests run as child processes of the API server; preview servers run in-process on host ports. No container sandbox. |
| Storage | Local disk (`data/`), zips streamed on request; no object storage, no signed URLs, no expiry (retention keeps the latest 2 recreates). |
| Observability | Console logs per job; report JSON per job; no structured log sink. |
| Docker / fonts | No Dockerfile; screenshots depend on the host's fonts. |

## 4. The spec against the code

| Spec | Exists | Gap |
|---|---|---|
| Phase 1.1 network recording | Shared cache records static responses (`audit/sharedCache.js`); asis reads sheet bodies | No complete asset map of scripts / data in a bundle |
| 1.2 GSAP / ScrollTrigger hooks (`__animLog`) | — | **New** |
| 1.3 SSR HTML separately | Fingerprint keeps the raw response only as a hash | **New** (store `ssr.html`) |
| 1.4–1.5 networkidle + slow auto-scroll | Yes (exact recipe: 300 px / 150 ms) | — |
| 1.6 full CSSOM in cascade order | Yes in exact mode (`asis.js`) | Not in normal mode (by design) |
| 1.7 `getAnimations()` | Yes (`loops.js`, `reveal.js`) | CSSTransition excluded on purpose |
| 1.8 library + builder detection | Builders yes (`detection/rules/*.json`) | **Libraries + bundle fingerprinting: new** |
| 1.9 site type (`canvas-rendered`, `bot-protected`) | bot-protected yes (Analyze) | **canvas-rendered: new**; Recreate does not re-check bot pages |
| 1.10 hover state diffing | Yes (`interactions.js`) | Output as `hoverStates.json` (format) |
| 1.11 strip mid-animation inline styles | Partly (reveal pins / unpin) | Generalise to all known animation targets |
| 1.12 reference screenshots incl. hover states | Screenshots + exact slots yes | **Per-element hover screenshots: new** |
| 1.13 `dynamicClasses.json` (MutationObserver for the whole session) | — | **New** (needed as the purge safelist once original CSS is kept) |
| 1.14 `visibility.json` | Box index has painted boxes | **Visibility record + Phase 4 check: new** |
| 1.15 `baseline.json` (Lighthouse mobile + desktop of the original) | Analyze already runs it (homepage) | Reuse; extend to every page or keep homepage (§6) |
| 1.16 `issueAudit.json` | Analyze: Lighthouse, axe, SEO, links, mixed content; exact: console errors | **New:** console errors in every mode, mobile layout at 390 px, invalid HTML, one issue list with ids |
| 1.17 capture bundle layout | `capture/<slug>/…` | Different file names (mapping, not a rewrite) |
| Phase 2 Tier 1 replay (gsap package) | — | **New** |
| Phase 2 Tier 2 script lift | **Contradicts a recorded decision** (see §6) | — |
| Phase 2 Tier 3 embed (Lottie / WebGL) | — | **New** (depends on §6) |
| Phase 2A Framer adapter | Framer detected; appear handled visually | **Appear-config parser + `motion` conversion: new** |
| Phase 3 emitters keep classes / original CSS | Exact mode: yes for all 4 stacks | Normal mode renames (would change) |
| Phase 4 verification | Exact compare, re-audit motion rows, equivalence | `visibility` hard check, per-section diff + auto-retry tiers, `fidelity-report.html`: **new** |
| Phase 5 optimization guarded by fidelity | Optimizations + fixers exist (§2b), re-audit compares | **Per-step guard + revert, `fixMode`, `intentionalChanges.json`, lightness-only contrast, tap targets / mobile font / overflow / focus fixes, deployment config, `noindex` default, before / after table in the fidelity report: new** |
| Phase 6 API / worker / BullMQ / Docker / S3 | — | **All new** (largest piece) |
| Safety: forms with password / card fields | Forms lose `action` (all forms) | Field-type rule + local no-op handler |
| "Clone preview" footer marker | — | **New** (would show in exact pixel comparisons, §6) |

---

## 5. Plan (proposed — nothing implemented yet)

Order chosen so every step leaves the app working and the existing API / UI contract unchanged; each step ends with its
tests + the fixture clones, a WIP commit, and a report to you.

**Step 1 — Fixtures + measurement first** (no behaviour change). The seven spec fixtures in `server/test/fixtures/cloner/`
(pure CSS hover + keyframes, GSAP + ScrollTrigger, cross-origin sheet + styled-components, JS-only hover, a Framer-style SSR
page with `data-framer-appear-id` + embedded appear config, a canvas-rendered page, a page with known problems), served
locally; the existing animation lab joins them. A fidelity runner that clones each fixture in all 4 stacks and reports
what is lost and where. This turns the spec's acceptance criteria into failing tests before any fix.

**Step 2 — Phase 1 capture additions** (`server/src/recreate/capture/`, JavaScript like the rest of the repo):
`ssr.html` per page; a full network asset map (scripts + data too); the GSAP / ScrollTrigger init-script hooks
(`__animLog`, stable selectors); the session-long MutationObserver → `dynamicClasses.json`; library fingerprinting
(globals + bundle contents) → `libs.json`; site-type detector (`standard | framer | webflow | wix | canvas-rendered |
bot-protected`) that stops canvas-rendered and bot-protected pages with a clear reason; `visibility.json`; per-element hover
screenshots; `baseline.json` (the analysis's Lighthouse run, reused) and `issueAudit.json` (the analysis's findings plus
console errors, 390 px layout problems and invalid HTML, one list with stable issue ids); the bundle files named as the spec
names them (written beside the existing ones, so nothing that reads today's files breaks).

**Step 3 — Style layer: "preserve, don't regenerate" for every stack.** Make the as-is path (original markup, classes,
ids, data-attributes, verbatim CSS in cascade order, only `url()` rewritten) the base for all four emitters, not only in
exact mode — normal mode's regenerated CSS stays available as a fallback (and is what the fixers improve). Unit tests:
CSSOM serializer, `url()` rewriter.

**Step 4 — Behavior layer, Tier 1 + recorded hover + Framer adapter.** GSAP replay from `__animLog` with the real `gsap`
package (`gsap.context()` + `ctx.revert()` in React / Next, a module in HTML); `hoverStates.json` → `:hover` CSS (all
stacks); Framer appear-config parser (tolerant, built from real Framer pages) → `motion` (`initial` / `animate` /
`whileInView`) with the safe fallback (never invisible); scroll-linked linear transforms → `useScroll` / `useTransform`.
The animation work already under way (script motion via `left/top` / filter / background / SVG attributes, scale and
rotation oscillations, pseudo-element loops, canvas reported + shown as a still frame) lands here. Tier 2 / Tier 3 only as
decided in §6.

**Step 5 — Phase 4 verification.** Visibility hard check + auto-fix + re-check; hover replay against `hoverStates.json`;
per-section pixel diff at 1440 / 390 (the exact engine's pixel code, no new dependency) with up to 2 retries on the next
tier; `getAnimations()` / `:hover` / `@keyframes` counts; `fidelity-report.json` + `fidelity-report.html` for every clone.

**Step 6 — Phase 5: optimization and issue fixing, guarded by fidelity.** Today's optimizations and fixers (§2b) move into
an ordered pipeline (`server/src/recreate/optimize/`, `optimize/fixes/`) that runs after the Phase 4 checks pass and
re-runs them after each step, reverting only the step (and only the files) that broke a check. `fixMode`
(`fix-all` default / `balanced` / `fidelity`) per project and per run; every visible change written to
`intentionalChanges.json` and treated as expected by the verifier. Changes to existing fixers: contrast becomes
lightness-only (same hue and saturation, smallest shift); broken links stay links and are reported (the spec's rule — today
they become `<span>`); new fixes for tap targets, readable mobile text, 390 px overflow, focus styles and CLS space; CSS
purging of verbatim original CSS with the `dynamicClasses.json` + hover / animation safelist; deployment config (caching,
compression, security headers) per stack marked "fixed on deploy"; `noindex` + footer marker by default with an off switch;
the clone's issue audit re-run ("no new problems"); Lighthouse before / after table. Exact mode = `fidelity` mode.

**Step 7 — Safety guardrails.** Forms with password / card / CVV / OTP / SSN fields lose `action` and get a local no-op
handler (others as today); auth / payment / analytics scripts never carried.

**Step 8 — Phase 6 production architecture** (the largest step, kept last so steps 1–6 are usable locally meanwhile):
API / worker split with BullMQ + Redis (the API keeps today's routes and SSE contract and enqueues instead of running);
worker Dockerfile on the matching `mcr.microsoft.com/playwright` image with Noto + emoji fonts; per-job verification
sandbox container (CPU / memory / time limits, no network to the internal side, ephemeral); S3-compatible storage with
signed, expiring URLs (MinIO in compose); `blocked-url` / `timeout` / `canvas-rendered` / `bot-protected` failure codes;
structured logs per `jobId`; `.env.example`; `docker-compose.yml`; `docs/deployment.md`; the concurrency test (5 jobs at
concurrency 2). SQLite stays for project data unless you want Postgres.

**Step 9 — Optional live smoke test** against 2–3 sites you list in a config file, off in CI.

## 6. Decisions (final, CLONER_SPEC v2)

Final as written in the spec's "Decisions (final)" section, 2026-10-15:

1. **Script lift = targeted.** Only scripts fingerprinted as animation / UI / interaction libraries (GSAP, ScrollTrigger, Swiper,
   Lottie, webflow.js, Bootstrap JS, jQuery plugins, Alpine.js, …) and the site's own small interaction scripts when they are the
   only source of a recorded interaction. Never app / framework bundles, trackers or auth scripts. Only the recorder is taken from
   `mirror-mode-wip`, not mirror mode's output path.
2. **Trackers:** the name denylist first (extending `detection/manual-rules.json`, no new list), then the measured-role rule for
   anything not on it.
3. **As-is is the base of every copy.** Exact mode becomes `fixMode: fidelity`. Normal mode (CSS regenerated from computed
   styles) leaves the default path and stays behind a flag.
4. **Footer marker + `noindex` on by default.** One "This is my own site" switch turns both off and allows islands. The marker
   region is masked in pixel tests.
5. **Broken links** ("Copy my site", docs/COPY-MY-SITE.md §3): a link is called broken only after repeated real-browser checks (401 / 403 / 429 / timeouts are "couldn't verify"). Safe internal links are fixed (wrong path or trailing slash → the copy's page; redirect → final address; http that works on https → https; confirmed 404 on the original → the copy's 404 page). Dead external links are never changed: they are flagged with a suggestion for the owner. Everything else is left unchanged and reported. The earlier rule ("never unlinked", links kept as they are) applies only to the clean rebuild path and is superseded for "Copy my site".
6. **Lighthouse** on the homepage by default, configurable to the top N pages. The cheap checks (axe, console errors, broken
   assets, mobile overflow, every Phase 4 check) run on every page.
7. **Language:** JavaScript, new folders added without restructuring existing ones, `// @ts-check` + JSDoc in new modules.
8. **Phase 6 last.** Everything is built as a pure `runJob(config) → outputs` function with no Express dependency; Phase 6 must be
   complete before the tool goes public.
9. **In-flight work:** commit "every page recreated", merge the hover + FAQ fix, fold the animation work into the behaviour step,
   speed work after Phase 6. **Done:** 2138098, 06e9afa, 505d72d, 8380cf6.

Answers given with the v2 plan approval (2026-10-15):
- Click behaviour in React / Next / MERN keeps the one shared `js/motion.js`, initialised from a client component's `useEffect`
  with cleanup, re-binding after re-renders and client-side route changes (a Next route-change test is required).
- The capture's mobile view moves from 375 to 390 px; tests asserting 375 are updated and listed in the commit message.
- Toolchains are installed in the worktree. The pre-commit hook runs the fast unit tests + the HTML/CSS stack fixtures;
  `npm run test:fixtures` runs the full 4-stack fixture suite and must pass before each step's final commit.
- Live sites (corpus / smoke) only when the user starts the script.
- **Video tier** added to the spec (Phase 2 item 9, fixture 11, report "clean vs approximated vs islands").

---

## 7. Plan vs existing code (v1 tables 2026-10-14, v2 additions 2026-10-15)

Checked against the code on 2026-10-14 (functions named as exported). **Status:** done / partial / missing. **Decision:**
reuse (as is) / extend (add to the existing module) / new (nothing to build on) / replace (only where the existing code
cannot be extended; the reason is given). "In flight" = uncommitted work in this tree or in the parallel hover + FAQ worktree.

### Step 1: Fixtures + fidelity runner

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| F1 pure CSS hover / keyframes | partial | `test/fixtures/recreate-site/` (`styles.css` hovers + spinner keyframes, `hover.js`); in-flight `test/recreate-animation-lab.test.js` (CSS spin, background flow, pseudo loop) | one page that is only this, cloned in all 4 stacks with rule counts compared | extend |
| F2 GSAP + ScrollTrigger | missing | none (GSAP is only named in comments) | the page, a local copy of gsap + ScrollTrigger (dev dependency, served by the fixture server) | new |
| F3 cross-origin sheet + styled-components | partial | `test/recreate-exact-asis.test.js` (CSSOM-changed `<style>`, constructed sheets, network sheet bodies); `recreate-hover-probe` (foreign sheet) | one fixture with a second origin serving a non-CORS sheet + a CSS-in-JS runtime (`insertRule`), through all 4 stacks | extend |
| F4 JS-only hover | partial | `test/recreate-hover-probe.test.js`, `recreate-synthetic-motion.test.js`, in-flight `recreate-hover-toggle.test.js` | as a spec fixture page through all 4 stacks | extend |
| F5 Framer-style SSR + appear config | missing | saved real Framer captures exist (incredible-dragon `8e134d55…`, parchaa) to build it from | the fixture page (SSR markup, `data-framer-appear-id`, embedded appear JSON as Framer ships it today) | new (built from the saved captures) |
| F6 canvas-rendered page | missing | the in-flight animation lab has one animated canvas cell | a page that is a full-screen canvas / `flt-*` elements | new |
| F7 known-problems page | partial | `test/fixtures/site/` (seeded audit issues: missing alt, broken link, meta), `recreate-site` fixer seeds, in-flight `recreate-backend-pages` fixture | low-contrast text, duplicate ids, console error, 390 px overflow in one page | extend |
| Fidelity runner (clone a fixture in 4 stacks, report what is lost where) | partial | `runRecreate` (`recreate/index.js`), stack export `export/fromIr.js buildStackOutput`, `verify/exact/compare.js compareExact`, `verify/equivalence.js compareBuilds`, `reaudit/motion.js motionItems`, in-flight lab's `watchLabels` / `summarizeTrace` / stage diagnostics | one test helper that does all of it per fixture | extend (compose; no new engine) |

### Step 2: Capture additions (Phase 1)

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| 1.1 network asset map | partial | `audit/sharedCache.js createSharedCache` (GET 200 stylesheet / script / image / font bodies, per job, temp folder); `capture/asis.js recordSheetBodies` (sheet bodies); `assets/index.js downloadAssets`; per-view `resources` in `capture/index.js captureView`; branch `mirror-mode-wip` has `capture/mirror.js createMirrorStore` (every GET body, content-addressed, redirects, unreproducible requests) | data (XHR / fetch) and scripts kept after the job; one persisted map | extend `sharedCache` with a persisted manifest (or take `createMirrorStore` from the branch). **Do not add a fourth recorder** |
| 1.2 GSAP / ScrollTrigger init-script hooks to `animLog.json` | missing | the init-script pattern exists: `verify/exact/freeze.js freezeTimers`, `capture/asis.js markAsIs` | the hook (property setter on `window.gsap`; wrap `to / from / fromTo / set / timeline`; ScrollTrigger config); stable selectors | new |
| 1.3 `ssr.html` | partial | `capture/exact.js pageFingerprint` reads the raw response but keeps only a hash; `mirror-mode-wip` kept the raw document | save the body per page | extend |
| 1.4 networkidle + settle | done | `capture/index.js captureView` (`domcontentloaded`, then bounded `load` up to 10 s / `networkidle` up to 5 s); `verify/exact/recipe.js settleExact` (4 s + fonts) | none (bounded waits are deliberate: some sites are never idle) | reuse |
| 1.5 slow auto-scroll 300 px / 150 ms | done | `verify/exact/recipe.js settleExact` (exactly 300 px / 150 ms, real wheel); `capture/index.js settle` (wheel steps under one viewport + reveal tracking) | none | reuse (and merge the two recipes, see duplicates) |
| 1.6 full CSSOM in cascade order | done (exact mode) | `capture/asis.js readAsIs / captureAsIs / sheetText / cssRefs`: `document.styleSheets`, `adoptedStyleSheets`, open shadow roots (declarative), CSS-in-JS via CSSOM, cross-origin via the network body; `ir/asis.js pageSheets` (`@import` inlined under its media / layer / supports) | run in normal mode too (decision 3); write `styles/*.css` (today inside `<view>-asis.json`) | reuse + extend |
| 1.7 `getAnimations()` to `animations.json` | partial | `capture/loops.js scanAnimations` (repeating CSS / WAAPI, keyframes, timing); `capture/reveal.js installRevealTracker` (one-shot); `verify/exact/freeze.js` | CSS transitions in the list; one combined file | extend |
| 1.8 library + builder detection to `libs.json` | partial | `detection/engine.js detectStack / matchSignal` + `detection/rules/*.json` (framer, webflow, wix, nextjs, gatsby … with signals and weights); `detection/manual.js` + `manual-rules.json` (Intercom, HubSpot, reCAPTCHA, maps, payments …) | rule files for gsap, ScrollTrigger, Lenis, Locomotive, AOS, Swiper, Lottie, canvas / WebGL; a signal type for **script-body fingerprints** in `matchSignal` | extend (new JSON rules + one signal type; the engine was built for this) |
| 1.9 site type | partial | bot-protected: `audit/http.js isBotChallenge` (Analyze `audit/index.js` and Recreate `discover.js` both stop); builders from `detectStack` | `canvas-rendered` (Flutter `flt-*`; canvas covering the viewport with little text); one `siteType` result | extend |
| 1.10 hover state diffing to `hoverStates.json` | done | `capture/interactions.js captureInteractions` (rule harvest, mouse probe, `diffStates`, `keepReverting`, script fingerprints, measured `scriptedMs`), `cssStateEffects`, `capture/foreignCss.js`; skip-if-CSS-explains = `source: 'css'` vs `'probe'`; in-flight hover + FAQ fix | the spec's file name / shape (the data is in `motion.json` `hover`) | reuse (+ write the file) |
| 1.11 strip mid-animation inline styles | partial | `capture/reveal.js` pins (`data-sas-pin`) to `ir/asis.js unpin`; `ir/motion.js frozenEntrances`; `fixers/perf.js showFaded` | the same for GSAP / animLog targets | extend |
| 1.12 reference screenshots | partial | `capture/index.js` fold + full per view (1440 / 1024 / 768 / 375 / 430); `capture/exact.js shootBands` (~20 slots incl. 390, bands = scroll positions); `audit/screenshots.js captureScreenshots` | a screenshot of each element's hover state | extend |
| 1.13 `dynamicClasses.json` (session-long MutationObserver) | missing | `capture/feeds.js watchMutations` is a windowed observer, not session-long | an init-script observer recording added classes / `data-*` / `aria-*` | new (small) |
| 1.14 `visibility.json` | partial | `verify/exact/boxes.js collectExactBoxes` (every painted element with its box, per slot, saved with the baseline) | the hidden ones and the reason (opacity / visibility / size / off-screen) | extend |
| 1.15 `baseline.json` | done | `audit/lighthouse/run.js runLighthouse` (mobile + desktop, homepage), `audit/analyzers/metrics.js`; stored in the analysis (`audit.metricsByDevice`, scores) | the file, read from the analysis | reuse |
| 1.16 `issueAudit.json` | partial | `audit/analyzers/{seo,aeo,a11y,crawlChecks,weaknesses}.js`, axe (`audit/render.js`), `audit/linkChecker.js checkLinks`, mixed-content facts (`audit/extract.js`), console errors + failed requests (`capture/exact.js visitSlot`, exact only), html-validate (`verify/site.js verifySite`, used on the copy only) | stable issue ids in one list; console errors in every mode; 390 px checks (overflow, text under 12 px, targets under 24 px); html-validate run on the original; nested interactive; doctype | extend |
| 1.17 bundle layout | partial | `capture/<slug>/…` + `capture/manifest.json` | the spec's file names: an index that points at the existing files (no move) | extend |

### Step 3: Style layer in every stack

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| Original CSS verbatim, cascade order | done (exact) | `ir/asis.js applyAsIs / pageSheets / localizeCss`; `emit/css.js emitCss` (as-is pages: their own sheets only) | default for every copy (decision 3); emitted as global sheet files instead of inline `<style>`; Next `app/globals.css` | extend |
| Keep classes / ids / `data-*` / `aria-*` | done (exact) | `ir/asis.js asisBody` (attribute guard only); `emit/react/jsx.js` (`className`, React prop names) | none | reuse |
| `url()` rewrite + self-hosted fonts | done | `ir/asis.js localizeCss`; `assets/css.js parseStylesheet / parseFontSrc`; `assets/index.js` | the spec's unit test for the rewriter | reuse + test |
| No CSS Modules / Tailwind purge | done | none used anywhere | none | reuse |
| Per-width markup versions | done | `ir/asis.js mergeViewBodies / variantCss`; in-flight `settleSelfChanging` | none | reuse |
| Regenerated CSS (normal mode) | done | `ir/styles.js`, `ir/tree.js`, `verify/correct.js` | kept only as the fallback for a page whose CSS cannot be read | reuse (as fallback) |

### Step 4: Behavior layer

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| Tier 1 GSAP replay | missing | none | a generator from `animLog.json` using `gsap` (+ `gsap.context()` / `ctx.revert()` in React / Next); the dependency in generated `package.json` | new |
| Tier 2 script lift | missing (main) / built (branch) | branch `mirror-mode-wip`: `mirror/rewrite.js createRewriter`, `mirror/shim.js mirrorShim`, `mirror/csp.js mirrorScriptHashes`, `mirror/paths.js planMirror` | depends on decision 1 | reuse from the branch if allowed, else n/a |
| Tier 3 embed (Lottie, WebGL, video) | missing | video is already copied as media (`assets/`) | Lottie JSON + player, WebGL assets | new (if decision 1 allows) |
| Recorded hover to `:hover` CSS | done | `ir/motion.js applyMotion` (hover tokens, `synthTransition`), `emit/motionCss.js`; in-flight hover + FAQ fix | none | reuse (after the merge) |
| Clicks / FAQ / tabs / carousels / dialogs | done | `capture/clicks.js`, `capture/states.js`, `ir/states.js expandStates`, `js/motion.js` (`emit/motionScript.js`); in-flight fixes | none | reuse |
| Timed content (feeds), cursor followers, sticky bars, reveals | done | `capture/feeds.js`, `capture/pointer.js`, `capture/scrollstate.js`, `capture/reveal.js` + `ir/motion.js` | none | reuse |
| Continuous loops | partial | `capture/loops.js scanAnimations / findScriptLoops / analyzeSeries`; `ir/motion.js scriptLoop`; in-flight lab test | script motion via `left/top`, `filter`, `background-position`, SVG attributes; scale / rotation oscillation; pseudo-element loops without a readable sheet | extend (the in-flight animation work) |
| Canvas / WebGL / Lottie | missing | `capture/snapshot.js` keeps `<canvas>` as an empty node | report + still frame (Tier 3 if allowed) | extend |
| Framer appear adapter | partial | measured: `capture/reveal.js` (duration, fitted easing, delay, from / to) to `ir/motion.js` reveal tokens + `frozenEntrances` (safe fallback: never invisible) + `ir/asis.js unpin` | parse Framer's own appear config (`data-framer-appear-id`) instead of measuring | extend: feed the parsed config into the existing reveal spec (opacity / translate / scale / rotate / duration / delay / easing), emitted by the existing CSS + `js/motion.js` in all 4 stacks; the `motion` package only for what CSS cannot express (springs) |
| Framer hover / tap variants | done (hover) / missing (tap) | mouse probe | an `:active` diff (mouse down / up) | extend |
| Scroll-linked (parallax, progress) | partial | `capture/loops.js` flags ScrollTimeline loops (reported, skipped); `capture/scrollstate.js probeScrollStates` (threshold states) | sample transform vs scroll position, fit linear, emit (CSS `animation-timeline: scroll() / view()` needs no JS; `useScroll` only if required) | new |
| Webflow `webflow.js` | n/a | none | depends on decision 1 | decision |

### Step 5: Verification (Phase 4)

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| Serve the clone and open it | done (local) | `verify/server.js startSiteServer`, `preview.js servePreview`, stack builds `build/toolchain.js` | the sandbox container (Step 8) | reuse, then extend |
| Screenshot diff per section at 1440 / 390 | done (per slot / band) | `verify/exact/compare.js compareSlot / compareExact` with `verify/exact/pixels.js exactDiff` (pixelmatch's YIQ metric + antialias, bands, `diffRegions`, diff map, 3x crops), ~20 slots incl. 1440 and 390, noise floor | sections (per landmark / band), a 3 % threshold setting, hover-state shots | extend (no new comparator, see duplicates) |
| Animation / `:hover` / `@keyframes` comparison | partial | `reaudit/motion.js motionItems` (reveal, hover, hover-match, loops, clicks, feeds, pointer rows); `verify/exact/freeze.js frozenSummary` | CSSOM rule counts (`:hover` / `:focus` / `@keyframes` names) | extend |
| Visibility hard check + auto-fix + re-check | partial | pre-emptive: `fixers/perf.js showFaded`, `ir/motion.js frozenEntrances`; missing boxes in `compareSlot` | check every `visibility.json` element after settling, fix, re-check | extend (loop pattern from `verify/exact/correct.js`) |
| Hover check against the original | done | `reaudit/motion.js` hover-match (end values + duration), `capture/measure.js measureMotion` | read `hoverStates.json` | reuse |
| Retry a section with the next tier (up to 2) | missing | revert / retry machinery: `verify/correct.js` (ledger, judge, revert), `verify/refine.js` | tier switching | extend |
| `fidelity-report.json` / `.html` | partial | `report.json` (`report.exact`, `report.motion`, `report.fixes`), app `RecreateReport.jsx`, `report/render.js renderReportHtml` + `report/pdf.js` | a per-clone HTML with side-by-side shots, diff %, tier per animation source, visibility / hover results | extend `report/render.js` |

### Step 6: Optimization and fixes, guarded (Phase 5)

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| The ~20 optimizers / fixers | done | §2b table (`fixers/*.js`, `ir/seoText.js`, `ir/structuredData.js`, `ir/crawlFiles.js`, `ir/head.js`, `assets/variants.js`, `emit/css.js`, `build/minify.js`) | run as ordered, individually revertible steps | reuse each; extend the orchestration |
| Per-step guard + revert per file | missing | the same idea exists for CSS rounds: `verify/correct.js` (judge, ledger, anti-oscillation, revert), `verify/refine.js` (a variant kept only when it scores better) | apply, re-run the Phase 4 checks, keep / revert, per optimizer | extend (generalise that machinery) |
| `fixMode` fix-all / balanced / fidelity | partial | exact mode's as-is profile (`ctx.exact`, `ir.asIs`, `report.exact.asIs`) = `fidelity` | the setting (project + run); `balanced` thresholds | extend |
| `intentionalChanges.json`, treated as expected by the verifier | missing | fixers record items (`report.fixes[].items`) | selector / property / before / after / issue id; masking in `compareSlot` (it already masks `excluded` parts) | extend |
| Contrast, lightness only (same hue + saturation) | partial | `fixers/contrast.js fixContrast / passingColor / axeContrastFindings` | the colour search: an RGB mix toward black / white changes saturation | **replace `passingColor`'s search only** (an RGB mix cannot keep saturation by construction; the rest of the fixer is reused) |
| Tap targets, mobile font size, 390 px overflow, focus styles, CLS space | missing | none | new fixers | new |
| Unused-CSS removal with a safelist | partial | `emit/css.js pageClasses / usedCustomProps / pageFontFaces / pageMotion` (works on the IR's own classes) | for verbatim original CSS: selector matching against the DOM + `dynamicClasses.json` + hover / animation safelist | new (needs Step 2's `dynamicClasses`) |
| Images WebP / AVIF, same intrinsic size, width / height | partial | `assets/variants.js makeImageVariants / applyImageVariants` (variants at shown widths, `srcset`); `fixers/perf.js fixLoading` | a same-dimension re-encode of the main `src`; explicit `width` / `height` | extend |
| Fonts swap / preload / subset | partial | `fixers/perf.js fixFonts`; `emit/css.js pageFontFaces / charsCovered` (picks existing `unicode-range` subsets) | actual glyph subsetting of a font file | extend (if wanted) |
| Minify without renaming | done | `build/minify.js minifyCss / minifyJs / buildDist` (esbuild, no identifier renaming in CSS) | a test that keyframe / custom-property names survive | reuse + test |
| Meta / OG / canonical / robots / sitemap / JSON-LD / `lang` / alt | done | `ir/head.js buildHead`, `ir/seoText.js refineHeadTexts / detectLang`, `ir/structuredData.js addStructuredData`, `ir/crawlFiles.js crawlFiles`, `fixers/a11y.js fixAlt` | none | reuse |
| Broken links: keep + report | partial (the opposite today) | `fixers/perf.js brokenTargets / fixBrokenLinks` (unlinks to `<span>`) | keep the link, report it (decision 5) | extend (a mode switch in `fixBrokenLinks`) |
| Deployment config (cache, compression, security headers) | partial | the MERN server template sets security headers + compression; Next.js `vercel.json` / `_redirects` only for moved URLs (`emit/next/routes.js`) | per stack: `vercel.json`, `netlify.toml`, an nginx snippet, Next `headers()` | extend |
| `noindex` + footer marker by default | missing | notice pages are `noindex` (`ir/notice.js`) | the default meta + marker + off switch; `crawlFiles` must not drop pages because of our own `noindex` | new (small) |
| "No new problems" | done | re-audit `reaudit/compare/{index,rules}.js` (`regressed` status, evidence per fixer) | trigger a revert from a regression | extend |
| Before / after Lighthouse table | done | re-audit scores + metrics before / after; `report/render.js` charts | in `fidelity-report.html` | reuse |
| Heavy lifted-JS report | partial | re-audit row `stack.javascript` (bundle bytes vs the original) | per lifted script (only with Tier 2) | extend |

### Step 7: Safety guardrails

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| Forms with password / card / CVV / OTP / SSN: no action + local no-op | partial | every form loses `action` in the copy (reported as manual); MERN skips password forms (`emit/mern/forms.js`) | field-type detection + an explicit no-op handler | extend |
| No auth / payment / analytics scripts | done | no original script is copied; integrations listed by `detection/manual.js` | with Tier 2: a denylist (decision 2), as `manual-rules.json` / `rules/*.json` entries, which are already that registry | reuse |
| Footer marker | missing | none | see Step 6 | new (small) |

### Step 8: Production architecture (Phase 6)

| Sub-item | Status | Where it exists | Missing for the spec | Decision |
|---|---|---|---|---|
| API / worker split, BullMQ + Redis, `jobId`, progress | partial | `jobs/manager.js JobManager` (start / stop / SSE / progress tracker / global lock), `jobs/sse.js`; routes return 202 + job id | a queue backend + a separate worker process | extend (keep the `JobManager` interface and the SSE contract, swap the backend) |
| Worker Dockerfile (Playwright image, fonts, shm), compose with Redis | missing | none | all of it | new |
| Concurrency + per-job / per-phase timeouts, close contexts | partial | per-step limits (`recreate/index.js runStep`, `interrupts.js extendableTimeout`); `finally` closes everywhere; `ctx.defer`; `audit/resources.js parallelism`; concurrency 1 (global lock) | configurable concurrency (default 2); a hard job timeout in exact mode (unlimited today, by design); stray-process kill | extend |
| SSRF guard | done | `security/netGuard.js classifyAddress / resolveChecked / precheckUrl / createNetPolicy`; `security/egressProxy.js startEgressProxy` (every Chromium and Lighthouse subrequest, connect-time pinning); `audit/http.js guardedFetch`; `test/netGuard.test.js` | a single `blocked-url` failure code shown to the user | reuse (+ the code) |
| Sandboxed verification container | missing | partial isolation: `build/toolchain.js runToolchain` (child process, minimal env, `--ignore-scripts`) | an ephemeral container with limits | new |
| S3-compatible outputs, signed URLs, expiry | missing | `export/zip.js planZip / writeZip` (streamed zips), `audit/retention.js` | upload + signed URL | extend (zip writer reused) |
| Observability | partial | `[recreate <id>]` log lines, `report.timings`, `report.errors`, clear messages for bot challenge / time limit | structured JSON logs; failure codes | extend |
| `.env.example` | partial | `server/.env.example` (SAS_* settings) | queue / storage / sandbox settings | extend |
| `docs/deployment.md` | missing | none | all of it | new |

### Step 9: Live smoke test

| Sub-item | Status | Where it exists | Missing | Decision |
|---|---|---|---|---|
| Live sites from a config file, off in CI | partial | `test/recreate-corpus.test.js` (registry of saved real-site captures; currently failing because a capture was pruned) | a config of live URLs + an opt-in flag | extend |

### v2 additions (re-checked 2026-10-15 against the code at 8380cf6)

Since the tables above were written: 2138098 (every page recreated), 06e9afa (hover + FAQ merge), 9403670 / 387aab5 / 505d72d
(continuous animations, scroll-linked effects, canvas recordings), 8380cf6 (slow loop seen one way → trace). Rows above whose
status changed: **Continuous loops → done** (`capture/loops.js`, `ir/motion.js scriptLoop / traceLoop`); **Scroll-linked → done**
(`capture/scrolllinked.js captureScrollLinked`, scrub tokens, `--sas-sp` in `emit/motionScript.js`, CSS in all 4 stacks, no
`useScroll` needed); **Canvas / WebGL / Lottie → partial** (`recordCanvasLoop` + `generate.js addCanvasFrames`: still frame + recorded
loop, reported; the video tier below extends it); **Tier 2 → partial** (targeted per decision 1, recorder from the branch);
**Webflow `webflow.js` → covered by the targeted lift**.

#### One-mode design
| Item | Status | Where it exists | Missing for v2 | Decision |
|---|---|---|---|---|
| Mirror capture, ONE recorder | partial | `audit/sharedCache.js createSharedCache` (job-temporary GET bodies); `capture/asis.js recordSheetBodies`; per-view `resources` + `dataFailures` (`capture/index.js`); `capture/exact.js visitSlot` (console + failed requests); branch `mirror-mode-wip` `capture/mirror.js createMirrorStore` (every GET body incl. XHR / fetch, content-addressed, redirects, unreproducible requests) | one persisted recorder for all four call sites; XHR / fetch bodies kept | extend `sharedCache` with the branch's recorder (recorder only, decision 1) |
| Mirror served locally as the reference | partial | today: the saved exact baseline (`capture/exact.js`, offline); branch `mirror/paths.js planMirror`, `mirror/rewrite.js createRewriter`, `mirror/shim.js mirrorShim` | serve the recorded mirror on a loopback port for Phase 4, never as output | extend `verify/server.js` with the branch modules |
| Section splitter | missing (pieces) | landmark choice in `recreate/recover.js`; repeated subtrees in `emit/react/components.js`; role mapping in `ir/tree.js`; bands in `verify/exact/compare.js` | `behavior/sections`: landmarks → top-level blocks → repeated patterns, a section id on IR nodes + capture paths | new, reusing those pieces |
| Section-wise rebuild | done for markup / CSS (exact) | `ir/asis.js applyAsIs` + carried motion tokens | the section id on every node | extend |
| Islands (per section, own-site only) | missing | branch `mirror/rewrite.js`, `mirror/shim.js`, `mirror/csp.js mirrorScriptHashes` (per page) | `behavior/islands`: a section's original markup + its minimal targeted-lift JS as an isolated component in 4 stacks; own-site off → "unresolved" | new, reusing the branch modules |
| "This is my own site" switch | missing | `projects.exact_mode` pattern | `projects.own_site`: marker + `noindex` off, islands allowed | new (small) |
| Report: clean vs approximated vs islands | missing | `report.json`, `RecreateReport.jsx`, `report/render.js` | per page %, a reason per island / video | new (small) |

#### Phase 1 items 17–20
| Item | Status | Where it exists | Missing for v2 | Decision |
|---|---|---|---|---|
| 17 click interactions → `interactionStates.json` | mostly done | `capture/clicks.js captureClicks` (aria-expanded / -controls / -haspopup, hint words, links as controls, `restore` / `closesOwn`), `capture/states.js` (tabs, carousels, FAQ, off state, `splitIndependent`, `planPanels`), `capture/notices.js`, hover panels (`interactions.js`), `capture/feeds.js`; narrow pass `NARROW_CLICK_VIEWS` (8 s; full probe per view in exact) | the file; **390 px** (mobile view is 375 → 390, approved); the full probe on the mobile view in every copy | extend |
| 18 cursors + hit-testing → `pointerMap.json` | partial | computed `cursor` per element (`capture/snapshot.js`; an inline / JS-set cursor survives in the as-is markup); `elementFromPoint` in `clicks.js aimClick` / `interactions.js aim`, not saved; `capture/census.js` visits every interactive element | cursor + `elementFromPoint` at the centre, per interactive element, per view | extend `census.js` |
| 19 content completeness → `contentInventory.json` | partial | lazy attrs (`snapshot.js LAZY_ATTR`), scroll-through, `verify/layout.js loadLazyImages`; every panel state (`states.js`, notices, panels); fetched content in the rendered DOM; XHR bodies not kept | resolve `data-src` / `data-srcset` / lazy backgrounds before the snapshot; XHR bodies via the one recorder; the inventory (text / images / links per page + section, hidden panels marked) | extend + new builder |
| 20 bundle layout | partial | `capture/<slug>/…`, `capture/manifest.json` | an index of the v2 file names (no move) | extend |

#### Phase 2 items 7–9
| Item | Status | Where | Missing | Decision |
|---|---|---|---|---|
| 7 click behaviour | done (no-lift path) | `ir/states.js`, `ir/motion.js openDecls / shutDecls / startsOpen`, `js/motion.js isOpen / setOpen` (same script in 4 stacks) | use a lifted script when one was lifted; in React / Next / MERN init from a client component's `useEffect` with cleanup, re-bind on re-render + route change (+ Next route-change test) | reuse + extend (approved: one shared script) |
| 8 islands | missing | see above | — | new |
| 9 video tier | partial | `capture/loops.js recordCanvasLoop` (animated WebP, ~120 ms frames, 4 s, seamless or forward-back), `generate.js addCanvasFrames` (`cN` tokens, still frame + loop) | only self-running layers not driven by scroll / hover / click / mouse; deterministic recording (`canvas.captureStream` or a stepped clock); 1440 + 390; WebM + MP4 + poster; lazy; size budget; poster under reduced motion; non-canvas layers (Lottie, loops, intros) with text kept as HTML on top; chosen when islands are off or heavier; "approximated" | extend (no new recorder) |
| Tier 2 targeted lift | partial (branch) | branch recorder / rewrite / shim / csp | script-body fingerprint signal in `detection/engine.js matchSignal` + rule files; lift only allowed libraries + the site's small interaction scripts; tracker denylist in `manual-rules.json` | extend |

#### Phase 3 new rules
| Item | Status | Where | Missing | Decision |
|---|---|---|---|---|
| Preserve semantics (tags, every href, type, role, tabindex) | done on the as-is path | `ir/asis.js asisBody`; default path changes them (`ir/tree.js` role → tag, `fixers/perf.js fixBrokenLinks` → `<span>`) | as-is default (decision 3), broken links kept (decision 5), a semantics check | extend |
| Cursor reproduction | partial | as-is CSS + inline styles; computed `cursor` on the rebuilt path | compare with `pointerMap.json`, write a rule where it differs | new small fixer |
| Hit-test guard | missing | — | `elementFromPoint` per interactive element vs `pointerMap.json`; the blocking layer gets `pointer-events: none` or a stacking fix, logged | new (`verify/hitTest.js` + fixer) |
| Content rule | missing | painted-box comparison only | every inventory item present, shown / hidden like the original | new check |

#### Phase 4 checks 5a–5e
| Check | Status | Where | Missing | Decision |
|---|---|---|---|---|
| 5a content | partial | `verify/exact/compare.js compareSlot` (missing / extra painted boxes per slot) | against `contentInventory.json`, hidden panels included | extend |
| 5b cursor | missing | — | computed cursor vs `pointerMap.json` | new (shares 5c's pass) |
| 5c hit-test | missing | — | `elementFromPoint` vs `pointerMap.json` | new |
| 5d click | partial | `reaudit/motion.js compareClicks` (1440, ≤ 6 pages, re-audit only) | 390, every page, against `interactionStates.json`, inside verification | extend |
| 5e every page, both widths, per section, with cause | partial | exact compare on every page at ~20 slots | section attribution, a cause per failure, the hard-failure set | extend |

#### Permanence rules and fixtures
| Item | Status | Where | Missing | Decision |
|---|---|---|---|---|
| Regression suite on every commit | missing | `npm test -w server`; no hook | pre-commit hook (unit tests + HTML/CSS fixtures) + `npm run test:fixtures` (4 stacks) | new |
| Real-site corpus script | partial | `scripts/corpus.mjs` (offline rebuild of saved captures vs baselines), `test/recreate-corpus.test.js` (failing: a capture was pruned) | a live-site config, clone all, summary (checks passed, % islands / approximated, Lighthouse delta), only when started by the user | extend; the failing test is fixed / re-baselined in step 0.5 |
| F8 interactions | partial | `recreate-hover-toggle`, `reaudit-clicks`, `recreate-widgets`, `recreate-exact-probes`, `recreate-states-*` | one page with all eight, incl. a menu rendered only on click by a framework-style script; 4 stacks, both widths | extend |
| F9 pointer + content | missing (pieces) | lazy attrs in fixtures, `recreate-backend-pages` | overlay blocking clicks, inline-JS cursor, lazy bg, hidden-panel content, fetch after scroll | new |
| F10 island | missing | — | own-site on → island, off → unresolved | new |
| F11 video tier | missing (pieces) | `recreate-animation-lab` canvas cell | canvas particles behind heading + button, a looping blob, a scroll-driven animation that must not use the tier | new |

### Duplicates to merge (instead of adding another version)
1. **Three visual comparators:** `verify/visualDiff.js visualDiff` (SSIM, fidelity score), `verify/exact/pixels.js exactDiff`
   (pixelmatch's metric, which is the spec's), `verify/equivalence.js` (`visualSimilarity`, stack equivalence). Step 5
   should build on `exactDiff` and not add a fourth.
2. **Three scroll recipes:** `capture/index.js settle`, `verify/exact/recipe.js settleExact`, `verify/layout.js
   loadLazyImages`. One recipe with options.
3. **Cross-origin CSS read in three places:** `assets/index.js` (downloads unreadable sheets for fonts / keyframes),
   `capture/foreignCss.js harvestForeignStateRules` (hover rules), `capture/asis.js recordSheetBodies` (exact). With the Step 2
   asset map they should all read the one recorded body.
4. **Network recording in four places:** the shared cache, as-is sheet bodies, per-view `resources` / `failedRequests`, and
   exact `visitSlot` console + failed requests. The asset map (Step 2) should be the single recorder.
5. **Screenshots taken in seven modules** (`audit/screenshots.js`, `capture/index.js`, `capture/exact.js`, `capture/sweep.js`,
   `verify/equivalence.js`, `verify/layout.js`, `verify/responsive.js`): fine to keep, but Step 5's reference set should
   reuse `capture/exact.js shootBands` rather than add an eighth.
6. **Colour parsing twice:** `fixers/contrast.js parseColor` and `reaudit/motion.js normalizeColors`. The contrast rewrite in
   Step 6 should use one.
7. **The `pathOf` page function copied in 7 capture modules** (page functions must be self-contained); it could be
   installed once by an init script.
8. **Test setup copied in 25 test files** (insert project + analysis rows, stub steps): one helper before adding the
   fixture runner.

Already shared (good): `checkLinks` (Analyze + the copy's dead-link check), `isBotChallenge` (Analyze + discovery),
`measureMotion` (capture probes reused by the re-audit).

### Existing tests the planned changes would break (expected; updated with the change that causes it)
| Change | Tests affected |
|---|---|
| As-is CSS as the default for every copy (decision 3) | `recreate-generate` (semantic classes, notice pages, fixes), `recreate-fix-all`, `recreate-dom-size`, `recreate-stacks` / `-react` / `-next` / `-mern` (class names, equivalence), `recreate-motion-ir`, `recreate-typography`, `recreate-viewport`, `recreate-fixers` (partly), `reaudit` / `reaudit-compare` (fixed-row counts), `report` |
| Broken links kept (decision 5) | `recreate-fixers` (`fixBrokenLinks`), `recreate-generate` (broken-links items, updated today), `reaudit-compare` (`links.broken` evidence) |
| Contrast lightness-only | `recreate-fix-all` (contrast cases), `recreate-fixers` (`passingColor`) |
| `noindex` + marker by default | `recreate-generate` (head); crawl files (`ir/crawlFiles.js` drops `noindex` pages from the sitemap and must ignore our own); `reaudit-compare` (SEO rows); exact pixel tests (`recreate-exact-asis-emit`, `-views`, `-compare`) unless the marker is masked |
| BullMQ / worker split | `recreate-jobs`, jobs / SSE route tests, `recreate-resume` (checkpoint + auto-resume on restart) |
| Mobile view 375 → 390 (approved) | files that mention 375 (some only as an exact slot width, which stays): `recreate-dom-size`, `recreate-exact-asis-views`, `-exact-capture`, `-exact-compare`, `-exact-correct`, `-exact-slots`, `recreate-fixers`, `recreate-generate`, `recreate-refine`, `recreate-responsive`, `recreate-typography`, `recreate-widgets`; the ones that change are listed in that commit message |
| In-flight merges | the hover + FAQ worktree edits `ir/motion.js`, `emit/motionScript.js`, `emit/motionCss.js`, `capture/states.js`, `capture/interactions.js`, `ir/states.js`, `ir/asis.js`; the animation work touches `ir/motion.js` and `capture/loops.js`, so the worktree must be merged **before** it starts |

### Revised steps (2026-10-14, superseded by the order below)
| # | Step | Was | Now | Size |
|---|---|---|---|---|
| 0 | Land in-flight work | none | commit "every page recreated", merge hover + FAQ, full suite | S |
| 0.5 | Merge the duplicates later steps build on | none | one test helper, one network recorder (asset map), one scroll recipe: prevents a fourth copy | S to M |
| 1 | Fixtures + runner | 7 fixtures + runner | F1 / F3 / F4 / F7 extend existing pages; F2 / F5 / F6 new; the runner composes `runRecreate` + stack export + `compareExact` + `motionItems` | M |
| 2 | Capture additions | 17 items | 6 done or reused (1.4, 1.5, 1.6, 1.10, 1.15, bot detection); new: GSAP hooks, `dynamicClasses`, canvas-rendered type, the `ssr.html` body; the rest are file outputs or extensions of existing probes | M |
| 3 | Style layer everywhere | full step | exact mode already does it in all 4 stacks; left: making it the default (decision 3), global sheet files, unit tests, and updating the tests listed above | M (mostly tests) |
| 4 | Behavior layer | full step | hover, clicks / FAQ, feeds, pointer, sticky, reveals done; left: GSAP replay (new), the Framer appear-config parser feeding the existing reveal path, scroll-linked transforms, the in-flight loop / canvas fixes, tap variants; Tier 2 / 3 per decision 1 | L |
| 5 | Verification + `fidelity-report.html` | full step | the comparator, hover check, motion rows and reports exist; left: the visibility check loop, CSSOM counts, sections + threshold, tier retry, the HTML report | M |
| 6 | Guarded optimization + fixes | full step | all ~20 optimizers exist and are reused; left: the guarded pipeline (generalising `verify/correct.js`), `fixMode`, `intentionalChanges.json`, lightness-only contrast, 5 new fixers, purging with a safelist, deployment configs, `noindex` + marker | L |
| 7 | Safety guardrails | step | mostly done; left: the field-type form rule + a no-op handler | S |
| 8 | Production architecture | step | SSRF done; left: a queue backend behind `JobManager`, the worker + Dockerfile + compose, the sandbox, S3, logs, docs | L (largest) |
| 9 | Live smoke test | step | the corpus test exists; left: a config + an opt-in flag | S |

### Implementation order (v2, approved 2026-10-15)
| # | Step | What is left | Size |
|---|---|---|---|
| 0 | In-flight work | **done** (2138098, 06e9afa, 505d72d, 8380cf6) | — |
| 0.5 | Green suite + merge duplicates | fix / re-baseline `recreate-corpus`; install the toolchains; one test helper; **one network recorder** (sharedCache + the branch's recorder, XHR bodies, persisted) used by the other three; one scroll recipe; `pathOf` via init script | M |
| 1 | Fixtures 1–11 + runner | F1 / F3 / F4 / F7 / F8 extend existing pages; F2 / F5 / F6 / F9 / F10 / F11 new; runner = `runJob(config)` (decision 8) composing `runRecreate` + stack export + `compareExact` + motion / click rows; pre-commit hook + `npm run test:fixtures`; acceptance criteria as failing tests first | L |
| 2 | Capture (Phase 1) | GSAP hooks, `dynamicClasses`, canvas-rendered site type, `ssr.html`, mobile 375 → 390 + full probe there, `interactionStates.json`, `pointerMap.json`, lazy resolution + `contentInventory.json`, issueAudit 390 checks, bundle index | M–L |
| 3 | Style + Phase 3 rules as default | as-is default (normal behind a flag), hrefs kept, cursor fixer, hit-test guard, content rule; the test updates listed above | L |
| 4 | Behaviour | GSAP replay; targeted lift + fingerprints + tracker denylist; `js/motion.js` init from `useEffect` + re-bind on route change; Framer appear-config parser into the reveal path; tap variants; Lottie / WebGL embed; section splitter + islands + own-site switch; **video tier** | L |
| 5 | Verification + `fidelity-report.html` | mirror served as reference; 5a–5e on every page at 1440 + 390 per section with causes; visibility loop; CSSOM counts; tier retry; report with clean / approximated / islands | L |
| 6 | Phase 5 guarded optimization | guarded pipeline, `fixMode`, `intentionalChanges.json`, lightness-only contrast, new fixers, safelist purge, deploy configs, `noindex` + marker | L |
| 7 | Safety guardrails | form field-type rule + no-op handler | S |
| 8 | Phase 6 production | queue behind `JobManager`, worker, Dockerfile, compose, sandbox, S3, logs, docs | L |
| 9 | Live smoke + corpus | live-site config + opt-in flag on `scripts/corpus.mjs` | S–M |

Each L step is split into sub-steps with a WIP commit each; the full 4-stack fixture suite (`npm run test:fixtures`) and the
server suite pass before a step's final commit.
