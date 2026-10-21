# Handoff — copy-my-site

Branch `copy-my-site` (from main 511f36a, PR #2 merged). Not merged. Last pushed commit: see `git log -1`.
Read first: `docs/COPY-MY-SITE.md` (the plan and the rules). This file says what is actually built and what is not.

## What the button does today

"Copy my site" (Copy step) opens one panel: stack (Plain HTML default), new-site address, authorisation.
Confirming saves the stack and address, then starts the **as-is** job for the known pages of the site
(`POST /api/projects/:id/recreate { mode: 'as-is', confirmed: true, stack, pages }`).
The as-is stage (`server/src/recreate/behavior/preserve/stage.js`) does, in order:

1. Lift every page (capture → as-is copy, `liftSite`).
2. **Link pass (live)** — `server/src/copy/linkPass.js` + `copy/linkBrowser.js` (real browser through the egress proxy).
   Every absolute link of the copy's HTML is checked 3 times (2 s apart; one clear success settles it).
   Verdict + action from `copy/links.js`: retarget to the copy's page, redirect (same site only, not to sign-in
   pages), http→https, copy 404; dead external links flagged with a suggestion, never changed; 401/403/429/999/timeouts
   = couldn't verify. Only safe decisions are written into the copy's HTML.
3. Package the chosen stack (`buildStack` / `startStack`).
4. Checks (`checkCopy`, `behavior/preserve/check.js`): offline (console errors, failed requests, outside calls),
   visual (pixel diff vs the original at 1440 and 390; falls back to the capture's baseline when the original does not answer),
   controls and hovers vs the original, forms.
5. Lighthouse on the homepage (desktop).
6. **Per-page checks (live)** — `server/src/copy/checks.js` turns the checks into threshold inputs
   (visual score = 100 − 10 × diff%), judged by `copy/thresholds.js` (`pageProblems`).
   Failing checks → open items → `report.copy.openItems` + `server/data/.../copy-issues.log` (`copy/serverLog.js`).
   `report.copy` = { stack, pages, links, linkDecisions, openItems, counts }.
7. Results UI: `client/src/components/recreate/CopyPages.jsx` (per-page table + link decisions) under the outcome card.
   Summary line: `Outcome.jsx` (same words as `copy/regress.js summaryLine`).
8. Download: `export/notes.js` adds `DEPLOY.md` (always) and `KNOWN-ISSUES.md` (when open items exist) to the zip.

Also in this branch: retention keeps the newest finished copy per stack (`recreate/workspace.js newestPerStack`);
the Copy step has the stage list while a copy runs, and the old options sit under "Advanced options";
"Change settings" no longer offers a stack.

## What is NOT live (be exact)

- **Visual check**: stable since step 1 (see "Step 1" below); the earlier noise was the full-page screenshot resizing the window.
- **Per-page fallback** (auto-repair, clean rebuild of the page, time-boxed correction) is **not** wired. The open
  items say "unresolved" (`reasonFor` marker `unresolved`, not one of the spec's five reasons). `copy/run.js` has the
  decision logic with fakes only (unit-tested).
- **Zero-regressions loop** over the re-audit is **not** live: the as-is job does not run the re-audit, so
  "got worse" is never measured. `copy/run.js` `zeroRegressions` has the logic with fakes only.
- **Safe fixers on the as-is output**: wired since step 3 (see "Step 3" below); images (WebP / variants) are not done yet.
- The **as-is job does not run `copy/run.js`** as an orchestrator; it runs the stage above. `copy/run.js` is
  the tested model of the full pipeline, not yet the live one.
- **Browser runs of the new code**: link pass and checks ran only in the 5 runs below (scratch data, scratch API).

## The 5 runs (scratch data `sas-corpus`, scratch API 4402, homepage only)

| Run | Desktop 1440 | Phone 390 | Controls | Hovers | Console | Open items | Lighthouse perf (before → after) | Links | Duration |
|---|---|---|---|---|---|---|---|---|---|
| makememo, Plain HTML | 96.9 | 96.0 | 1/1 | 19/19 | 0 | none | 85 → 99 | 3 ok | 707 s |
| makememo, React + Vite | 94.3 | 96.3 | 1/1 | 19/19 | 0 | none | — → 98 | 3 ok | 692 s |
| makememo, Next.js | 95.2 | 98.4 | 1/1 | 19/19 | 0 | none | — → 98 | 3 ok | 691 s |
| makememo, MERN | 46.2 (5.4 % px diff, page 3.6 % taller) | not measured (original did not answer) | — | — | 0 | 1 (unresolved) | — → 98 | 3 ok | 541 s |
| nyaayai, Next.js (run 1) | 83.7 | 83.3 | 1/1 | 20/20 | 1 (third-party widget) | 1 (unresolved) | — → 95 | 4: 1 redirect to login (since fixed) | 835 s |
| nyaayai, Next.js (run 2, after fixes) | **0** (14.7 % px diff) | 80.4 | 1/1 | 20/20 | 0 | 1 (unresolved) | — → 95 | 4: LinkedIn 999 (now couldn't verify) | 888 s |

Run 1 had the console error from the original's own third-party chatbot script (`botza.panscience.xyz/widget/chatbot-widget.js`);
the copy is therefore "not safe" by the existing outside-call check. That is reason a (third-party) since the fix.

## Problems found (and fixed)

- Redirect followed to a LinkedIn login wall → now only same-site redirects, and not to sign-in pages.
- Third-party request reported as "unresolved" → now reason a.
- LinkedIn 999 (bot block) counted as broken → now couldn't verify (same as `audit/linkChecker.js`).
- Hover check was dead (key mismatch `hovers` vs `hover`) → fixed before the runs.
- Escaping in `copy/links.js` helpers (regex backslashes lost in shell quoting) → fixed; now written with `String.raw`.
- recreate-jobs test expected no warnings; E.1 warning is intended → test sets the new site's address.
- Real DB: a makememo project with a test address exists in the user's real database. Not ours, not touched.

## Tests

- Copy unit tests: 50 pass (`copy-*.test.js`, copy-retention, copy-notes, copy-log, copy-run, copy-links, copy-link-pass, copy-checks, copy-my-site).
- Related files (preserve-*, recreate-jobs, recreate-export, copy-*): 28 pass at commit `fc4b917`.
  Not re-run after the redirect and 999 fixes (`652dd57`, `5624947`): preserve-* should be re-run.
- Client: `npx vite build` passes. No client test suite exists.

## Next steps, in order (commit and push after each)

1. **Stable visual check.** Freeze animations/timers/carousels on both the original (baseline) and the copy and capture
   at the same moment; when the original does not answer, compare against the saved capture (or the Plain HTML base)
   instead of skipping. Proof: two runs of the same nyaayai copy give nearly the same score.
2. **MERN 3.6 % taller and different from the other stacks.** Find and fix generically; compare with the Plain HTML base.
3. **Safe fixers on the as-is output** (the list in `docs/COPY-MY-SITE.md` §2).
4. **Re-audit + zero-regressions loop**: "got worse" measured; must be 0 or have a reason.
5. **Per-page fallback**: clean rebuild of the failing page in the chosen stack + time-boxed correction; keep the better.

After 1–2: re-run makememo MERN and nyaayai Next.js on scratch data (scratch API only; never port 4000/5173, never the
real data folder). Update this file as you go.

## Step 1 — stable visual check: DONE

`server/src/recreate/behavior/preserve/check.js`:
- **Freeze + warm-up** (63d7023, now `settleFrozen`): `freezeTimers` before load; open, scroll, reload with files cached, scroll,
  fonts settled, `freezePage`; both sides the same way, both pictures taken together.
- **Root cause of the outliers: the full-page screenshot itself.** Chromium grows the window to the page's height for the picture
  and back; the page receives `resize` (measured on nyaayai), and a page whose script answers it (resize listener,
  ResizeObserver, a media-query listener — the window is "portrait" while that tall) re-lays itself out mid-picture. A race:
  nyaayai's original showed other card / logo / footer layouts in the 14.5 % run and part of them in two 1.3 % runs.
  Fix: `holdSizeReactions` (init script, both sides) + `fullShot`: while the picture is taken those reactions are held.
- **Saved-capture fallback** (`baselineVisual`): the copy is pictured the same frozen, warmed-up way; a saved picture at
  `MAX_HEIGHT` (8000 px) is the top of a possibly taller page → `capped: true`, `originalHeight: null` (height not judged),
  only the rows the picture has are compared.
- Plain HTML base fallback (63d7023) unchanged.

Proof (nyaayai Next.js as-is copy 78c73050, live original, scratch data, scratch port 4613; harness kept out of the repo):
| | 1440 diff % | 390 diff % |
|---|---|---|
| Before the hold, 4 runs in one process | 14.53, 0.27, 0.29, 0.27 | 0.17, 0.18, 0.17, 0.17 |
| Before the hold, 4 fresh processes (1440 only) | 1.27, **14.53**, 1.26, 0.34 | — |
| **With the hold, 6 fresh processes** | **0.27–0.31** | **0.17–0.24** |
The 0.3 % left at 1440 is the original's third-party chatbot bar (botza widget, excluded on purpose = reason a), at the same place
every run. Score = 100 − 10 × diff: 96.9–97.3 at 1440, 97.6–98.3 at 390.
Tests: `preserve-baseline-capped.test.js` (new), `preserve-original-midway.test.js` — both pass.

## Step 2 — MERN "3.6 % taller": DONE

Not a MERN defect. makememo's copy has the original's height in **every** stack (8289 px then, 8213 px on 2026-10-21, original
the same). The MERN run was the only one where the original did not answer, so it fell back to the saved capture picture:
1. that picture stops at `MAX_HEIGHT` (8000 px) → "3.6 % taller" (fixed in step 1: `capped`, height not judged);
2. that picture is taken without the scroll-through (`verify/shot.js frozenFullShot` opens the page at the top), so sections that
   appear on scroll are **blank** in it → 4.73 % off an identical copy, every time.

Fix (general, `check.js` + `stage.js`): every live comparison keeps the original's own picture, per width
(`visualCheck(…, { keepOriginal })` → `checkCopy({ onOriginalPicture })` → `as-is/baseline/<slug>@<width>.png`, which travels
with the copy to a repack). When the original does not answer, the check uses, in order: the saved original picture at that
width (`source: 'saved original picture'`, both widths) → the capture picture (desktop only, `'saved capture'`) → the Plain HTML
base → "not compared". `report.baseline.originalPictures` counts pages that have them. The old bare-picture form of `baselines`
still means the capture picture.

Proof (makememo MERN as-is copy 1fe625e9, scratch port 4611):
| Reference | 1440 | 390 |
|---|---|---|
| live original | 0.06–0.08 % | 0.03–0.10 % |
| saved original picture (2 runs) | 0.03, 0.07 % | 0.03, 0.02 % |
| capture picture (old fallback) | 4.73 % (capped, height not judged) | — |
Tests: `preserve-baseline-capped` (+ saved original pictures, 390), `preserve-original-midway`, `preserve-asis`,
`preserve-asis-offline`, `recreate-asis-budget` — all pass.

**Open, outside this step**: the capture's own full-page picture (`verify/shot.js`) has scroll-revealed sections blank. It is
also the clean pipeline's reference picture, so it may cost the clean rebuild's fidelity numbers; not changed here.

## Step 3 — safe fixers on the as-is output: DONE

`server/src/copy/fixAsIs.js` (new), run by `preserve/stage.js fixAndProve` after the link pass and before packaging (so every
stack gets them). The rules are the clean rebuild's own (`fixAlt`, `fixNames`, `fixAria`, `fitTitle` / `fitDescription`,
`detectLang`, `faqPairs`, `crawlFiles`), given the lifted HTML through a thin adapter whose nodes share the parsed element's
attribute object, so a fixer's change is a change to the markup. Only what is missing, empty, duplicated or invalid is touched;
a page that states everything correctly is left byte for byte.
- alt, accessible names, ARIA (frame titles, positive tabindex, invalid values, focusable inside aria-hidden). `fixAria({ asIs })`:
  a **duplicate id is reported (reason d), never renamed** — the original's own CSS / scripts may use it.
- head: missing or duplicated title / description; missing canonical, og:title, og:description, og:url; a canonical / og:url
  naming the original moves to the new site; missing `<html lang>` (from the text, else an open item).
- JSON-LD: Organization + WebSite on the homepage when no page has them; FAQPage where the page shows ≥ 2 questions with answers.
- files: `sitemap.xml`, `llms.txt` (when the copy has none), `robots.txt` **kept** but its `Host:` / `Sitemap:` name the new
  site (the lifted one named the original), `_headers` = security headers **without CSP** (the original's inline scripts run)
  + the copy's caching rules (`AS_IS_HEADERS`). Without the new address nothing names an address and these are left as lifted.
- **Proof per page** (`check.js fixGate`): the fixed page and the same page unfixed (a copy of the folder, both local) are pictured
  the same frozen way at 1440 with their console errors; the unfixed page twice, so its own noise is measured. Kept only when
  difference ≤ max(0.01 %, 2 × noise), same height, no new console error; else the page's lifted HTML is put back and its
  fixes listed as reverted (reason d). A gate error reverts too. (A fixed 0.5 % allowance let a title the page's own script
  prints into the page through — 0.1 % of it; the test covers that case.)
- `as-is/lifted/`: the copy as lifted, before link pass and fixes; a repack starts from it (an older job without it: its `copy/`).
- Report: `report.asIs.fixes` (every fix, the gate per page), `report.copy.fixes` (counts per kind, reverted pages, open, files);
  app: "Fixed in the copy" in `CopyPages.jsx`. The summary line's "Fixed" still comes from the re-audit (step 4).
- Not done: images (WebP / responsive variants only when the pixels stay the same).

Proof on the lifted copies (scratch copies, new address `https://new-site.example`):
| Copy | Fixes kept | Reverted | Fixed vs unfixed | Page's own noise | New console errors |
|---|---|---|---|---|---|
| nyaayai (Next.js) | 49 (45 names, 2 addresses, 2 JSON-LD) | 0 | 0.01 % | 0.01 % | 0 |
| makememo (Next.js) | 3 (1 name, 2 addresses) | 0 | 0.06 % | 0.07 % | 0 |
Tests: `copy-fix-asis.test.js` (new, 3), `preserve-asis`, `preserve-asis-offline`, `recreate-asis-budget`, `recreate-aria` — all pass.
Client: `npx vite build` passes.

## Review before step 4 (2026-10-21)

### 1. The new-site address — guarded
Where it came from (before the guard): `project.target_domain` (saved by the panel, `client/src/layout/steps/CreateStep.jsx:84`;
validated only as "a web address with a dot", `server/src/recreate/inputs.js:92`) → `baseUrlOf` (`inputs.js:108`: the saved
address, **else the original's own origin**) → `ctx.baseUrl` (`recreate/index.js:205`) → `newSiteOf` (`preserve/stage.js`) →
`fixAsIsCopy({ newSiteUrl })`. Findings: an empty address was skipped (no rewrite); **a placeholder was written everywhere**
(the scratch corpus has `https://new.example.com` saved on nyaayai and makememo); a **repack reused the saved address without
asking**; `DEPLOY.md` said "search tags, sitemap and links already use it" and, with no address, called the original's origin
"the new site's address" (`export/notes.js` used `report.baseUrl`). So yes: a shipped copy could name a domain the user does not own.

Guard (`server/src/copy/address.js`): an address is written only when **usable by rule** — http(s), a domain name (no IP, no
single label), not reserved for tests or documentation (.test .example .invalid .localhost .local .internal, home.arpa,
example.com / .net / .org: RFC 2606, 6761, 6762, 8375; whole labels only), not the original — **and confirmed for this run**:
the panel now sends `addressConfirmed` (`CreateStep.jsx`), the route keeps it (`routes/recreate.js`, normalised by
`parseTargetDomain`), the checkpoint keeps it for a resume (`recreate/index.js:199`), and it must equal the saved address.
Otherwise **no** address rewrite at all (canonical, og:url, robots.txt, sitemap.xml, llms.txt, JSON-LD url / logo), one open
item with reason c in `report.copy.openItems` (→ KNOWN-ISSUES.md and the server log) and in `report.asIs.address`, and DEPLOY.md
says no address was set (`export/notes.js`: an as-is copy names only the address its fixes used).
Limits, stated: `nyaayai.test.com` is a real third-party domain (test.com is registered), so no rule can call it a placeholder;
it is stopped only by the confirmation (a saved value alone is never used). A confirmed, real but wrong address cannot be detected.
Tests: `copy-address.test.js` (3, incl. the skip path: nothing in the copy names an address, the open item is there).

### 2. The capture's full-page picture — a measurement artefact in the clean rebuild's scores
- The **new per-width pictures** (step 2, `as-is/baseline/<slug>@<width>.png`) have **no 8000 px cap**: `visualCheck` keeps an
  uncapped full-page PNG (nyaayai 11654 / 15681 px were stored whole). The cap is on the capture's picture (`capture/index.js:311`,
  `verify/shot.js:51`) and on the clean fidelity render (`verify/layout.js:185`) — **both** sides there, so in the clean score the
  cap leaves the bottom of tall pages unmeasured; it does not create a height difference.
- **The artefact is the missing scroll.** Since commit `19ddc59` (2026-10-18 14:28 IST = 08:58 UTC) the capture keeps
  `verify/shot.js frozenFullShot`: a fresh page, 800 ms settle, top of the page, **no scroll**. Sections that appear on scroll
  stay invisible in it. The clean rebuild's fidelity uses that picture as the original (`verify/fidelity.js:105-111`: `visual` is
  40 % of the score, and the whole `diff` score); its copy is rendered with JS off, so its sections are all there.
- Measured on saved artefacts (read-only scratch copies of the corpus, nothing re-run): share of 40-px bands blank in the
  original's picture but not in the copy's —

  | Site, run (UTC) | vs 19ddc59 | blank in original only | visual (per view) | diff (per view) |
  |---|---|---|---|---|
  | dreamhire 865b6bc2 (10-18 08:05) | before | 0–2.4 % | 87–99 | 74–98 |
  | dreamhire d541c77b (10-18 09:47) | after | **38–63 %** | 74–91 | 62–82 |
  | parchaa f0ca3e94 (10-18 07:43) | before | 0–0.5 % | 91–100 | 78–97 |
  | parchaa 5543a393 (10-18 09:09) | after | **23–77 %** (blog posts 0–19 %) | 80–100 | 59–98 |
  | flexibench dcecafc4 / fe1df206 (10-18 12:10 / 14:13) | after | **0–44 %** (home 30 / 44 %) | 76–99 | 60–98 |
  | framer 1837ff5b / b443e730 (10-13 / 10-14) | before | 17–24 % (one-screen page; hero not in yet at 800 ms) | 82–91 | 68–82 |

  Same site, same day, same kind of copy: dreamhire's picture after the change is blank below the first screen (checked by eye on
  the about page: the figures, "the principles", "a short history", the team, the closing banner are all missing), and its
  scores fall by 10–20 points with nothing else changed.
- **Conclusion: low visual / diff scores of clean rebuilds captured after 19ddc59 are, to a large part, measurement artefacts,
  not fidelity problems.** Exception: framer's homepage score 40 / 36 — its picture part is 82–91; the low score is the box-layout
  part (sizes, boxes), a real difference, not this artefact.
- The exact numbers quoted for this review (flexibench ~43, framer ~40, parchaa ~41–52, dreamhire ~57–58) are **not** in the
  scratch corpus (its runs score 85–92 overall, diff 70–85; framer 50 / 39). They may come from another store or another score;
  the mechanism applies to any score computed against `capture/<slug>/<view>-full.webp` taken after 19ddc59.
- Fixed afterwards: see "Fixed before step 4" below.

### 3. Stability proof coverage — nyaayai, and partly makememo
- The outlier and its cause were reproduced and fixed on **one site (nyaayai)**. "Before" in fresh processes was measured at
  **1440 only** (1.27, 14.53, 1.26, 0.34 %). At 390, "before" exists only from one process (0.17, 0.18, 0.17, 0.17 %; no outlier
  seen; an earlier session saw 0.70 % once). After the fix, nyaayai in 6 fresh processes: 1440 0.27–0.31 %, 390 0.17–0.24 %.
- makememo was measured **after** the fix only (live 1440 0.06–0.08 %, 390 0.03–0.10 %, 3 checks), never before it.
- **Unproven**: that the fix removes outliers on other sites; that 390 had the same race (never observed there); phone layouts
  that answer resizes differently; widths other than 1440 and 390.

### 4. Fixer accept / revert (step-3 proof runs)

| Copy | Attempted | Kept | Reverted | What was attempted |
|---|---|---|---|---|
| nyaayai | 49 | 49 | 0 | 33 unlabelled form fields (3 forms × 11: website, company, message, subject, …), 12 icon links (6 known services, 3 other hosts, 3 to the homepage), canonical + og:url moved, Organization + WebSite JSON-LD |
| makememo | 3 | 3 | 0 | 1 email field named from its placeholder, canonical + og:url moved |

Nothing was reverted (gate: nyaayai 0.01 % vs noise 0.01 %, makememo 0.06 % vs noise 0.07 %). makememo's 3 is **few applicable
fixes**, not reverts: its 2 images have alt, its 24 links and 2 buttons have names, title, description and lang are set, it has 3
JSON-LD blocks; only one form field had no label. nyaayai has three forms of unlabelled fields, icon-only social links and no JSON-LD.
Both runs used `https://new-site.example` as a stand-in address, which the new guard refuses.

### 5. Security headers on an as-is copy
No `<meta http-equiv>` is written anywhere (`copy/fixAsIs.js`, `preserve/*`: none). The mechanism is a host file:
`copy/fixAsIs.js:287` writes `_headers` (`AS_IS_HEADERS`, `fixAsIs.js:38`: HSTS, nosniff, Referrer-Policy, X-Frame-Options,
Permissions-Policy, no CSP, then the cache rules) into the copy folder. Per stack:
- **Plain HTML**: the folder is the site → `_headers` at its root; applied by Netlify and Cloudflare Pages, a plain ignored file elsewhere.
- **React + Vite**: copy → `public/` (`pack.js:155`) → `dist/_headers` after `vite build`; applied on Netlify / Cloudflare Pages.
  `pack.js:156` also writes a cache-only `_headers` at the project root, which is not deployed (pre-existing).
- **Next.js**: copy → `public/` (`pack.js:216`); `next.config.mjs` `headers()` sets cache headers only. `public/_headers` is served
  as a file and **not applied** by `next start` or Vercel: the security headers do not take effect for this stack.
- **MERN**: copy → `client/dist/` (`pack.js:244`); the Express server sets its own headers (`emit/mern/template/server/src/app.js:95-104`:
  CSP from `liftedCsp` = `script-src 'self'` plus hashes of the copy's inline scripts, nosniff, Referrer-Policy, XFO, COOP,
  Permissions-Policy; this pre-dates step 3). `client/dist/_headers` is served as a file and ignored.
- No `vercel.json` / `netlify.toml` is written for as-is copies. Gaps: no stack gets HSTS on Vercel; Next.js gets none of the security headers.

### Bug recorded, not fixed: DEPLOY.md names scripts the as-is package does not have
`DEPLOY.md` comes from `server/src/copy/deploy.js` `STACK_FACTS` (one text per stack, written for the **clean** emitters); the as-is
`package.json` from `server/src/recreate/behavior/preserve/pack.js`. Confirmed:
- React + Vite: DEPLOY.md says `npm run dev` (`deploy.js:12`); the as-is scripts are `build` and `preview` only.
- Next.js: DEPLOY.md says `npm run dev` and "they are in out/" (`deploy.js:17-18`); the as-is scripts are `build` and `start`
  (`pack.js:172`), there is no `output: 'export'`, so no `out/` is ever produced; "Netlify: publish folder out" is wrong too.
- MERN: DEPLOY.md says `npm run install:all` (`deploy.js:22`); the as-is script is `start` only (`pack.js:233`). The as-is MERN
  package has **no `client/package.json`**: `client/` holds only `dist/` (the lifted copy, served as files) and every dependency
  (express, compression, mongodb) is in the root `package.json`. For the as-is MERN copy, `npm install` + `npm start` is the
  complete and correct command; for the **clean** MERN copy `install:all` is right (client and server each have a package).
Correct generic fix: DEPLOY.md is written from the package that actually ships — `STACK_FACTS` per (stack, mode), or better the
run commands derived from the generated `package.json` scripts and folders — plus a test that every `npm run <x>` and every folder
DEPLOY.md names exists in the package it ships with. Not an `install:all` alias: in a clean MERN layout it must install both
packages, and an alias that succeeds while doing the wrong thing is worse than one that fails.

## Fixed before step 4: the capture's reference picture had no scroll (regression from 19ddc59)

**Why the scroll went away.** `19ddc59` (2026-10-18) moved the capture's full-page picture to a fresh page with frozen timers,
on purpose: rotators, carousels and tickers changed between the original's picture and the copy's, so the score measured the
moment (nyaayai, dreamhire, indikaai, parchaa scored low at phone widths). The old picture came from the capture's own page,
which had been scrolled through; the fresh page never was, and nothing in that commit (or in `7f0a189`, which shortened its
load wait for flexibench) scrolls it. The freeze was deliberate; losing the scroll was a side effect no test covered (the frozen
test only looked at a rotator in the first screen).

**Fix (general, `verify/shot.js frozenFullShot`):** the fresh frozen page is now scrolled through with the capture's own
`settle` (real wheel steps, the reveal tracker, back to the top, revealed content pinned — also sections that hide again
when they leave the view), what the scroll loaded gets a bounded wait (`MEDIA_WAIT_MS` 3 s, bounded in Node), and the page's
reactions to the window's size are held while the picture is taken (`holdSizeReactions`, moved to `verify/exact/freeze.js`
and shared with the as-is check). Its time limit grows by `SCROLL_LIMIT_MS` 60 s; if it still cannot finish, the existing
fallback is the capture page's own screenshot, which is scrolled and pinned. The other side of the clean score (the copy,
rendered with its scripts off by `verify/layout.js`) has nothing that waits for a scroll, so both sides now show every section.
Found on the way, same cause class: the freeze suppresses the page's timers of ≥ 1 s, and our own page code used them — the
reveal tracker's 3 s wait for an image that never loads never ended (88 s, then the outer limit). The freeze now keeps the
original timer as `window.__sasTimeout` (not enumerable) and the tracker uses it; the page's own timers stay frozen.

**Regression test** (`recreate-visual-frozen.test.js`, +1): a page whose four sections appear only on scroll (one of them hides
again when it leaves the view) plus a rotator: the frozen picture has < 10 % background-only bands below the first screen,
every section's colour is in it, and the rotator stayed frozen. On the code before the fix it fails with "below the first screen
100 % of the picture is blank". The other three frozen-picture tests pass (the load-never-comes page finishes in ~10 s).
Related tests: recreate-reveal, recreate-capture, recreate-exact-capture, -compare, -recipe, recreate-feed-reveals,
preserve-baseline-capped, copy-fix-asis — 53 / 53 pass.

**Size of the effect** — dreamhire `d541c77b` (captured after 19ddc59), re-scored with the same functions as `verify/fidelity.js`
(`visualSimilarity`, `visualDiff`, `viewScore` with the run's own sizes / boxes); the copy's pictures are the saved ones (read-only
scratch copies), only the original's picture was taken again with the fixed code from the live site. Control: the new reference
against the capture of the same site from before 19ddc59 (`865b6bc2`): diff 94–99, so the site had not changed.

| Page | View | blank (old → new ref) | visual | diff | score |
|---|---|---|---|---|---|
| / | phone | 54.7 → 0.5 % | 82 → 87 | 70 → 76 | 84 → 86 |
| / | computer | 61.0 → 2.4 % | 78 → 91 | 67 → 77 | 79 → 84 |
| /employers | phone | 56.3 → 0.5 % | 74 → 87 | 62 → 74 | 83 → 89 |
| /employers | computer | 55.8 → 0 % | 77 → 99 | 67 → 97 | 83 → 92 |
| /candidates | phone | 46.2 → 0 % | 78 → 98 | 67 → 94 | 91 → 99 |
| /candidates | computer | 47.4 → 0 % | 87 → 99 | 77 → 98 | 95 → 100 |
| /pricing | phone | 55.6 → 0 % | 81 → 99 | 72 → 96 | 92 → 99 |
| /pricing | computer | 38.7 → 0 % | 91 → 100 | 82 → 96 | 76 → 79 |
| /about | phone | 26.5 → 0 % | 79 → 99 | 69 → 98 | 91 → 100 |
| /about | computer | 32.4 → 0 % | 82 → 100 | 74 → 99 | 93 → 100 |
| **mean** | | | **80.7 → 95.8** | **70.7 → 90.5** | **86.7 → 92.8** |

What remains low after the fix is real (homepage 86 / 84: its picture part is 87 / 91; /pricing computer 79: the layout part).
Captures saved between 19ddc59 and this fix keep their blank pictures: a project's clean scores from that window are only
comparable after a new capture (or a re-score of the reference like the one above).

## Next steps, in order (commit and push after each)

1. Zero-regressions loop: the re-audit runs on the as-is copy; every "got worse" item is measured and must be 0 or have a reason
   (§5); the summary line's "Fixed" comes from it.
2. Per-page fallback: clean rebuild of a failing page in the chosen stack, time-boxed correction, keep the better one.
3. Images on the as-is output (WebP / variants) only where the pixels stay the same, through the same gate.
4. Recorded, waiting for a decision: DEPLOY.md per (stack, mode) from the shipped package (see the bug above); security headers that
   take effect on Next.js / Vercel. (The capture's reference picture is fixed, see above.)
Then: full runs of makememo MERN and nyaayai Next.js on scratch data (scratch API only; never port 4000/5173, never the real data folder).

## PARKED (2026-10-21) — copy-my-site paused for the `accounts` work

Everything below is committed and pushed on `copy-my-site` (the last commit is a WIP). Nothing is half-written in a working tree.
The side worktree `../Website-Audit-copyfix` (branch `copy-my-site-checks`, same commits, already fast-forwarded into
`copy-my-site`) can be removed; its `node_modules` and `server/toolchains/*/node_modules` are **junctions** into
`Website-Audit-exact`: remove them with `rmdir` first, never with a recursive delete, or the real packages go with them.

Working rules that still apply: scratch data only (`C:/Users/urvas/AppData/Local/Temp/sas-corpus/data`, a copy of the real
projects made 2026-10-18 ~12:55 IST, since diverged); scratch ports only; never the real data folder (`server/.env`
`SAS_DATA_DIR` → `Site-Audit-Studio-main\…`). **The user's dev server (4000) and client (5173) run from this worktree
(`Website-Audit-exact`)**: an edit to `server/src` here restarts it once idle — do code work in a separate worktree.
Run only the test files of what you touch; no full suite.

Open, in the order to pick them up:

1. **Revert-path tests (WIP, one failing).** `server/test/copy-fix-gate.test.js`: 3 of 4 pass — a fix the page's own CSS turns
   into a layout change is undone (reason d); a change below the fold inside a section that only appears on scroll is undone
   (a picture without the scroll sees no difference); a small visible fix on a page with measured random noise is kept. The 4th
   ("the floor in both directions") fails: its 2 × 2 px dot gave `diffPct` 0 (the dot is not in the picture — check the
   absolutely placed `<i>` on a `height:900px; overflow:hidden` body; give it `display:block` or put it in flow). The rule under
   test: kept when diff ≤ max(`FIX_GATE_FLOOR_PCT` 0.01 %, 2 × noise), same height, no new console error; noise = the unfixed
   page pictured twice at 1440 the same frozen, scrolled way (`check.js fixGate`).
2. **Next.js security headers — fixed, verify in a real run.** Commit `bf01313`: one header list (`copy/securityHeaders.js`);
   the Next.js package sends them from `next.config.mjs headers()` (proven: `copy-served.test.js` builds and starts a real
   package, all five headers sent). `copy/served.js` measures what the packaged copy's own server sends after packaging; headers
   count as applied only for stacks with their own server (Next.js, MERN); Plain HTML / React + Vite `_headers` is an open item
   with reason e, never a fix. MERN sends no HSTS (open, reason e). Still to do: one real as-is run per stack to see the
   measurement in a report; the CopyPages line was built but not looked at in the browser.
3. **DEPLOY.md names scripts the as-is package does not have (recorded, not fixed).** Details and the correct generic fix are in
   "Review before step 4 → Bug recorded, not fixed" above: write DEPLOY.md from the package that ships (scripts and folders
   of the generated `package.json`), plus a test that every `npm run x` and folder it names exists. The as-is MERN package has no
   `client/package.json` (`npm install` + `npm start` is right for it); do **not** add an `install:all` alias.
4. **Step-1 proof re-check.** The step-1 numbers used the live original on both sides, never the capture picture, so the 19ddc59
   bug did not touch them. Still unproven: other sites than nyaayai; the race at 390 (never observed there); and the check's
   own scroll stops at 14 000 px (`check.js openAndScroll`), so on nyaayai at 390 (15 681 px) the last 1 681 px are never
   scrolled into view on either side. Fix by scrolling to the page height with the capture's `scrollThrough`, then re-measure
   nyaayai and makememo at 1440 and 390 in fresh processes (harness pattern: see "Step 1" above).
5. **Step 4 — re-audit + zero-regressions loop (not started).** The as-is job must run the re-audit on the copy; every
   "got worse" item is measured and must be 0 or carry one of the five reasons; the summary line's "Fixed" comes from it (today
   it is still the clean pipeline's comparison). `copy/run.js zeroRegressions` holds the decision logic, tested with fakes only.
   It depends on 1–2 (an honest "Fixed" count) and on the capture fix 10a665a (a reference picture that is not blank).
6. **Step 5 — per-page fallback (not started).** A page below threshold: auto-repair known stack issues, else a clean rebuild of
   that page in the chosen stack with a time-boxed exact correction, keep the better. `copy/run.js` has the decision logic with
   fakes only.

Also known: clean-rebuild captures taken between 19ddc59 (2026-10-18 08:58 UTC) and 10a665a have blank reference pictures; in the
scratch corpus that is dreamhire d541c77b, parchaa 5543a393, flexibench dcecafc4 / fe1df206 (partly) and makememo 1fe625e9 (as-is
fallback). The real database very likely has such runs too (the dev server ran this code in that window) — not checked: the
real data folder was not read. `scratchpad/window.mjs` of the 2026-10-21 session lists them read-only, given a data folder.
