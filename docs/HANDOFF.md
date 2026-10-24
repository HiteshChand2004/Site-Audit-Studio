# Handoff — copy-my-site

> **Working rule (the user's): every fix must be generic.** No site-specific patches, and no code that checks for a site name,
> an address, a framework name (like Framer) or a specific page. A fix must work for any site that has the same problem. Real
> sites only find problems and verify fixes; a site may be named in a comment or a test's story, never in a condition.

Branch `step4-lighthouse` (worktree `../Website-Audit-step4b`, from `accounts` c7fa9a4 <- `copy-my-site` <- main 511f36a, PR #2 merged).
Not merged and **nothing pushed** (there is no `origin/step4-lighthouse`). `copy-step4` is superseded: its one commit past the common
base, cfaab64, is babf36c here (same patch id), so merging only `step4-lighthouse` into `accounts` is a fast-forward of 7 commits and
loses nothing except the untracked scratch scripts, which are kept at `C:/Users/urvas/Downloads/remastly-live-results/scripts/`.
Read first: `docs/COPY-MY-SITE.md` (the plan and the rules). This file says what is actually built and what is not.

## Launch readiness (added 2026-10-24)

> **Rule (the user's): all work is done with deployment of the whole website + tool in mind.** Every item below is open until
> it says DONE; each names where it stands today.

| # | Item | Status | Note |
|---|---|---|---|
| L1 | Production refuses to start with accounts off | IN PROGRESS (branch `owner-options`) | Being added there; nothing on this branch. Until merged, a production start with accounts off serves every site to everyone. |
| L2 | Database: heartbeat per running job + lock file | OPEN (next steps item 7) | A second process on one data folder marks running jobs failed and adopts their workspaces. **Until done: deploy only with plain stop-then-start, never a zero-downtime reload** (PM2 reload, rolling update on a shared volume). Today the app is one `npm start` process, so nothing shipped reloads. |
| L3 | Preview in a sandboxed iframe with no same-origin access | **DONE, proven (2026-10-24)** | Previews are paths of the app's own address, `/preview/<token>/…` (`recreate/previewRoute.js`, `previewTokens.js`), every document sent with `Content-Security-Policy: sandbox allow-scripts` and framed with `sandbox="allow-scripts"` (plain copies `""`), never `allow-same-origin`; `/api` refuses `Origin: null` / `Sec-Fetch-Site: cross-site` (`security/foreignOrigin.js`). `test/preview-sandbox.test.js` shows the risk first (a copy on a path of the app's address framed as before read the signed-in user's account and projects from the API and the app's storage) and then that the same copy through the preview cannot (origin `null`, no cookie sent, API 403 / unreadable, cookies and storage throw, no service worker), while its own stylesheet, script and data still load. Since the same day the preview also runs the copy's script fully: addresses written in pages, stylesheets and module specifiers are moved under `/preview/<token>/` on the way out, and the addresses the script builds at run time by a shim served first in every document that may run script (`recreate/previewShim.js`: fetch, XHR, URL, element attributes, markup strings, the CSSOM, an import map for `import()`; the page sees its own address through `history.replaceState`; private in-memory stand-ins answer for storage and cookies, which the browser otherwise throws on). The shim reports counts (moved / failed / errors / blank) to the app with the token, and the Compare step says in plain words when a page could not run fully and that the downloaded copy is not affected. Proven on two as-is copies of client-rendered sites (one a bundler build, one a builder export): blank / half-drawn without the shim, complete with it. Remaining limit: a full navigation the script makes itself to a root address leaves the preview; a worker gets no shim. The downloaded copy is never touched (the rewriting happens on the way out). See docs/ACCOUNTS.md "Previews when hosted". |
| L4 | Job queue + concurrency limits per server and per user | OPEN | Today: one global lock per process (one Analyze / Recreate / Re-audit at a time), no per-user limit, no queue across processes; `SAS_MAX_PARALLEL` caps browser contexts. Two jobs at once crashed a 15 GB machine. Size the limits from measured memory per job (peak RSS of server + browsers per job kind and page count), not from guesses. |
| L5 | Upper time limit per job and per page | OPEN | The motion timer now grows with page length (`motionTimeFor`: at most ~4.6 min per page, 6 pages), the completion pass has `PASS_MAX_MS` 45 s per page and size, but an exact / manual run has **no job limit** (`Infinity` by design) and the capture of one very long page has none either; the as-is warm-up scroll is bounded (`preserve/scroll.js SCROLL_MAX_MS` 30 s, 54e6aaa). Needed: a hard ceiling per page and per job in production, with what was not measured reported, so one page cannot hold a server for hours. |
| L6 | Outbound fetching from a datacenter IP | OPEN | Sites may block or stall it (bot protection, geo rules). Known from this machine: the chatbot host `botza.panscience.xyz` stalled ~21 s / `ERR_EMPTY_RESPONSE` on 2026-10-23 (the blank-render trigger); indikaai and makememo had to be "checked that they answer first" (2026-10-24 morning). Keep a list: site, host, what failed, why, date — from the live runs and from production logs. |
| L7 | Disk: storage per copy + cleanup policy | OPEN | An as-is copy keeps every original file (nyaayai homepage 4.6 MB referenced; an exact copy was 83 MB of `dist/`); retention today: latest 2 recreates keep their IR, latest 3 analyses keep screens, `pruneRecreates`; scratch folders (`sas-work`, Temp scratchpads) grow without limit. Needed: a per-copy size figure in the report, a quota per user / per site, and a scheduled cleanup of old copies, re-audits and scratch. |
| L8 | Production config: HTTPS, Secure cookies, secrets in server `.env` only, database backups | OPEN | HTTPS is the reverse proxy's; the session cookie must be `Secure` + `HttpOnly` + `SameSite` behind it; no secret in the client bundle or the repo; SQLite backups (a copy of `app.db` + `projects/` on a schedule, restore tested once). |
| L9 | Email: Gmail SMTP daily limit | OPEN | OTP mail goes through Gmail SMTP (OTP stage 5). Gmail caps sending (about 500 a day on a free account, 2 000 on Workspace) and throttles bursts; move to a provider (transactional mail API) before the first marketing push or when daily sign-ups approach a tenth of the cap. |
| L10 | A deploy guide for the tool itself | OPEN | DEPLOY.md today covers only the downloaded copies (`src/copy/deploy.js`). Needed for the tool: process manager (stop-then-start, see L2), env vars (`SAS_*`, `PORT`, `APP_ORIGIN`, accounts + mail settings), the data folder and its disk, ports (API, previews 5100–5199 or the production preview path), the reverse proxy (HTTPS, WebSocket / SSE pass-through, body limits), Playwright's browser install, keep-awake / sleep settings. |
| L11 | Final proof: one copy on a real static host, PageSpeed original vs copy | OPEN (recorded under "Next steps") | Temporary, `noindex`, deleted afterwards; phone and computer; the measurement host (`reaudit/measuredHost.js`) stands in for it until then. |
| L12 | Full test suite once before the PR | OPEN | Run once, when nothing else runs on the machine (the suite's browser tests fail under load), after the last code change and before the PR. Every step until then runs related files only, one at a time. |

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
- **Zero-regressions loop**: since step 4 the re-audit is queued after every as-is copy, and every "got worse" / "still open" row
  carries a reason or is marked UNEXPLAINED (see "Step 4"). Still **not** live: anything that *acts* on an unexplained row (a fix,
  a retry, the per-page fallback). `copy/run.js` `zeroRegressions` has that decision logic with fakes only.
- **Safe fixers on the as-is output**: wired since step 3 (see "Step 3" below); images (WebP / variants) are not done yet.
- The **as-is job does not run `copy/run.js`** as an orchestrator; it runs the stage above. `copy/run.js` is
  the tested model of the full pipeline, not yet the live one.
- **Browser runs of the new code**: link pass and checks ran in the 5 runs below and in the step 1-4 proof runs (scratch data, scratch API).

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
- 2026-10-24 (0fa8fc0), one at a time with `SAS_TEST_BROWSER_CONCURRENCY=1`: `preserve-completion-late` (new, 2),
  `preserve-completion-same-origin` (2), `preserve-url-base` (2) pass. The full suite was not run.
- 2026-10-24 (ca2c630), the same way: `reaudit-measured-host` (new, 3), `reaudit-lighthouse-pages` 5, `reaudit-asis` 1,
  `reaudit` 6, `perf` 10 pass (perf's "render and screenshots side by side" test fails under `SAS_MAX_PARALLEL=1` alone, as
  that cap is meant to). The full suite was not run.
- 2026-10-24 (31c5cf6), the same way with `SAS_MAX_PARALLEL=1`: `reaudit-motion` 12 (+1 new), `recreate-loops` 3 pass. The full
  suite was not run.
- 2026-10-24 (54e6aaa), the same way: `preserve-scroll` 4 (new), `copy-visual-check` 2, `preserve-complete` 1,
  `preserve-completion-late` 2 pass. The full suite was not run.
- Client: `npx vite build` passes. No client test suite exists.

## The plan of 2026-10-20 (kept as written: steps 1-3 DONE, 4 IN PROGRESS, 5 not started; the live list is under "Next steps" below)

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

**Re-check with the new ruler (2026-10-24, 54e6aaa; `remastly-live-results/nyaayai/stability-2026-10-24/STABILITY-2026-10-24.md`)**
— the figures above came from the old ruler; these are the real `visualCheck` (3 pictures a side, noise map, `exactDiff` at
0.05), five fresh processes, `SAS_MAX_PARALLEL=1`, one browser at a time:
| | 1440 diff % (raw) | 390 diff % (raw) |
|---|---|---|
| **5 fresh processes** | **0.2621–0.2771** (0.26–0.34) | **0.1909 in every run** (0.21–0.24) |
No outlier in 10 runs; the same to the fourth decimal as the copy's own check that morning (0.2621 / 0.1909); the 0.26 % at
1440 is still the excluded chat bar. Score 97.2–97.4 at 1440, 98.1 at 390.
- **The 14 000 px scroll stop was a limit, fixed generally** (`preserve/scroll.js scrollThrough`): the warm-up before every picture
  and the completion pass both scrolled to a fixed 14 000 px; at 390 this page is 15 681 px tall, so its last 1 681 px were never
  scrolled to. Now it scrolls to the page's own bottom, follows a page that grows while scrolled, and stops at a **time cap**
  (`SCROLL_MAX_MS` 30 s ≈ 100 000 px; `capped` → `visualCheck.scrollCapped` and the completion pass's log). On this page the stop
  hid nothing (probe: 209 elements and 3 images below 14 000 px, all loaded and visible after the old scroll too — the numbers
  above are unchanged by the fix); the fixture test shows the general case (a part revealed at 17 000 px, missed before).
- **The 390 race, tried on purpose, did not reproduce** (12 attempts: 3 rounds × 2 sides × 2 widths, picture taken without the
  hold, the page's listeners counted): the trigger is real at both widths — one unheld picture delivers 2–7 `resize` and 1–2
  media-query `change` events to the page — but every handler ran with the window already restored (innerHeight 844 / 900), the
  DOM shape did not change and the unheld picture differed from the held one by ≤ 0.073 % (inside the noise). When the handler runs
  relative to the capture is the browser's timing (on 2026-10-23 at 1440 it was once mid-picture: 14.53 %). The deterministic proof
  is `test/preserve-scroll.test.js`: a page whose resize / media-query / ResizeObserver handlers re-lay it out is re-laid out by
  the picture without the hold; held, no handler runs, two pictures are identical and their top is the first screen — **at 390 and
  at 1440**.

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
- **Unproven**: that the fix removes outliers on other sites; phone layouts that answer resizes differently; widths other than
  1440 and 390. **Proven since (2026-10-24, 54e6aaa)**: the hold stops every size reaction at 390 as at 1440 (fixture, deterministic),
  and nyaayai's live race at 390 does not reproduce on purpose (see the Step 1 re-check above).

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

## Step 4 — "got worse" measured on the as-is copy: IN PROGRESS (2026-10-23/24, branch `step4-lighthouse`; `copy-step4` superseded)

Done first on `copy-step4` (1006f54, the base of `step4-lighthouse`; the full suite NOT run, by the user's rule — related files only):
- **The re-audit measured an as-is copy with its scripts blocked.** It served the copy through `servePreview`, whose CSP blocks
  every script; an as-is copy runs the original's own. Motion rows, console errors and script-drawn headings "got worse" for
  that reason alone (28 rows on 4 homepage copies → 22 with the fix, no motion row left). Now `reaudit/index.js` serves an as-is
  output with `serveCopy`, as its preview and checks do. Test `reaudit-asis.test.js` fails without it.
- **Each regressed row of an as-is copy carries a reason or is marked unexplained** (`copy/gotWorse.js explainWorse`, five
  reasons a–e; parts rule; Lighthouse rows "e" only when nothing grew and, for timings, the same LCP element and page not
  heavier). `checklist.gotWorse` = { total, explained, unexplained, byReason }. App row "Why: …", KNOWN-ISSUES.md "## Got worse: …"
  with a "What this means" line; pages left out (reason c) are named in plain words with the 404 and what to do.
  `copy/run.js` no longer defaults an unexplained open item to "d" (now `unresolved`). The summary line says "not measured yet"
  instead of 0 until the re-audit (now queued after every as-is copy) finishes.
- **Files named only in code** (`preserve/referenced.js fetchReferenced`, after completion): sankalpam's 62 MB hero video via
  `new URL(…, import.meta.url)`, banner PNGs, nyaayai's lazily loaded page modules, indikaai's bare `/favicon.ico`.
- **The original's own llms.txt** is kept (`fixAsIs.js`, `fetchLlms` passed by the job only).
- **`serveCopy` answers `/about`** (301 to `/about/`, query kept) and clean URLs (`/pricing` → `pricing.html`); before, 404.

Done on `step4-lighthouse` (worktree `../Website-Audit-step4b`, from 1006f54; full suite NOT run, related files one at a time):
- **The as-is visual check uses the gate's arithmetic** (`preserve/check.js`): `pictureRounds` takes `NOISE_SHOTS` = 3 pictures
  per side (one fresh context per side per round, frozen timers, sequential rounds for memory) and `gateVerdict` compares them —
  blocks where the SAME side differs between its own pictures are the noise map; a block counts as a change only when it differs
  in every copy-vs-original pairing outside the map. `visualCheck`, `baselineVisual` (the saved original pictures are now three
  files `<slug>@<width>.png`, `-2`, `-3`) and `fixGate` all call it; no second implementation. `copy/checks.js` carries
  `noise[width] = { raw, inNoise, share, shots }` per page. Proof `copy-visual-check.test.js` (10 000 px page): a 38 × 38 block
  (1444 px, 0.01 %), a 120 × 120 block (14 062 px) and a 400 × 80 area 23 levels off white (32 000 px, 0.22 %) are all flagged;
  the old gate read 0.01 % / 0.1 % / **0 %** and the one-pair check at 0.1 read 0.01 % / 0.098 % / **0 % (0 px)**; a random
  canvas on both sides is noise (changedPx 0) with a 60 × 60 block beside it still seen.
- **"Still open" rows carry a reason or UNEXPLAINED** like the "got worse" ones (`copy/gotWorse.js explainOpen`, tables by
  evidence: a Lighthouse audit naming only third-party hosts → a; image / preload audits → UNEXPLAINED (a fix the copy may make
  and still owes); the original's own code / markup / colours → d; words only the owner writes (alt, names, lang, title length)
  → c; canonical / OG / sitemap / robots / llms without a new address → c; timings → e only when the copy did not grow). API
  `checklist.stillOpen` = { total, explained, unexplained, byReason }; the app's "Why:" row and KNOWN-ISSUES.md "## Still open:"
  rows; the summary line adds "(n with a reason, m unexplained)" after "Still open". Tests `copy-still-open.test.js` (6).
- **Lighthouse on every page, both sides, both modes** (`reaudit/lighthousePages.js`, re-audit step `lighthouse-pages` before
  `compare`, as-is copies only): each copied page and the same page of the original are run now, on this computer, with the same
  settings (the copy through `serveCopy`, the original through the egress proxy; the analysis's calibrated homepage run is NOT
  reused). One run per side decides when the copy leads by ≥ 5 in every category, else 2 more runs per side and the medians of 3
  decide; a copy median lower in any category = row `lighthouse-score.<mode>.<category>.<path>` (status regressed, explained by
  `scorePart`: performance → e when the page is not heavier and has the same LCP element; other categories by the checks failing
  only in the copy). The original's runs are cached per project in `lighthouse-original/` and reused by later re-audits.
  `checklist.lighthousePages` = { pages[] (scores per mode, runs, extra), worse[], extraRunPages[], skipped[], errors[], runs };
  a note names the pages that needed extra runs. Never fails the re-audit. Tests `reaudit-lighthouse-pages.test.js` (5, stand-in
  runner). Cost: pages × 2 modes × 2 sides × (1 or 3) runs of ~30–60 s each.

**Live run (2026-10-23, scratch API 4411, scratch data in the session's Temp scratchpad, plain-HTML as-is copies)**: only
nyaayai's homepage was run end to end (figures below, results copied to `C:/Users/urvas/Downloads/remastly-live-results/nyaayai/`).
indikaai (https://www.indikaai.com/) and makememo (https://makememo.ai/) **failed at Analyze within a minute**:
`AnalysisError: Could not reach https://www.indikaai.com/. The site did not respond in time.` (the same for makememo); a plain
request from this machine hung 21 s on both with no answer while sankalpam answered in 0.4 s — the sites, or the path to them,
not the tool. The user then moved the big multi-site run to the end of the copy-my-site work, before the PR.

**nyaayai homepage, the one site run end to end (project e97a1434 on the scratch data, copy 79cf5689, re-audit 71468133)**:
- Copy: 1 page, as-is, 22 min (capture 4.5, lift + fixes + checks 17.6). Visual check with the noise map: 1440 px **0 changed px**
  (4 481 px in the noise map, 35 % of the raw 0.005 %), 390 px **121 changed px** (0.002 %; raw 3.28 % was all noise: 200 730 px).
  47 safe fixes kept (45 names, 2 data), 0 reverted. Open items: no new-site address (c), a console error from the chatbot
  widget host (a), security headers (e).
- Re-audit (first attempt crashed at the end on a bug of this branch — `report.asIs.fixes.reverted` is a count, the page list
  is `report.copy.fixes.reverted` — fixed, run again): 51 rows: 11 fixed, 3 improved, 18 pass, 8 still open (all 8 with a
  reason: 4 c, 4 d), 4 got worse (links to the 20 pages not copied → c; mobile performance 80 → 73 → e; unused CSS 0 → 12 KiB
  and sitemap.xml → 404 **unexplained**; the sitemap now gets c by the address rule added after the run). Motion could not be
  measured on the copy (timeout), so no motion rows.
- **Lighthouse comparison — not comparable, and the reason is a real defect of the copy on this site**: in 5 of the copy's 6
  per-page runs (and both of the re-audit's own homepage runs) Lighthouse's Chrome got a **blank shell: 36 DOM elements against
  the original's 1 215 / 1 370**, console `Fatal error … TypeError: Invalid base URL at …/JQGUGunJL.Cj2najZC.mjs` (Framer's own
  runtime), performance unscored (`SPEEDINDEX_OF_ZERO`, no screenshots during the load); the one run that rendered scored
  performance 73 / accessibility 94 / best practices 96 / SEO 85 against the original's medians 80 / 90 / 96 / 85. The page
  renders fine in the copy's own Playwright checks (0 px visual difference) — the failure is specific to the Lighthouse load (its
  Chrome through the egress proxy; a race in Framer's base-URL resolution is the lead) and **is not understood yet**. Consequence:
  the "fixed" rows from the copy's analysis (accessibility 100, SEO 100, dom-size, layout-shifts, legacy-javascript …) were
  measured on that blank shell and are **not trustworthy** for this site. The first arithmetic averaged the nulls away (73 from
  one run against a median of three; the desktop called "not lower" with no score at all): now a run with no score, or a copy
  run under 20 % of the original's DOM elements (`BLANK_SHARE`), is **unscored** for every category — row
  `lighthouse-score.<mode>.<category>.<path>` with status `recheck`, the reason in words, never a median; the pass row covers
  only what was scored; the note counts them. Test `reaudit-lighthouse-pages` (5). Recomputed on the stored runs: phone
  2 blank of 3, computer 3 of 3 → nothing comparable, 0 "got worse" from Lighthouse scores.
### State on 2026-10-24 (end of session)

**Decision: the big multi-site live run moves to the end, before the PR.** Until then, live runs only to check a fix.

**The Lighthouse rule** (`reaudit/lighthousePages.js`): the copy's Lighthouse score is never lower than the original's, in any
category, on phone and computer, on every copied page. One run per side; when the copy is not ≥ 5 ahead in every category, two
more runs per side and the medians of three decide. A run with no score, or a copy run under 20 % of the original's DOM elements,
is "could not be scored" (status `recheck`, reason in words), never part of a median. The original's runs are cached per
project (`lighthouse-original/`) and reused by later re-audits.
**The copy is measured through a host like the one it will live on** (`reaudit/measuredHost.js`, ca2c630): 50 ms before each
answer (a CDN edge answering a cached file) and the bytes at Lighthouse's own device throughput (1638.4 kbit/s phone, 10240
kbit/s computer, `constants.js`) over one shared link, for the Lighthouse runs only (the per-page comparison and the headline
runs, through the new `runAnalysis` option `lighthouseOrigin`); the crawl, axe, links, motion, the preview and the shipped copy
keep the direct server. Why: Lighthouse models a page from the ORDER it recorded, and from a loopback server the site's scripts
had run before the first paint, so the model put their run time in front of LCP (nyaayai phone 68: a 6.2 s modelled LCP against
0.2 s recorded). The values are in the report (`lighthousePages.network`, the comparison note). The final proof is a real
deployment compared with PageSpeed Insights (end-of-plan live run, below).

**FIXED AND VERIFIED 2026-10-24: nyaayai's as-is copy rendered blank under Lighthouse** (was: 5 of 6 per-page runs and both
homepage runs a 36-element shell, console `Fatal error … TypeError: Invalid base URL at …/JQGUGunJL.Cj2najZC.mjs`). Full write-up
with the numbers: `remastly-live-results/nyaayai/BLANK-RENDER-2026-10-24.md`.
- **Cause 1 (d01efca, confirmed)**: the URL shim stood last in the body; the site's main module is `async` and a blocking
  third-party script (a chatbot widget's host) held the parser when it stalled, so the module ran before the shim and its
  top-level `new URL(x, '/root-relative base')` threw. Reproduced deterministically with a local proxy that stalls that host
  (`scripts/repro-stall.mjs`): saved copy → 36 elements, unscored; shim first → 1217 elements, performance 0.70. Even without a
  stall the late shim lost 172 elements silently (URL replaced at 1144 ms, the module had run at 368 ms).
- **Cause 2 (0fa8fc0, general)**: the site's runtime asks its CDN for a CMS index ~10.5 s after load (timer; original and copy
  alike). The completion pass had no shim yet (the runtime failed and asked for nothing) and ended ~7 s after load, so the copy
  shipped without the file (404 + console error on every visit; d01efca's "ask every original host" never ran for it). Now a
  pass opens the copy with the shim as an init script, caps the page's timers at `FAST_TIMER_CAP_MS` (1 s) and ends on
  `QUIET_MS` (2.5 s) of no requests with every answer given, at most `PASS_MAX_MS` (45 s) per page and size
  (`complete.js`, test `preserve-completion-late`).
- **Verified live** (fresh copy + re-audit, `run-2026-10-24/`): the index is asked of the site then the CDN and shipped; the
  shim is at byte 483; **6 of 6 Lighthouse runs of the copy rendered (1216 elements)**; visual 0.26 % / 0.19 %, heights equal.
  Scores (medians of 3): phone original 80 / 90 / 96 / 85 → copy **68** / 94 / 100 / 85; computer 84 / 90 / 96 / 85 → copy
  **96** / 94 / 100 / 85. The phone performance gap is the simulated LCP alone (6157 vs 1692 ms; observed 220 vs 777 ms; every
  other phone metric better on the copy): on the loopback host the modules arrive before the first paint is recorded, so Lantern
  puts their 4×-slowed run time in front of LCP; with applied throttling the copy is ahead (0.77 vs 0.72). The re-audit files
  the row as "deploy", explained; got-worse unexplained 0. Nothing changed in the copy for it.
- **Re-measured through the measurement host** (ca2c630, `reaudit-measured-host-2026-10-24/`, `MEASURED-HOST-2026-10-24.md`):
  phone copy **90** / 94 / 100 / 85 against 80 / 90 / 96 / 85, computer **96** / 94 / 100 / 85 against 84 / 90 / 96 / 85 — no
  Lighthouse row lower (modelled phone LCP 1436 ms against the original's 1692; recorded 1340 against 777; copy runs 91 / 90 / 90).
The 2026-10-23 "fixed" rows measured on the blank shell are superseded by this run.

**Still open on nyaayai's copy (re-audit 5bf00522, 2026-10-24)**:
- The "unused CSS 0 → 12 KiB" row of 2026-10-23 is gone after the fix (it was the blank render); after the measurement host the
  got-worse rows left are 20 new broken links and sitemap.xml (a one-page copy with no new-site address: owner).
- **The motion step's timeout: FIXED 2026-10-24 (31c5cf6)**, general. Measured stage by stage on this copy: loop capture 48 s
  (12 scroll windows of the strip scan on an 11 654 px page + 9 s of slow movers), self-changing parts 9 s, pointer 3 s, hover
  15.5 s, clicks 12.8 s = 90 s against a fixed timer of 104 s that dated from before the strip scan and the canvas recording
  existed. Now `capture/loops.js loopsTimeFor` says what the loop capture needs on a page from its own constants (47.4 s here)
  and `reaudit/motion.js motionTimeFor` = base 90 s + that + hover + clicks is the page's timer and the step's deadline.
  Re-audit after it (`reaudit-motion-2026-10-24/`): motion measured on the page — reveals 85 / 85, hover 14 / 14 with the same
  end states, loops 8 → 16, no motion row open or worse; the Lighthouse table holds (phone 89, computer 96).
- `lighthouse.offscreen-images` (425 vs 427 KiB) and `lighthouse.uses-responsive-images` (577 vs 772 KiB, phone) still open and
  **UNEXPLAINED** (2 of 10 still-open rows): both fail on both sides and the copy sends no more; the as-is copy keeps the
  original's images as written. **Not fixed now by decision (user, 2026-10-24)**: they belong to the images step (next steps
  item 4, after Step 5), whose goal is that the copy BEATS the original on these two rows without changing the look.

**This morning's run (2026-10-24, branch `copy-step4`, scratch data `C:/Users/urvas/Downloads/sas-work/data`, log
`sas-work/live.log`, `SAS_MAX_PARALLEL=2`)**:
- **indikaai answered from this machine this time** (it hung on 2026-10-23). Analyze found 12 pages (`/`, `/media`, `/solutions`,
  `/about`, `/industries`, `/careers`, `/contact`, three reports, two blog pages). **The copy failed**: one image comes from a
  `/wiki/Special:FilePath/…` address and the copy tried to create a folder with a `:` in its name, which Windows refuses (ENOENT).
  **Fixed in cfaab64** (cherry-picked here): every file of a copy gets a name any file system can hold, the same on every machine
  (`pageLift.js fileSafePath`: `Special:FilePath` → `Special~3aFilePath`; dot segments, a decoded backslash, a trailing dot or
  space and device names like `con` neutralised too); the copy's references point at that name; test `preserve-safe-names`.
  indikaai has not been run again with the fix.
- **makememo**: Analyze found 9 pages (`/ /about /pricing /blog /privacy /careers /terms /contact /security`); the run was
  **killed by the system for low memory** during the copy (37 min in), so no re-audit. sankalpam and nyaayai were not reached.

**Sites still to run at the end (before the PR)**: **one site per run, with `SAS_MAX_PARALLEL=1`** (two at a time was still
killed for memory on this 15 GB machine; free memory first), on a scratch API or scratch data only, same rules (Lighthouse rule
above; visual gate; re-audit):
- parchaa homepage — https://www.parchaa.com/
- panscience — https://panscience.xyz/, the homepage + the top-navigation pages Ventures, Approach, Ecosystem, Initiatives (the
  as-is copy takes an explicit page list, ≤ 40)
- sankalpam homepage — http://sankalpam.ai/
- indikaai whole site — https://www.indikaai.com/ (check it answers first)
- makememo whole site — https://makememo.ai/ (check it answers first)
- nyaayai homepage: DONE 2026-10-24 (`remastly-live-results/nyaayai/run-2026-10-24/`, scratch data `sas-work/nyaayai-data`).

**Where things are kept**:
- Live results kept for the user: `C:/Users/urvas/Downloads/remastly-live-results/` — `nyaayai/` (2026-10-23: summary.json, recreate/,
  reaudit/, lighthouse-original/, CORRECTED-VERDICT.txt, repro-blank.mjs; 2026-10-24: `BLANK-RENDER-2026-10-24.md`,
  `repro-2026-10-24/`, `run-2026-10-24/` with the fresh copy, re-audit, applied-throttling Lighthouse runs and the LCP probe;
  `MEASURED-HOST-2026-10-24.md` + `reaudit-measured-host-2026-10-24/` (+ `.log`): the re-audit through the measurement host;
  `reaudit-motion-2026-10-24/` (+ `.log`): the re-audit after the motion timer fix, motion measured;
  `stability-2026-10-24/` (`STABILITY-2026-10-24.md`, `after-fix.jsonl`, `probe-old.jsonl`, `race.jsonl`, `runs.log`): the Step 1
  re-check with the new ruler, the scroll-stop probe and the race attempt; harness `scripts/nyaayai-stability.mjs`),
  `first-attempt-indikaai-makememo/` and **`scripts/`**: the live-run driver `scratch-live.mjs`, `repro-stall.mjs` (serveCopy +
  a local proxy that stalls one host + Lighthouse), `nyaayai-fresh-copy.mjs` (one as-is copy + re-audit on a scratch data folder,
  summary and folders copied out), `nyaayai-reaudit.mjs` (a re-audit alone of a finished recreate, same folder rule) and the other scratch scripts of the step-4 sessions (never committed; they import from a
  worktree's `server/src`, so run them from a worktree's `server/` folder or fix the import paths).
- **Gotcha**: importing `server/src/db/index.js` from a second process (any script opening the same scratch `app.db`) marks every
  `running` recreate as failed with "The server restarted while this job was running" (`db/index.js:24`). The job itself goes on
  and writes its row back; still, never open a running job's database from another process — read its log / summary.
  **In production** (assessed 2026-10-24, not fixed): it needs two processes on one data folder — a zero-downtime reload or a
  rolling update on a shared volume (the new server starts while the old one still runs a job), or a maintenance script that
  imports `db/index.js`. Then the new process marks the running job failed and `resumeInterruptedRecreates` adopts its workspace
  (renames the `.tmp` folder under the running job), so the old job fails for real; with a plain restart-on-exit (systemd, PM2
  without reload) it cannot happen. Fix when wanted: a heartbeat column per running job (only stale rows are marked failed and
  resumed) and a lock file so a second server refuses the same data folder; about half a day with tests. **Must be done before
  launch** (user, 2026-10-24): next steps item 7.
- Scratch data of this morning's run: `C:/Users/urvas/Downloads/sas-work/data` (projects indikaai 9b829d40…, makememo 93e23afa…,
  sankalpam 06a12702…, nyaayai 603201ca…); logs `sas-work/live.log`, `sas-work/live-killed-run.log`. Driver: `remastly-live-results/scripts/scratch-live.mjs
  <projectId>:<whole|home> …` (calls the job managers directly, no server; it used to live untracked in `Website-Audit-copystep4/server/`).
- Scratch data of the nyaayai runs (project e97a1434 = nyaayai, analysis 9e93d237, cached `lighthouse-original/`): copied out of
  Temp to `C:/Users/urvas/Downloads/sas-work/nyaayai-data` (2026-10-24); the 2026-10-24 recreate is 4665093e, re-audit 5bf00522.

Known gaps: Step 1's stability figures (nyaayai 0.27–0.31 %) were measured with the old `pixelDiffPct` and not again.

## Next steps, in order (commit after each with `--no-verify`, say the full suite was not run; nothing is pushed before the PR)

1. **Step 4 — the blank render and the motion step's timeout: DONE 2026-10-24** (both fixed generally and verified live, see
   "State on 2026-10-24"). The two UNEXPLAINED image rows left on that copy go to item 4 by decision.
2. **Step 4, rest**: whatever *acts* on an unexplained "got worse" / "still open" row (`copy/run.js zeroRegressions` is the tested
   model, fakes only); the summary line's "Fixed" already comes from the re-audit.
3. **Step 5 — per-page fallback: AFTER LAUNCH (user, 2026-10-24).** The plan is written and stays as it is:
   `docs/STEP5-FALLBACK-PLAN.md` (878122f; 3½–4 days). Two changes the user wants in it when it is built: (1) the **performance
   trigger is "below the original's"**, not "below 50" (the plan's part 1 table and `copy/thresholds.js LIGHTHOUSE_PERF_MIN`);
   (2) the **live proof must be on a page that actually fails**, not on a site where nothing triggers. Until then a failing page
   stays "unresolved" with its reason in the report, which keeps the promise honest.
4. **Images on the as-is output: AFTER LAUNCH (user, 2026-10-24)** (WebP / variants / deferred loading of what is below the first
   screen), only where the pixels stay the same, through the same visual gate. Goal: the copy **beats the original** on
   `lighthouse.offscreen-images` and `lighthouse.uses-responsive-images` without changing the look — on nyaayai's copy both
   rows are still open and unexplained (425 vs 427 KiB; 577 vs 772 KiB on phone) because an as-is copy keeps the images as
   written.
5. **BUG, open: the exact comparison's pictures always answer 404** (found 2026-10-23 during the accounts work; still present
   on `step4-lighthouse`, checked 2026-10-24).
   `server/src/routes/recreate.js`, route `GET /api/projects/:id/recreate/:recreateId/exact/:slug/:file` (line ~277 on
   `copy-my-site` and `accounts`, ~211 on `exact-mode`). Its file-name check lost every backslash when it was written
   (commit b712d3d, 2026-10-10, "Exact mode A6" — the known regex trap of writing code through a shell heredoc):
   `const EXACT_FILE = /^(copy-)?d{3,4}(xd{3,4})?(-b[1-3]|-full|-map|-crop[1-3]).webp$/;`
   `d{3,4}` means the letter "d" three or four times, not digits, so a real name like `1440-full.webp` or `copy-1440x600-b1.webp`
   never matches and the route returns 404 "Image not found." before it looks at the disk. The line under it that picks the
   folder has the same loss: `/-(map|crop[1-3]).webp$/` (the dot matches any character; harmless there, but fix it too).
   Intended: `/^(copy-)?\d{3,4}(x\d{3,4})?(-b[1-3]|-full|-map|-crop[1-3])\.webp$/` and `/-(map|crop[1-3])\.webp$/`.
   Check the names against what the comparison writes: `server/src/recreate/verify/exact/compare.js` (`copyBand`, `mapFile`,
   `cropFile`, `shootBands(…, \`copy-${slot.id}\`)`) and `capture/exact.js` (`bandFile`), e.g. `1440-b1.webp`, `1440x600-full.webp`,
   `copy-1440-b2.webp`, `1440-map.webp`, `1440-crop3.webp`. Who sees it: the app's **Exact comparison** table
   (`client/src/components/recreate/RecreateReport.jsx`, links "map" and the crops) — every link is a 404, so the pictures that
   explain a failing slot have never been viewable. Fix generally, then add a route test that requests one file of each kind
   from a fixture recreate folder (200, `image/webp`) and one bad name (404), so the regex can never silently match nothing
   again. Also worth a sweep of server/src for other regex literals that lost their backslashes (a bare `d{`, `s+`, `w+` or
   an unescaped `.webp` inside `/…/`).
6. Recorded, waiting for a decision: security headers that take effect on Next.js / Vercel (DEPLOY.md is fixed, PARKED item 3).
7. **MUST BE DONE BEFORE LAUNCH — the database and a second process** (user, 2026-10-24; the gotcha under "Where things are
   kept"): (a) a **heartbeat per running job** (a `seen_at` column written with every progress update) so a starting server marks
   failed only the rows whose heartbeat is stale, and `resumeInterruptedRecreates` adopts only those; (b) a **lock file** in the
   data folder (pid, checked alive) so a second server refuses the same data folder instead of opening its database. About half
   a day with tests. Checked 2026-10-24: **no shipped way of running the app reloads without downtime today** — the app itself
   is one `npm start` process (`server/package.json`; no Dockerfile, PM2 or systemd unit in the repo), and the DEPLOY.md shipped
   with a copy (`src/copy/deploy.js`) says only where the COPY can be hosted (Netlify, Vercel, Cloudflare Pages / GitHub Pages /
   S3 / nginx, Render for MERN), never how this server runs. The planned API + worker + Docker architecture (docs/ACCOUNTS.md,
   docs/fidelity-audit.md step 8) is exactly the two-process case, so this comes before it.
Then the big multi-site live run ("Sites still to run at the end" above), one site per run, `SAS_MAX_PARALLEL=1`, scratch data and
ports only, before the PR.
**Final proof before launch (user, 2026-10-24)**: deploy one copy to a real static host (temporary, `noindex`, deleted
afterwards) and compare PageSpeed Insights, original vs copy, phone and computer. The measurement host
(`reaudit/measuredHost.js`) stands in for that host until then; this is the check that it stands in well.

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

1. **Revert-path tests / the comparison — FIXED 2026-10-23 (branch `copy-step4`).** It was the pipeline, not the test page: the
   2 × 2 dot was in the picture (4 pixels really differed), and `pixelDiffPct` reported 0 — it rounded to 0.01 % of the whole
   page and ignored any change of ≤ 24 levels per channel. Measured: a solid 10 × 10 px change read 0 % on a 900 px page, a 30 × 30
   px change "0.01 %" on a 10 000 px page (both passed as unchanged), and a 60 × 60 px #f0f0f0 square 0 % at any height. The old
   noise came from ONE pair of pictures, so verdicts flipped: makememo's 3 fixes were kept on 10-21 and undone on 10-23 by the
   same old gate on the same copy.
   Now **one ruler**: `pixelDiffPct` is gone; the gate, the as-is visual check, the baseline check, the component check and
   `scripts/preserve-stack-check.mjs` all use `verify/exact/pixels.js exactDiff` (pixelmatch's YIQ distance, antialiased edges
   set aside, every pixel counted; it gained `commonPct`, the share of the part both pictures have, to 4 decimals, and now reads
   pictures without an alpha channel correctly — before, an RGB PNG was read 3 bytes off per pixel). The gate
   (`check.js fixGate` / `gateVerdict`) pictures each side 3 times (`NOISE_SHOTS`): wherever two pictures of the SAME side
   differ is the noise map (8 px blocks, +1 block margin); a block is a visible change only when it differs in EVERY
   fixed-vs-unfixed pairing and lies outside the map — one pixel is enough; threshold 0.05 (`GATE_THRESHOLD`, finer than the
   default 0.1 used for scoring a copy). Limits, stated: a change fainter than ~13 / 255 on grey (#f5f5f5 on white) is not seen;
   a change that lies inside the parts that move by themselves (0.3–1.1 % of nyaayai's page) cannot be proven either way and is
   reported as `inNoisePx`, not passed silently. Cost: 6 full-page pictures per changed page instead of 3.
   Step 3 re-validated with it (3 runs each): nyaayai 49 of 49 kept, makememo 3 of 3 kept, 0 px of consistent change every time
   (the fixes are labels, JSON-LD and address tags, which draw nothing). Tests: `copy-fix-gate.test.js` (6; the old "a small
   visible fix on a noisy page is kept" now expects it UNDONE, and a no-op fix on the same page kept).
2. **Next.js security headers — fixed, verify in a real run.** Commit `bf01313`: one header list (`copy/securityHeaders.js`);
   the Next.js package sends them from `next.config.mjs headers()` (proven: `copy-served.test.js` builds and starts a real
   package, all five headers sent). `copy/served.js` measures what the packaged copy's own server sends after packaging; headers
   count as applied only for stacks with their own server (Next.js, MERN); Plain HTML / React + Vite `_headers` is an open item
   with reason e, never a fix. MERN sends no HSTS (open, reason e). Still to do: one real as-is run per stack to see the
   measurement in a report; the CopyPages line was built but not looked at in the browser.
3. **DEPLOY.md names scripts the as-is package does not have — FIXED 2026-10-23 (on `accounts`).** `copy/deploy.js` no longer
   has a text per stack: `describePackage` reads the package the zip actually holds (its package.json scripts and dependencies,
   its vite / next config, its folders) and `runAndHost` writes the commands from that; `export/zip.js` plans the files first and
   writes DEPLOY.md from them (`shippedOf`). What is not shipped is said (`serve` comes through npx and needs the internet the
   first time; MongoDB is not part of the copy; an as-is Next.js copy needs a Node host, no static folder). Also fixed on the way:
   the clean HTML download is in `site/`, its DEPLOY.md said `npx serve .`. No `install:all` alias. Test
   `copy-deploy-commands.test.js`: all 4 stacks × clean / as-is through the real zip plan, every script and folder named exists
   (or is the declared output of the build it names). Run for real: 8 downloads unzipped in scratch, every command run — all start.
4. **Step-1 proof re-check.** The step-1 numbers used the live original on both sides, never the capture picture, so the 19ddc59
   bug did not touch them. Still unproven: other sites than nyaayai; the race at 390 (never observed there); and the check's
   own scroll stops at 14 000 px (`check.js openAndScroll`), so on nyaayai at 390 (15 681 px) the last 1 681 px are never
   scrolled into view on either side. Fix by scrolling to the page height with the capture's `scrollThrough`, then re-measure
   nyaayai and makememo at 1440 and 390 in fresh processes (harness pattern: see "Step 1" above).
5. **Step 4 — re-audit + zero-regressions loop: IN PROGRESS since 2026-10-23** (see "Step 4" and "Next steps" above): the re-audit
   runs after every as-is copy, "got worse" and "still open" rows carry reasons, Lighthouse runs on every page of both sides; the
   summary line's "Fixed" comes from the re-audit. The blank render under Lighthouse was fixed and verified 2026-10-24. Open: what
   acts on an unexplained row.
6. **Step 5 — per-page fallback (not started).** A page below threshold: auto-repair known stack issues, else a clean rebuild of
   that page in the chosen stack with a time-boxed exact correction, keep the better. `copy/run.js` has the decision logic with
   fakes only.

Also known: clean-rebuild captures taken between 19ddc59 (2026-10-18 08:58 UTC) and 10a665a have blank reference pictures; in the
scratch corpus that is dreamhire d541c77b, parchaa 5543a393, flexibench dcecafc4 / fe1df206 (partly) and makememo 1fe625e9 (as-is
fallback). The real database very likely has such runs too (the dev server ran this code in that window) — not checked: the
real data folder was not read. `scratchpad/window.mjs` of the 2026-10-21 session lists them read-only, given a data folder.

## Parchaa re-audit rows (2026-10-24, in progress: hovers and loops fixed, best practices next)
- **Hovers 0 of 5 → FIXED** (commit after 116da51): cause as below; fix = the re-audit tells the copy's probe which elements hovered on the original (`hoverFirstFor`: tag|text keys, `captureInteractions({ first })` probes them before everything else, `stats.first/firstProbed`) and `hoverBudgetFor` covers them at `FIRST_MS` 2.5 s each (parchaa 10.5 → 12.5 s). Re-measured on the saved copy: **5 of 5** (`remastly-live-results/parchaa/motion-2026-10-24/first/copy-motion.json`). Tests: `recreate-hover-probe` 4/4, `reaudit-motion` 13/13 (+1 pre-existing skip). Full suite not run.
  Original finding: the copy's hovers work. The re-audit's hover probe got `hoverBudgetFor` = probed × 1.5 s = 10.5 s, spent it on 5 elements that never revert (each waits the scripted settle time) and never reached the five cards; with 60 s it probed 14 and found all 5. Evidence: `remastly-live-results/parchaa/motion-2026-10-24/copy-motion.json`.
- **Loops 14 of 16 → FIXED**: every one of the 16 loop elements moves in the copy (watched 3 s on both sides, same angle ranges: `remastly-live-results/parchaa/motion-2026-10-24/loops-watch.json`); the check was wrong. Four badges rock ~3.5°/s, so a 2.2 s recording covers 5–12° (`loop-evidence.log`), right at the probe's 5° minimum: caught near a turning point a badge fell under it and `captureLoops` dropped it at once instead of watching it longer like the other slow movers. Fix: `movesSlowly()` (`SLOW_FLOOR`: a change above noise but under a channel's minimum) → watched `slowWatchMs` like a `move`. Same code on both sides, so the capture is steadier too. Re-measured: **16 of 16** (`loops-fix/copy-motion.json`). Test: `recreate-loops` 4/4 (+1 rocking badge). Full suite not run.
- **Best practices computer 100 → 96 (`errors-in-console`)**: one 404 in the copy, `/cms/…/zDzR8K3ip-indexes-default-0.framercms?range=0-120`. The runtime asks a CMS index file in byte ranges through a `range=from-to` query (CloudFront answers 200 with those bytes; verified: the record's 412-byte answer = bytes 769–1180 of the full 42 739-byte file, and `?range=0-120` = its first 121 bytes). The record holds only the slice the capture's visit asked for, the lift copies `data` entries only when their type is media, and the completion pass saw no such request, so the copy has no `/cms/` file at all; the original scores 100 because its CDN serves every range. The reason text is also wrong (`gotWorse.js hasFileExt` allows ≤ 6-letter extensions, so `.framercms` reads as a "page not copied"). Next: in completion / the lift, a same-origin request with a `range=` query → fetch the bare file in full, verify the slice against the record, store it at the bare path (a static host answers any query with it; the runtime checks the length — test whether it then throws) and let `sw.js` slice ranged addresses; fix `hasFileExt`.
