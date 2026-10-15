# Task (v2, final): One-mode website cloner: as-is fidelity + clean code in the chosen stack + original problems fixed + better Lighthouse, production-ready

> **Status note for Claude Code:** Step 0 (audit) is already done; see `docs/fidelity-audit.md`, including section 6 (decisions) and section 7 (plan vs existing code). The decisions are now final and recorded in the "Decisions" section below. Start from the "Implementation order" section. Reuse what section 7 marks as done or extendable; never build a second version of something that exists.

## Context
This repo is a tool that takes a website URL, analyzes the site (it can be built with any tech stack or site builder), and generates an as-is copy in one of four user-selected stacks: **MERN, HTML/CSS, React + Vite, Next.js**.

**Current problems:** the generated clones lose parts of the original CSS and JS. This happens especially with heavy animations, hover effects, transitions, scroll-triggered effects, and JS-driven motion. On Framer sites, entire sections end up invisible. Testing also shows: **some content is missing, the hand (pointer) cursor doesn't appear on clickable elements, and dropdown menus don't open on click.** I need a permanent, architectural fix, not per-site patches. The tool will also be deployed to a server, so it must be production-ready, not just work locally.

**Goal, in one mode (no separate "exact" and "rebuild" modes):** the downloaded site, in whichever stack the user picks, looks and behaves like the original, is clean and correct code, has the original's fixable problems solved (small look changes are acceptable for that), and scores better on Lighthouse than the original.

**What "permanent" means here:** no tool can promise that no site will ever break. Permanent means (a) every known class of problem is fixed generically, (b) the tool detects every remaining failure automatically and reports it with its cause, and (c) every new failure pattern found later gets a generic fix plus a fixture, so it can never come back (see "Permanence rules").

## Step 0: Understand the existing code first
Before changing anything:
1. Read the codebase and explain the current pipeline end to end: how the site is fetched, how HTML/CSS/JS is extracted, where (if anywhere) an LLM rewrites code, how each stack generator emits output, and how the app is currently run/deployed.
2. Find the exact places where styles and behavior are lost. Check for these known causes:
   - Styles extracted via `getComputedStyle` or rendered HTML (loses `:hover`, `:focus`, `@keyframes`, `transition`, and media queries for other breakpoints)
   - Cross-origin stylesheets throwing `SecurityError` on `cssRules` and being silently skipped
   - CSS-in-JS (styled-components, emotion) injected via `insertRule`, where `<style>` textContent is empty
   - Shadow DOM and `adoptedStyleSheets` not collected
   - JS animation libraries (GSAP, Framer Motion, Lenis, Locomotive, AOS, Swiper, Lottie, Three.js) being dropped, or frozen as one frame of inline `transform`
   - Capture happening before scroll, so IntersectionObserver/lazy-load states never appear
   - CSS passing through an LLM and getting truncated or "simplified"
   - Class names changed, hashed (CSS Modules), or purged (Tailwind) so the original selectors no longer match
   - Original scripts running on `DOMContentLoaded` before React components mount
   - Broken relative `url()` paths for fonts and images inside CSS files
   - JS-driven hover effects (no `:hover` rule exists in the CSS at all)
   - Framer appear animations: elements shipped with inline `opacity: 0` / `transform` that stay invisible when the Framer runtime doesn't run
3. **Audit the existing SEO and performance optimization feature.** The tool already improves the clone's SEO and performance compared to the original site. Document every optimization it currently applies (e.g. CSS purging/minification, JS minification/deferral, image optimization and lazy-loading, font optimization, critical CSS, meta tags, structured data, semantic HTML changes) and where it runs in the pipeline. Also document how the tool currently detects and fixes the original site's problems (accessibility, broken assets, console errors, Lighthouse audit failures, etc.). Both features must be kept and must work together with the fidelity work below (see Phase 5).
4. Also note anything that would break in deployment: Playwright running inside API request handlers or serverless functions, no job queue, no timeouts, no SSRF protection, generated code running on the main server.
5. Write the findings to `docs/fidelity-audit.md` and show me a plan **before** implementing.

## Core architectural principle
**Preserve, don't regenerate.** Split the pipeline into three layers:

| Layer | Responsibility | LLM allowed? |
|---|---|---|
| Style layer | Copy original CSS rules verbatim, only rewriting `url()` paths to local assets | **No.** Fully deterministic |
| Behavior layer | Detect animation libraries/builders, capture or record their behavior and replay it, or lift original scripts as-is | Only for mapping captured data into idiomatic code |
| Structure layer | Convert the DOM into components for the target stack, **keeping original class names, ids and data-attributes exactly** | Yes |

CSS must never be sent through an LLM. If class names and the CSS file stay identical, hover, focus, keyframes and transitions keep working automatically.

## Design: one mode, "Rebuild with the mirror as reference"
1. **Mirror capture.** Record every response of the original (HTML, CSS, JS, fonts, images, XHR/fetch) with ONE network recorder (extend `createMirrorStore` / `sharedCache`; there are four recorders today, merge them). Serve the mirror locally as the stable reference "original" for all verification. **The mirror is never the output.**
2. **Section-wise rebuild.** Split each page into sections/components (landmarks, top-level blocks, repeated patterns). Rebuild each in the chosen stack as clean code: original markup semantics, original class names, original CSS verbatim, and behaviour generated from the recorded states (hover, clicks, animations, Framer appear config).
3. **Section-wise verification** against the mirror (Phase 4).
4. **Per-section fallback ("island").** Only if a section still fails after the retry tiers: embed that section's original markup + the minimal original JS it needs as an isolated island component in the chosen stack. Never fall back for a whole page. Islands are allowed only when the "This is my own site" switch is on; otherwise keep the best rebuild and report the section as unresolved.
5. **Fixes + optimization** on top (Phase 5), re-verified against the mirror after every step.
6. **Report:** % clean code vs approximated (video tier) vs islands per page (with the reason per island), fidelity check results, fixed issues, and the Lighthouse before/after table.

## Decisions (final)
1. **Script lift = targeted.** Lift only scripts fingerprinted as animation/UI/interaction libraries (GSAP, ScrollTrigger, Swiper, Lottie, webflow.js, Bootstrap JS, jQuery plugins, Alpine.js, etc.) and the site's own small interaction scripts when they're the only source of a recorded interaction. Never lift app/framework bundles, trackers, or auth scripts. Take only the recorder from the `mirror-mode-wip` branch, not mirror mode's output path.
2. **Trackers:** name denylist first (extend `detection/manual-rules.json`, no new list), then the measured-role rule for anything not on the list.
3. **As-is is the base for every copy.** Exact mode becomes `fixMode: fidelity`. Normal mode (CSS regenerated from computed styles) leaves the default path and stays behind a flag.
4. **Footer marker + `noindex` on by default.** One "This is my own site" switch turns both off (and allows islands). Mask the marker region in pixel tests.
5. **Broken links** keep their `href` and are reported. Never unlink.
6. **Lighthouse** on the homepage by default, configurable to top N pages. The cheap checks (axe, console errors, broken assets, mobile overflow, and all Phase 4 checks) run on every page.
7. **Language:** stay in JavaScript, add new folders without restructuring existing ones, `// @ts-check` + JSDoc in new modules. (This overrides "TypeScript" in Constraints.)
8. **Production architecture (Phase 6) last.** The tool is not public yet. Build everything as a pure `runJob(config) → outputs` function with no Express dependency, so moving it into a worker is easy. Phase 6 must be complete before the tool goes public.
9. **In-flight work:** commit "every page recreated" after the full suite passes, merge the hover + FAQ fix once its tests pass, fold the animation work into the behaviour step, do the speed work after Phase 6.

## Phase 1: Capture engine (Playwright, Chromium)
Build or replace the capture module so that it:

1. **Records every network response** of type stylesheet, script, font, image, and media into an asset map (URL → body, content-type). Cross-origin CSS text comes from here when the CSSOM blocks access.
2. **Injects an init script before page load** (`page.addInitScript`) that:
   - Hooks `window.gsap` via a property setter and wraps `to`, `from`, `fromTo`, `set`, and `timeline` (including chained timeline calls) to log `{lib, method, targetSelector, vars, position}` into `window.__animLog`
   - Hooks ScrollTrigger registrations and their config
   - Stores serializable configs only, and converts DOM targets into stable selectors (prefer id, then a unique class path)
3. **Captures the initial SSR HTML separately** (the raw HTML response of the document, before any JS runs). It's needed for Framer and other hydrated sites, where the pre-hydration markup and inline initial styles are the source of truth for appear animations.
4. **Loads the page** with `waitUntil: 'networkidle'`, plus an extra settle delay.
5. **Auto-scrolls slowly** to the bottom in steps (about 300px every 150ms), then back to the top, so lazy-loaded content and scroll animations trigger.
6. **Collects the full CSSOM**: `document.styleSheets`, `document.adoptedStyleSheets`, and every shadow root's sheets. Serialize each rule's `cssText`, keeping `@media`, `@supports`, `@keyframes`, `@font-face`, `@layer`, `@container`, and pseudo-class rules. Keep original sheet order, because cascade order matters. For cross-origin sheets, fall back to the network asset text.
7. **Collects running animations** with `document.getAnimations()`: type (CSSAnimation, CSSTransition, Animation), name, target selector, `getKeyframes()`, and `getTiming()`.
8. **Detects libraries and builders** and outputs a `libs` report:
   - gsap, ScrollTrigger, Lenis, Locomotive (`[data-scroll-container]`), AOS (`[data-aos]`), Swiper (`.swiper`), Lottie (`window.lottie`, `lottie-player`, `dotlottie-player`), canvas/WebGL
   - Webflow (`[data-wf-page]`, `data-w-id`, webflow.js IX2)
   - Framer (`[data-framer-name]`, `[data-framer-component-type]`, `[data-framer-appear-id]`, scripts loaded from `framerusercontent.com`)
   - Also detect bundled GSAP or other libraries by fingerprinting script contents, since modern sites often don't expose globals
9. **Site-type detector.** Classify the site before generation and include the result in the report:
   - `standard` (normal DOM-based site)
   - `framer`, `webflow`, `wix` (builder-specific handling or warnings)
   - `canvas-rendered`: Flutter Web (e.g. `flt-glass-pane`, `flutter-view`, or `flt-*` elements), or a page where one or more canvases cover most of the viewport and the DOM has very little text content. For this type, **stop and return a clear warning** that the structure can't be cloned; offer only a static screenshot-based preview.
   - `bot-protected`: the captured page is a challenge/interstitial page (Cloudflare etc.). Stop and report it instead of generating a clone of the challenge page. Do not attempt to bypass bot protection or CAPTCHAs.
10. **Records JS-driven hover via state diffing** (generic, works for Framer and any other JS hover):
    - For each interactive element (`a`, `button`, `[role=button]`, elements with cursor `pointer`, and Framer elements with hover variants), record the computed styles of the element and its descendants (limit depth and property set: color, background, border, box-shadow, opacity, transform, filter, scale, width/height where relevant)
    - Call `page.hover()`, wait for transitions/animations to finish (poll `getAnimations()` until none are running, with a timeout), and record the styles again
    - Move the mouse away and confirm it returns to the base state
    - Store the diff, plus transition duration/easing taken from `getAnimations()`, in `hoverStates.json`
    - Skip elements whose hover diff is fully explained by existing `:hover` CSS rules
11. **Captures the final DOM after interaction**, but strips inline `style` values that were set mid-animation by JS (e.g. transient `transform`/`opacity`) when the element is a known animation target, so that the replayed animation controls them.
12. **Captures reference screenshots** at 1440px and 390px: full page, at 3–4 scroll positions, and the hover state of each interactive element.
13. **Records dynamic classes and attributes**: run a `MutationObserver` (installed via the init script) for the whole capture session, including the scroll pass and hover diffing. Record every class name and `data-*`/`aria-*` attribute value that JS adds to elements at runtime. Save them in `dynamicClasses.json`; Phase 5 uses this as the CSS purge safelist.
14. **Records element visibility**: for every element with text or images, store whether it's visible (computed opacity > 0, visibility not hidden, has size, inside the document) in the final, settled original page. This feeds the visibility check in Phase 4.
15. **Records a performance and SEO baseline of the original**: run Lighthouse (performance, SEO, accessibility, best practices) on the original URL at mobile and desktop settings, and save the scores and key metrics (LCP, CLS, TBT, total JS/CSS bytes) in `baseline.json`.
16. **Records an issue audit of the original** in `issueAudit.json`, so every problem the clone fixes can be traced back to the original:
    - Every failed or warning Lighthouse audit (with its audit id and affected elements)
    - Accessibility violations from `axe-core` (contrast, missing labels, alt text, landmarks, heading order, duplicate ids, etc.)
    - Console errors and warnings, failed network requests (404/5xx assets), and mixed content
    - Broken internal and external links on the page (check status codes through the SSRF guard, with a timeout and a cap on the number of links)
    - Mobile layout problems at 390px: horizontal overflow, elements wider than the viewport, text smaller than 12px, tap targets smaller than 24px
    - Invalid or problematic HTML (e.g. duplicate ids, nested interactive elements, missing doctype)
    - Missing SEO basics (title, meta description, canonical, Open Graph, `lang`, heading structure, structured data)
17. **Records click interactions** (extend `captureInteractions`; no second recorder): on every page, at 1440px and 390px, find toggles generically (buttons, `[aria-expanded]`, `[aria-haspopup]`, `[aria-controls]`, menu/hamburger icons, elements whose click changes other elements). Click each one and record the diff (classes, attributes such as `aria-expanded`/`hidden`/`open`, styles, and any newly inserted markup), then close it (click again, Escape, outside click) and record that too. Also record hover-opened menus. Save in `interactionStates.json`. Covers dropdowns, mobile menus, modals, accordions, tabs, carousels.
18. **Records cursors and hit-testing:** for every element, the computed `cursor` (including cursors set inline by JS). For every interactive element, the result of `document.elementFromPoint` at its centre (which element receives the click). Save in `pointerMap.json`.
19. **Content completeness before capture:** resolve lazy images (`data-src`, `data-srcset`, `loading=lazy`, lazy background images), open every tab/accordion/carousel state once so every panel's content is captured, and record XHR/fetch content through the network recorder. Then write `contentInventory.json`: every visible text string, image, and link per page and section, including content in hidden panels (marked as such).
20. Writes everything into a capture bundle: `capture/{ssr.html, dom.html, styles/*.css, assets/*, animLog.json, animations.json, hoverStates.json, interactionStates.json, pointerMap.json, contentInventory.json, dynamicClasses.json, visibility.json, libs.json, siteType.json, baseline.json, issueAudit.json, screenshots/*}`.

All navigation and subrequests in this phase must go through the SSRF guard described in Phase 6.

## Phase 2: Behavior strategy (fallback chain)
For each site, pick a strategy per animation source. Log which one was used:

1. **Tier 1, replay:** the library was exposed and hooked. Generate replay code from `animLog.json` using the real npm package (e.g. `gsap`, `gsap/ScrollTrigger`).
2. **Tier 2, script lift (targeted, per decision 1):** the JS is bundled or unknown. Copy only the allowed original scripts as-is and execute them **after** the DOM/components mount. Then dispatch a synthetic `DOMContentLoaded` and a `load` event, because many scripts wait for them. This works because class names are preserved.
3. **Tier 3, embed:** canvas/WebGL, Lottie, video. Copy the assets (Lottie JSON, models, textures) and the original initialization script. Do not try to convert them.
4. **Recorded hover:** for every entry in `hoverStates.json`, generate hover behavior: plain `:hover` CSS rules (with the recorded transition) for HTML/CSS output, and the same CSS rules (preferred) or `whileHover` from `motion` for the React-based stacks.
5. **Webflow:** keep `webflow.js`, all `data-w-*` attributes, and the `data-wf-page`/`data-wf-site` attributes on `<html>`.
6. **Framer:** use the dedicated Framer adapter in Phase 2A.
7. **Click interactions:** for every entry in `interactionStates.json`, use the lifted library/script if one was lifted (decision 1). Otherwise generate a small toggle from the recorded diff: open, close, Escape, outside click, correct `aria-expanded` updates, and any markup that only appeared on click. Same behaviour in all 4 stacks (plain JS for HTML/CSS, a component with state for React-based stacks).
8. **Islands** (see Design, step 4): the last resort per section, never per page.
9. **Video tier** (after islands, before "unresolved"): only for self-running animations (canvas/WebGL backgrounds, Lottie, loops, one-time intros) that are **not** driven by scroll, hover, click, or mouse. Used when islands aren't allowed ("own site" off) or when the video is lighter than the island. Record only the animated layer; text, buttons and links stay real HTML on top. Deterministic recording (`canvas.captureStream` or a stepped animation clock), never real-time screen recording. 1440 and 390 recorded separately, seamless loops, WebM + MP4 with a poster, lazy-loaded, within a size budget, never GIF; under `prefers-reduced-motion` only the poster. Reported as "approximated". Extend the existing `recordCanvasLoop` / `addCanvasFrames`; no new recorder.

Exclude analytics, tracking, auth, and third-party chat widget scripts from lifting (maintain a denylist: GA, GTM, Hotjar, Segment, Intercom, reCAPTCHA, Framer's own analytics/events endpoints, etc.).

## Phase 2A: Framer adapter
Framer sites are server-rendered React apps hydrated by the Framer runtime. Their entrance animations are driven by the runtime, and their hover/tap variants are JS-driven, not CSS. Handle them as follows:

1. **Keep the SSR markup and Framer CSS.** Use the SSR HTML (`ssr.html`) and Framer's injected styles as the structural and style base. Preserve all `framer-*` class names and `data-framer-*` attributes exactly. Keep Framer's breakpoint variant CSS (the media-query rules that show/hide per-breakpoint variants) intact.
2. **Convert appear animations:**
   - Find the appear animation config Framer embeds in the page (typically an inline script/JSON keyed by `data-framer-appear-id`). Inspect real Framer pages to confirm the current format. Don't hardcode an assumed format, and make the parser tolerant of version changes.
   - Map each config (initial state, target state, transition: duration, delay, easing/spring params) to the `motion` npm package (`motion`/`framer-motion`): `initial`/`animate`, or `whileInView` when the original is triggered on scroll into view.
   - **Safe fallback:** if an element's config can't be found or parsed, remove its inline initial `opacity: 0` and `transform` so the content is always visible (static, without animation). A missing animation is acceptable; invisible content is not.
3. **Hover/tap variants:** use the recorded hover states (Phase 1, step 10) and convert them to CSS `:hover` rules or `whileHover`. For tap/press, optionally record `:active`-style diffs the same way using mouse down/up.
4. **Scroll-linked effects** (parallax, scroll-progress transforms): detect elements whose transform changes with scroll position, by sampling computed transforms at several scroll positions. Map simple linear relationships to `motion`'s `useScroll` + `useTransform`. Report anything more complex as unresolved.
5. **Runtime lift (HTML/CSS output only, optional):** offer a config flag to load the original Framer runtime from its CDN instead of converting. This gives the highest fidelity, but the clone depends on the original site's CDN. **Never lift the Framer runtime into the React, Next.js or MERN outputs**, because it's its own React tree and will conflict with the app's React tree.
6. **Fonts and assets:** download and self-host fonts and images from `framerusercontent.com`, rewriting paths in CSS and markup.
7. **Not supported, report clearly:** Framer CMS (only the captured content is copied), Framer forms (replaced with local stub handlers), localization switching, page transitions, and code components with custom logic.

## Phase 3: Stack emitters
All four emitters share the same captured style and behavior layers. Rules:

- **Global rules for every stack**
  - Emit the original CSS as plain global stylesheet(s), in original cascade order
  - Never use CSS Modules. If Tailwind is in the template, don't let it purge the original classes (or don't use it at all for cloned markup)
  - Preserve class names, ids, and `data-*`/`aria-*` attributes exactly (`class` → `className` in JSX)
  - Rewrite all asset and `url()` paths to local files, and self-host fonts
  - **Preserve semantics:** keep original tags (`a`, `button`, `input`, `select`, `label`, etc.), every `href` (including broken ones), `type`, `role`, `tabindex`. Never turn a link or button into a `div`, and never emit `<a>` without `href` if the original had one.
  - **Cursors:** reproduce the recorded computed `cursor` wherever the clone's differs (needed when the original set it from JS).
  - **Hit-test guard:** after building, no element may cover an interactive element unless it covered it in the original (per `pointerMap.json`). Fix leftover overlays, frozen animation layers, and wrappers generically (`pointer-events: none` on the blocking layer or correct stacking) and log each fix.
  - **Content:** every item in `contentInventory.json` must be present, shown/hidden the same way as the original.
- **HTML/CSS:** `index.html` + `styles/` + lifted scripts with `defer` in original order. For Framer, use the converted appear animations via `motion`'s vanilla JS API, or the optional runtime lift.
- **React + Vite:** import the global CSS in `main.jsx`. Add one `<SiteAnimations />` component that runs Tier 1 replay inside `useLayoutEffect` using `gsap.context()`, with `ctx.revert()` cleanup so React StrictMode double-mount doesn't duplicate animations. Inject Tier 2 scripts in `useEffect` by appending `<script>` elements in order, awaiting each `onload`, then dispatching the synthetic events. For Framer sites, emit the converted animations as `motion` components (`motion.div` etc.) on the matching elements.
- **Next.js (App Router):** put the CSS in `app/globals.css`, imported in `app/layout`. Animation, `motion`, and script-lift components get `'use client'`. Import window-dependent libraries dynamically inside effects to avoid SSR crashes. Avoid hydration mismatches: don't render random or time-based values on the server, and make sure `motion` initial states match the server-rendered markup.
- **MERN:** same frontend as React + Vite, plus a minimal Express + MongoDB backend. Forms in the clone post to local stub endpoints only.

## Phase 4: Automatic fidelity verification
After generating a clone, the tool must check itself:

1. Run the generated project inside the per-job sandbox (Phase 6) and open it in Playwright.
2. Repeat the same screenshot set as the capture: widths, scroll positions, hover states. Diff each pair with `pixelmatch` and record a percentage per section. Take original and clone screenshots in the same environment (same container image and fonts), so font differences don't cause false failures.
3. Compare `document.getAnimations()` count and names between the original and the clone. Also compare the count of `:hover`/`:focus` rules and `@keyframes` names in the CSSOM.
4. **Visibility check:** after the clone fully settles (scrolled through, animations finished), every element that was visible in the original (`visibility.json`) must be visible in the clone. Any element stuck at `opacity: 0`, `visibility: hidden`, zero size, or off-screen transform is a hard failure. Auto-fix it with the safe fallback (remove the initial hidden styles), then re-check.
5. **Hover check:** replay the hover state diffing on the clone and compare it against `hoverStates.json`.
5a. **Content check:** every item in `contentInventory.json` exists in the clone (hidden panels included). Missing items are listed per page/section.
5b. **Cursor check:** the computed cursor matches the original for every interactive element.
5c. **Hit-test check:** `elementFromPoint` at the centre of every interactive element returns that element or a descendant, as in the original.
5d. **Click check:** replay every recorded interaction on the clone (open and close, both widths) and compare against `interactionStates.json`.
5e. All checks run on **every page** and both widths, section by section against the mirror. Every failure lists the element, the check, and the likely cause (e.g. overlay, missing href, tag changed, script not lifted, hidden panel not captured, lazy image not resolved). Content, cursor, hit-test, click, and visibility failures are hard failures.6. If a section exceeds the diff threshold (default 3%, configurable) or animations are missing, automatically retry that section with the next fallback tier. Allow at most 2 retries.
7. Output `fidelity-report.json` and a readable `fidelity-report.html` with: the detected site type, side-by-side screenshots, the diff %, the strategy tier used per animation source, visibility, hover, content, cursor, hit-test and click check results, % clean code vs approximated vs islands, and anything still unresolved.

## Phase 5: SEO and performance optimization, guarded by fidelity
The tool's existing feature of making the clone better than the original on SEO and performance must be kept, but it must never break visual or interactive fidelity. Run optimization **after** Phase 4 passes, in this order:

1. **Optimization pipeline with per-step guard.** Apply optimizations one at a time. After each step, re-run the Phase 4 checks (visual diff, animation comparison, visibility check, hover check). If a step pushes any check past its threshold, revert that step for the affected files and record it in the report. Don't revert all optimizations because one failed.
2. **Safe by default** (apply always):
   - Remove analytics, tracking, and chat-widget scripts that were not lifted
   - Self-host and subset fonts, add `font-display: swap`, and preload the fonts used above the fold
   - Compress and convert images to modern formats (WebP/AVIF) **with the same intrinsic dimensions**, and add explicit `width`/`height` to prevent CLS
   - Minify CSS and JS **without renaming** class names, ids, keyframe names, or CSS custom properties
   - Meta tags, Open Graph, `<link rel="canonical">`, `robots.txt`, `sitemap.xml`, JSON-LD structured data where the content supports it, `lang` on `<html>`, and missing `alt` text (from the context, never invented claims)
3. **Guarded** (apply, then verify; revert on failure):
   - **Unused CSS removal:** use the captured `dynamicClasses.json` plus every selector touched by `hoverStates.json`, `animLog.json`, and `animations.json` as a safelist. Never remove `@keyframes`, `@font-face`, `:hover`/`:focus`/`:active` rules for elements that exist, or Framer breakpoint variant rules.
   - **Image lazy-loading:** only below the fold, and only for images that aren't ScrollTrigger/scroll-animation targets or inside pinned sections. Always reserve the image's space so page height doesn't change.
   - **Script loading:** `defer` is allowed, but keep the relative execution order of lifted scripts. Never `async` a lifted script that another lifted script depends on.
   - **Critical CSS:** inline only if the cascade order of the remaining stylesheets stays identical.
   - **Semantic HTML fixes** (e.g. a `div` that acts as a heading becomes `h2`): only when no CSS rule targets the old or new tag selector in a way that changes the element's computed style. Verify by comparing computed styles before and after.
   - **Next.js `<Image>` and `next/font`:** use them only if the original class names stay on the rendered element and the computed layout is unchanged. Otherwise use a plain `<img>` with optimized sources.
4. **Fix the original site's problems** (from `issueAudit.json`). Classify every issue into one of three groups and handle it accordingly:
   - **Invisible fixes, always applied** (no change to the look): missing `alt` and aria labels, `lang`, missing or duplicate meta tags, duplicate ids, nested interactive elements, broken/404 assets (re-download, replace with the working source, or remove the reference if nothing exists), mixed content, console errors caused by removed or broken scripts, render-blocking resources, missing doctype, heading-structure problems that can be fixed without a visual change. Broken links: keep the link but report it, and never invent a new destination.
   - **Visible fixes, controlled by config** `fixMode`. **Small changes to the look are acceptable when they resolve the original's problems**, so the default is `fix-all`:
     - `fix-all` (**default**): apply every visible fix needed to resolve the issues in `issueAudit.json`, using the smallest change that works for each one. Allowed: adjusting text/background color lightness to pass WCAG AA contrast (**keep the same hue and saturation**, so brand colors stay recognizable), increasing padding or size to reach the tap-target size, raising font sizes to readable minimums on mobile, removing horizontal overflow at mobile widths (e.g. `max-width: 100%`, wrapping, or scaling down an oversized element), adding visible focus styles, and fixing layout shift by reserving space. Not allowed, even in this mode: redesigning layouts, reordering or removing content, replacing fonts or imagery, changing the color scheme, or altering animations beyond what an issue requires.
     - `balanced`: only fixes whose change is very small (e.g. contrast fixes within a small lightness shift, tap-target padding); everything else is reported.
     - `fidelity`: no visible fixes at all, report only.
     - Every visible fix is written to `intentionalChanges.json` (element selector, property, before value, after value, issue id). If one issue can be solved several ways, pick the one with the smallest visual difference.
   - **Not fixable in the clone, report only:** server-side issues (TTFB, the original backend), problems inside lifted third-party scripts, and anything depending on the original server. For HTTP-level issues the clone can address, emit a deployment config with caching, compression, and security headers next to the generated project (e.g. `vercel.json`, `netlify.toml`, an nginx snippet, or Next.js `headers()`), and mark them as "fixed on deploy".
   - **Verifier integration:** the Phase 4 checks must treat entries in `intentionalChanges.json` as expected differences, not failures, and must still fail on any other difference. A visible fix that breaks something else (layout shift, broken animation, invisible element) is reverted like any other guarded step.
   - **No new problems:** after fixes, re-run the issue audit on the clone. The clone must not introduce any issue that the original didn't have.
   - **Report:** add an issue-by-issue table to the fidelity report: original issue → status (`fixed`, `fixed-on-deploy`, `partially-fixed`, `reported-only`, `not-fixable`) → what was changed and why.
5. **Heavy lifted JS:** when Tier 2 script lift is used, report its bundle size and its impact on TBT, and list which animation sources would need Tier 1/converted code to remove that bundle. Don't silently drop a lifted script for performance.
6. **Measure the result:** run Lighthouse on the final clone with the same settings as `baseline.json`. Add a before/after table (original vs clone: scores, LCP, CLS, TBT, JS/CSS bytes) to the fidelity report, plus the list of optimizations that were applied, guarded, or reverted, and why.
7. **The clone preview marker and `robots`:** by default, add `<meta name="robots" content="noindex">` to the clone, because a public clone of someone else's content competes with the original as duplicate content. Make it a config flag that the user can turn off for sites they own, together with the footer marker.

## Phase 6: Production architecture and deployment
The tool will run on a server, so build it to be production-ready:

- **Architecture:** split into an API service and a separate worker service. The API enqueues clone jobs (BullMQ + Redis) and immediately returns a `jobId`. The frontend tracks progress (per phase) via polling or SSE. Never run Playwright inside the API request cycle or in serverless functions. The frontend may be deployed separately (e.g. Vercel); the worker must not be.
- **Worker container:** a Dockerfile based on the official Playwright image (`mcr.microsoft.com/playwright`), with a version that exactly matches the `playwright` npm dependency. Install common fonts (Noto, emoji) so screenshots are consistent. Document the required run flag `--shm-size=1gb` (or `--ipc=host`). Add a `docker-compose.yml` for local development (frontend, api, worker, redis).
- **Concurrency and limits:** configurable worker concurrency (default 2). A hard timeout per job and per phase. Always close browser contexts in `finally` blocks, and kill stray Chromium and dev-server processes on job end or failure.
- **SSRF protection:** resolve the hostname and reject private, loopback, link-local, and cloud-metadata addresses (IPv4 and IPv6) before navigation, after every redirect, and for every subrequest via `page.route`. Re-check the resolved IP at connection time to prevent DNS rebinding. Allow only `http`/`https`. Add tests for this.
- **Sandboxed verification:** run the generated project's install/build/dev server for Phase 4 in an isolated, ephemeral container per job, with CPU, memory, and time limits, no access to app secrets or the internal network, and dynamic port allocation. Destroy the container when the job finishes. Lifted third-party scripts must only ever execute inside this sandbox or the capture browser, never on the host.
- **Outputs:** upload the generated project zip and the fidelity report to S3-compatible object storage (configurable, works with Cloudflare R2), with signed download URLs and automatic expiry. Clean up local temp directories after each job.
- **Observability:** structured logs per `jobId`, phase timings, and a clear failure reason surfaced to the user (e.g. `bot-protected`, `canvas-rendered`, `timeout`, `blocked-url`).
- **Config:** all limits, thresholds, and storage settings via environment variables, documented in `.env.example`.
- Write `docs/deployment.md` explaining how to deploy the worker on a VPS with Docker, and the minimum recommended server size.

## Permanence rules (how this stays fixed)
- **Generic only:** no site-specific code anywhere: no hostname checks, no selectors or class names taken from a particular site, no special cases. A real site is only a test case to find which generic mechanism failed.
- **Every new bug = generic fix + fixture.** When a new failure is found on any site, first diagnose which generic mechanism failed, then fix that mechanism, then add a fixture page (written from scratch) that reproduces the pattern. The fix is done when the fixture passes in all 4 stacks.
- **The checker is the safety net.** Phase 4 runs on every clone, so failures on new sites show up in the report with their cause instead of being discovered manually.
- **Regression suite:** all fixtures run in all 4 stacks on every commit. A failing fixture blocks the commit. Tests may only be updated for an intended behaviour change listed in the commit message; any other failing test is a regression and must be fixed.
- **Real-site corpus:** keep a config list of real test sites (mine and clients'). A script clones them all and produces a summary (checks passed, % islands, Lighthouse delta) so quality can be tracked over time. It doesn't run in CI by default.
- **Duplicates:** merge duplicates before adding to them (section 7 of the audit lists them: pixel comparators, scroll recipes, cross-origin CSS reads, network recorders, colour parsers, `pathOf`, test setup). Never add another copy.

## Safety guardrails (required)
- Disable or strip the `action` of any form that contains password, card, CVV, OTP, or SSN-type fields. Replace it with a local no-op handler.
- Don't carry over the original site's auth, payment, analytics, or tracking scripts.
- Add a small, visible "Clone preview — not the original site" marker to the generated site's footer, with a config flag the user can turn off for sites they own.

## Constraints
- JavaScript with `// @ts-check` + JSDoc in new modules (decision 7).
- Keep the code modular: `api/`, `worker/`, `capture/`, `detect/`, `behavior/`, `behavior/framer/`, `behavior/interactions/`, `behavior/islands/`, `emitters/{html,react-vite,next,mern}/`, `verify/`, `optimize/`, `optimize/fixes/`, `sandbox/`, `security/` (SSRF guard).
- Don't break the existing API or UI contract. If a change is required, list it in the plan first.
- Add unit tests for: the CSSOM serializer, the url() rewriter, library detection, site-type detection, hover state diffing, the Framer appear-config parser, the CSS purge safelist builder, issue classification (invisible/visible/not-fixable), the minimal contrast-fix calculator (lightness only, hue and saturation unchanged), toggle detection and diffing, the hit-test guard, lazy-image resolution, the section splitter, and the SSRF guard.
- Integration test fixtures (local pages included in the repo, served by a local test server):
  1. Pure CSS hover/keyframes
  2. GSAP + ScrollTrigger
  3. Cross-origin stylesheet + styled-components
  4. JS-driven hover (hover implemented only with JS event listeners, no `:hover` CSS)
  5. A saved snapshot of a Framer-style page: SSR markup with `data-framer-appear-id` elements starting at `opacity: 0`, plus an embedded appear config. Build it from a real Framer page's structure, and keep the fixture in the repo so tests don't depend on live sites.
  6. A canvas-rendered page, to verify the detector stops and warns
  7. A page with known problems: low-contrast text, missing alt text, a broken image, duplicate ids, a console error, horizontal overflow at 390px, and missing meta tags
  8. Interactions: a click dropdown, a hover dropdown, a mobile hamburger menu, a modal, tabs, an accordion, a carousel, and a menu whose markup is only rendered on click (by a small framework-style script)
  9. Pointer + content: an overlay/wrapper that would block clicks after a naive rebuild, links whose cursor comes only from inline JS, lazy images (`data-src` + `srcset` + lazy background), content that exists only in hidden tab/accordion/carousel panels, and content loaded by fetch after scroll
  10. Island case: a section driven by an opaque custom script that can't be rebuilt, to verify the per-section island fallback (with the "own site" switch on) and the "unresolved" report (with it off)
  11. Video tier: a canvas particle background behind a heading + button, a looping blob animation, and a scroll-driven animation that must **not** use the video tier
- Also add an optional live smoke test against 2–3 real sites (including Framer sites) that I'll provide via a config file. It must not run in CI by default.
- The full integration suite must run inside the worker Docker image, so local and server behavior match.

## Acceptance criteria
- On the fixture pages, every `:hover` and `@keyframes` rule from the original exists in the clone's CSS, for all 4 stacks.
- GSAP fixture animations run in the clone (verified via the animation log or getAnimations / visual diff at timed frames).
- Cross-origin and CSS-in-JS styles are present in the clone.
- JS-driven hover effects are reproduced in the clone (hover check passes).
- On the Framer fixture, in all 4 stacks: zero elements stay invisible in the clone, appear animations run via `motion`, and hover variants are reproduced.
- The canvas-rendered fixture produces a clear warning instead of a broken clone.
- The visual diff is under the threshold for all fixture sections at both widths.
- `fidelity-report.html` is generated for every clone.
- On fixtures 8 and 9, in all 4 stacks: every dropdown/menu/modal/tab/accordion/carousel opens and closes like the original, the cursor matches on every interactive element, no element blocks a click it didn't block in the original, and every content item (including hidden panels, lazy images, fetched content) is present.
- On fixture 10: the failing section becomes an island when the "own site" switch is on, and is reported as unresolved when it's off. The rest of the page is clean code in both cases.
- On every fixture, the report shows the % clean code vs approximated (video tier) vs islands, and fixtures 1–9 contain no islands.
- On fixture 11: the canvas background and the blob loop use the video tier (heading and button stay real HTML on top, WebM + MP4 + poster, poster only under reduced motion), and the scroll-driven animation does not.
- On every fixture, after Phase 5 optimization, all fidelity checks still pass, and the clone's Lighthouse performance and SEO scores are equal to or better than the original's baseline. Any reverted optimization is listed with its reason.
- CSS purging never removes a class from `dynamicClasses.json` or a hover/animation selector (covered by a test on the JS-driven hover and GSAP fixtures).
- On the known-problems fixture: in the default `fix-all` mode, every invisible and visible issue is fixed, each visible change is minimal and listed in `intentionalChanges.json`, contrast fixes keep the original hue, the broken link is reported (not changed), and all other fidelity checks pass. In `fidelity` mode, no visible change is made and those issues are reported only.
- Every issue in the original's `issueAudit.json` appears in the report with a status, and the clone's issue audit contains no issue the original didn't have.
- `docker compose up` starts the full stack locally. A clone job submitted through the API completes end to end, and the result is downloadable from object storage (a local S3-compatible service such as MinIO is fine for development).
- SSRF tests pass: URLs pointing to localhost, private ranges, and metadata IPs, including via redirects, are rejected with `blocked-url`.
- Running 5 jobs at once with concurrency 2 queues correctly, without crashes or leftover processes.

## Implementation order
Follow the revised order from section 7 of `docs/fidelity-audit.md`, updated with this v2 spec:
0. Land the in-flight work (decision 9). 0.5. Merge the duplicates the plan touches.
1. Fixtures 1–11 + the fidelity runner (acceptance criteria exist as failing tests first).
2. Capture additions (Phase 1, including items 17–19).
3. Style layer + semantics/cursor/hit-test/content rules as the default (Phase 3).
4. Behaviour: GSAP replay, recorded hover, click interactions, Framer adapter, canvas/Lottie/WebGL embedded and reported (never a blank canvas), section splitter + islands, video tier.
5. Phase 4 verification with all checks + `fidelity-report.html`.
6. Phase 5: guarded optimization, `fixMode` (default `fix-all`), `intentionalChanges.json`, the new fixers, lightness-only contrast.
7. Safety guardrails. 8. Phase 6 production architecture. 9. Live smoke test + real-site corpus script.

Update `docs/fidelity-audit.md` for this v2 spec first (what changes in sections 6 and 7), show me the updated plan, then implement step by step.

## Working style
- Show me the updated plan first, then implement step by step.
- After each phase, run the tests and the fixture clones, and tell me what passed and what didn't.
- Don't silently skip anything that fails. If something can't be preserved (e.g. a server-dependent feature or a Framer CMS collection), list it in the report.