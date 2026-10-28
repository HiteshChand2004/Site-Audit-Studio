# Handoff — copy-my-site

> **Working rule (the user's): every fix must be generic.** No site-specific patches, and no code that checks for a site name,
> an address, a framework name (like Framer) or a specific page. A fix must work for any site that has the same problem. Real
> sites only find problems and verify fixes; a site may be named in a comment or a test's story, never in a condition.

Branch `step4-lighthouse` (worktree `../Website-Audit-step4b`, from `accounts` c7fa9a4 <- `copy-my-site` <- main 511f36a, PR #2 merged).
Not merged and **nothing pushed** (there is no `origin/step4-lighthouse`). `copy-step4` is superseded: its one commit past the common
base, cfaab64, is babf36c here (same patch id), so merging only `step4-lighthouse` into `accounts` is a fast-forward of 7 commits and
loses nothing except the untracked scratch scripts, which are kept at `C:/Users/urvas/Downloads/remastly-live-results/scripts/`.
Read first: `docs/COPY-MY-SITE.md` (the plan and the rules). This file says what is actually built and what is not.

## State on 28 Oct 2026

**main** (`origin/main` d435fe2):
- **One repository**: the marketing site is in `website/` (PR #4, branch `monorepo`, merged as 5fdd245). Details in the next
  section.
- **Check-step CSS fix** (PR #5, branch `fix-details-overflow`, ae25731, merged as d29c3ff): the expert report stays inside its
  column on the Check step.
- **Mobile menu fix** (PR #6, branch `fix-mobile-menu`, d9c94c5, **merged** as d435fe2): the website's mobile header menu shows
  every option.

**Open branches** (pushed, not merged):
- `ui-simplify`: UI simplify **stages 1–6b done** (1 display bugs; 2 shared words + look warning + "Show details" fold; 3 no look
  scores on screen, one red look warning; 4 Results in plain words; 5 site header, top bar, report dialog and Overview in plain
  words; 6 / 6b the Check screen finished, choosing one page is the owner's only, enforced on the server). **Stages 7–8 left.**
  It has main merged in up to the monorepo merge; main has 2 commits it does not have yet (PR #6).
- `analyze-100`: a new project reads 100 pages instead of 25, and Analyze says why the crawl read fewer pages than its limit.
  Its three commits (83bac37, 38f77b3, 589bdff) are **already on main**; the branch holds nothing main lacks and can be deleted.
- `owner-transfer` (428392a): `npm run accounts -w server -- transfer-owner <email> [--move-projects] [--yes]` hands the owner
  role to another verified account (dry run without `--yes`; with it a checked backup first, then one transaction). Not merged.

**Owner and deployment:**
- The owner account is **remastly.panscience@gmail.com**. `SAS_OWNER_EMAIL` is read only by the first `npm run db:migrate -w
  server`, which creates the owner; changing it later changes nothing. Moving the role to another account is `transfer-owner`,
  which exists only on the `owner-transfer` branch until it is merged.
- The site is deployed at **https://remastly.panscience.ai**. Its API answered **502** on the last check; that is being fixed.
- Caddy's `forward_auth` is **not** used. **No Docker** for launch: one `npm start`
  process as in `docs/DEPLOY-TOOL.md`.
- Pending: the Search-Ready brief, to be added as `docs/SEARCH-READY.md` (not in the repo yet).

## One repository: the marketing site is in `website/` (branch `monorepo`, 2026-10-27, not merged)

**Layout.** `website/` is the marketing site (Next.js), brought in from `HiteshChand2004/remastly-website` main 549f866 with
its full history (`git subtree add`, no squash: its 20 commits are in `git log 4eb890d^2`). It keeps its own `package.json`
and `package-lock.json` and is **not** one of the root npm workspaces: it pins its own Next / React versions, and keeping it
out leaves the root lockfile and the root `npm ci` exactly as they were.

- `npm run local` (scripts/local.mjs) finds the site in `./website`; `SAS_MARKETING_DIR` still points it at another copy.
- Deploy (docs/DEPLOY-TOOL.md): one clone per release; the site is built in `releases/<tag>/website` and `/srv/sas/site`
  links there. There is no `<site-repo-url>` any more.
- `.gitignore`: the site's build folders and `website/.env*` (`.env.example` kept). The root rule `data/` (the tool's data
  folder) would also hide new files in `website/data/`, so that folder is excluded from it.

**What a collaborator does after the merge.**
1. `git pull`, then once: `cd website && npm ci` (the root `npm ci` does not install the site).
2. `npm run local` as before. The separate `../remastly-website` folder is no longer used; at the time of the move it was
   clean and at 549f866, so nothing in it is lost. Delete it or keep it, but make new site changes in `website/` here.
3. Site changes are ordinary commits in this repo. Until the old repository is retired (not decided; not part of this step),
   `git subtree pull --prefix=website <its url> main` (no `--squash`) brings in anything still committed there.

## Launch readiness (added 2026-10-24)

> **Rule (the user's): all work is done with deployment of the whole website + tool in mind.** Every item below is open until
> it says DONE; each names where it stands today.

| # | Item | Status | Note |
|---|---|---|---|
| L1 | Production refuses to start with accounts off | **DONE** (774fd5d, on `accounts`) | `config/index.js startupProblems`: `NODE_ENV=production` without `SAS_ACCOUNTS=1` stops the server with a "Not starting:" line before it serves anything. |
| L2 | Database: heartbeat per running job + lock file | **DONE** (1b7e222, c61e005, on `accounts`) | One server per data folder (`config/dataLock.js`: a second one exits naming who holds it; a lock naming a dead or our own pid is stale; a replaced container waits at most 120 s), and a job is failed only when its heartbeat stopped (`jobs/liveness.js`), so a starting server never takes over a live job. Still deploy with stop-then-start (DEPLOY-TOOL.md). |
| L3 | Preview in a sandboxed iframe with no same-origin access | **DONE, proven (2026-10-24)** | Previews are paths of the app's own address, `/preview/<token>/…` (`recreate/previewRoute.js`, `previewTokens.js`), every document sent with `Content-Security-Policy: sandbox allow-scripts` and framed with `sandbox="allow-scripts"` (plain copies `""`), never `allow-same-origin`; `/api` refuses `Origin: null` / `Sec-Fetch-Site: cross-site` (`security/foreignOrigin.js`). `test/preview-sandbox.test.js` shows the risk first (a copy on a path of the app's address framed as before read the signed-in user's account and projects from the API and the app's storage) and then that the same copy through the preview cannot (origin `null`, no cookie sent, API 403 / unreadable, cookies and storage throw, no service worker), while its own stylesheet, script and data still load. Since the same day the preview also runs the copy's script fully: addresses written in pages, stylesheets and module specifiers are moved under `/preview/<token>/` on the way out, and the addresses the script builds at run time by a shim served first in every document that may run script (`recreate/previewShim.js`: fetch, XHR, URL, element attributes, markup strings, the CSSOM, an import map for `import()`; the page sees its own address through `history.replaceState`; private in-memory stand-ins answer for storage and cookies, which the browser otherwise throws on). The shim reports counts (moved / failed / errors / blank) to the app with the token, and the Compare step says in plain words when a page could not run fully and that the downloaded copy is not affected. Proven on two as-is copies of client-rendered sites (one a bundler build, one a builder export): blank / half-drawn without the shim, complete with it. Remaining limit: a full navigation the script makes itself to a root address leaves the preview; a worker gets no shim. The downloaded copy is never touched (the rewriting happens on the way out). See docs/ACCOUNTS.md "Previews when hosted". |
| L4 | Job queue + concurrency limits per server and per user | OPEN | Today: one global lock per process (one Analyze / Recreate / Re-audit at a time), no per-user limit, no queue across processes; `SAS_MAX_PARALLEL` caps browser contexts. Two jobs at once crashed a 15 GB machine. Size the limits from measured memory per job (peak RSS of server + browsers per job kind and page count), not from guesses. |
| L5 | Upper time limit per job and per page | OPEN | The motion timer now grows with page length (`motionTimeFor`: at most ~4.6 min per page, 6 pages), the completion pass has `PASS_MAX_MS` 45 s per page and size, but an exact / manual run has **no job limit** (`Infinity` by design) and the capture of one very long page has none either; the as-is warm-up scroll is bounded (`preserve/scroll.js SCROLL_MAX_MS` 30 s, 54e6aaa). Needed: a hard ceiling per page and per job in production, with what was not measured reported, so one page cannot hold a server for hours. |
| L6 | Outbound fetching from a datacenter IP | OPEN | Sites may block or stall it (bot protection, geo rules). Known from this machine: the chatbot host `botza.panscience.xyz` stalled ~21 s / `ERR_EMPTY_RESPONSE` on 2026-10-23 (the blank-render trigger); indikaai and makememo had to be "checked that they answer first" (2026-10-24 morning). Keep a list: site, host, what failed, why, date — from the live runs and from production logs. |
| L7 | Disk: storage per copy + cleanup policy | OPEN | An as-is copy keeps every original file (nyaayai homepage 4.6 MB referenced; an exact copy was 83 MB of `dist/`); retention today: latest 2 recreates keep their IR, latest 3 analyses keep screens, `pruneRecreates`; scratch folders (`sas-work`, Temp scratchpads) grow without limit. Needed: a per-copy size figure in the report, a quota per user / per site, and a scheduled cleanup of old copies, re-audits and scratch. |
| L8 | Production config: HTTPS, Secure cookies, secrets in server `.env` only, database backups | OPEN | HTTPS is the reverse proxy's; the session cookie must be `Secure` + `HttpOnly` + `SameSite` behind it; no secret in the client bundle or the repo; SQLite backups (a copy of `app.db` + `projects/` on a schedule, restore tested once). |
| L9 | Email: Gmail SMTP daily limit | OPEN | OTP mail goes through Gmail SMTP (OTP stage 5). Gmail caps sending (about 500 a day on a free account, 2 000 on Workspace) and throttles bursts; move to a provider (transactional mail API) before the first marketing push or when daily sign-ups approach a tenth of the cap. |
| L10 | A deploy guide for the tool itself | **WRITTEN** (`docs/DEPLOY-TOOL.md`, 980a727, merged into `accounts`) | One Ubuntu VPS: Caddy, systemd, the data folder, backups, cleanup, the first-day checklist. Its open points are listed under "Deploy guide: open points" below. |
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
- **Gotcha, FIXED on `job-lock` (2026-10-24)**: importing `server/src/db/index.js` from a second process used to mark every
  `running` recreate as failed ("The server restarted while this job was running", `db/index.js:24`). Now the module only opens
  the database; the server marks a job failed only when its heartbeat has stopped (see "Branch `job-lock`" below). On branches
  before it the old behaviour stands: never open a running job's database from another process there.
- **Gotcha (as written before the `job-lock` merge; kept for the production assessment)**: importing `server/src/db/index.js` from a second process (any script opening the same scratch `app.db`) marks every
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

## The as-is copy converted into stack code (branch `accounts`, 2026-10-24) — Next.js DONE on the fixture, React + Vite and MERN next

**Decision (the user):** "Copy my site" gives both — the identical look of the as-is copy AND real code in the chosen stack. The clean
rebuild stays owner-only as it is. Order (changed mid-way by the user): **Next.js first**, then React + Vite, then MERN; no live site
until the user names one.

**Shared core — `server/src/recreate/convert/document.js` (commit a9dba0c).** Input: a finished as-is page (final HTML + CSS, already
identical to the original, fixes applied). Output per page: `html` / `body` props + the attributes React cannot write (`raw`), `headJsx`,
`sections[] { name, jsx, hash, shared }` (one component per child of the body, or of the one wrapper that holds the page — `sectionHost`
looks through up to 3 single-child wrappers; names from landmarks → id → first class → tag), `pageJsx` (the page around them),
`fallbacks[] { page, where, tag, attribute?, reason }`, `forms[]` (label, method, where the original sent it in plain words, fields,
password / file, `worksWithoutOriginal`, a note), `stats`. `convertSite(pages)` makes a section identical on ≥ 2 pages one shared
component. Rules reuse `emit/react/jsx.js` (`propName`, `svgPropName`, `styleObject`, `jsxText`, `jsxAttr`, `BOOLEAN` now exported):
class → className, for → htmlFor, style → object, boolean attrs → props, `checked` → `defaultChecked`, `value` → `defaultValue`
(textarea from its text, select from its selected option), custom elements keep HTML names, SVG attrs camelCased with the inner markup
raw, `script` / `style` / `noscript` / `template` / `iframe` inner text raw. Whitespace-only text in the head is left out (adjacent text
nodes would get React's `<!-- -->` markers); comments are dropped (React cannot write them; they draw nothing).
**Fallback = exactness first:** an inline `on*` handler, an attribute name JSX cannot carry (`@click`, `[x]`), a reserved React name
(`key`, `ref`, …), a `javascript:` address, a boolean with a foreign value (`hidden="until-found"`), a repeated / malformed inline style,
a `<meta>` / `<title>` / `<link>` / `<base>` standing in the body and an `async` script in the body (React 19 moves those to the head)
→ the element is kept as the original HTML: `<RawHtml b64="…" />` renders an inert `<template data-sas-raw="<base64>">` that the build
step unwraps, so the DOM is the original's byte for byte and no React escaping rule can touch it. Every fallback is recorded.
Tests: `test/convert-document.test.js` (7).

**Next.js writer — `server/src/recreate/convert/next.js`.** Pages Router + `output: 'export'` + `trailingSlash: true`, every page
`export const config = { unstable_runtimeJS: false, unstable_JsPreload: false }` → **the exported pages carry no Next.js script at all**
(no `__NEXT_DATA__`, no `_next/` tag): prerendered, never hydrated, the original's own scripts run as on any HTML page. That is the
generic answer to "the runtime must not lower Lighthouse": nothing is added to what the original loads. Layout: `pages/<route>/index.jsx`
(from `emit/next/routes.js planRoutes`: `about.html` → `/about/`, `urlChanges` → `public/_redirects` + `vercel.json`, links rewritten
in the pages), `pages/_document.jsx` picks the page's own `<html>` / `<head>` / `<body>` from `src/documents/<Page>.jsx` by
`__NEXT_DATA__.page`, `src/components/*.jsx` (shared ones once; a page's own ones prefixed with the page name when a name is taken),
`src/components/RawHtml.jsx` only when needed, `public/` = the copy's other files unchanged, `site-files/` = what Next refuses in
`public/` (the copy's own `_next` folder, its `404.html`), `scripts/after-build.mjs` (shipped, run by `npm run build`): unwraps Next's
`<div id="__next">`, removes Next's own charset / viewport metas and `<noscript data-n-css>`, unwraps the raw templates, writes the
`data-sas-raw-attrs` of `<html>` / `<body>`, **removes the `<link rel="preload" as="image">` hints React 19 adds of its own** (only the
page's own image preloads, `scripts/own-preloads.json` per route, stay — found on the fixture: React preloaded `/img/team.png` in the head
AND at the top of the body on a page whose original had no preload), deletes `out/_next` when no page references it (505 KB of
manifests), copies `site-files/` into `out/`. `pages/404.jsx` (no runtime either) only when the copy has no `404.html`. README lists the
pages, the parts kept as HTML, the forms. `buildConverted(dir)` = `next build` + the after-build step through `build/toolchain.js`
(toolchain `next`, pinned versions from `toolchains/next/package.json`). Fixture: 10 pages → 16 components (header + footer shared),
2 fallbacks (the two inline handlers on /work), build ≈ 13 s.

**Wired into "Copy my site"** (`behavior/preserve/stage.js`, `stack === 'nextjs'`): convert → build → `report.asIs.convert =
{ mode: 'converted', routes, urlChanges, stats, fallbacks, forms, shared }`; the export `out/` is served by `serveCopy` (static files,
headers measured as `takeEffect: 'host'` like plain HTML — `measureServed({ takeEffect })`); `PACKED.nextjs.served = ['out', 'public']`
so preview / re-audit read `out/`. **A download never fails:** if conversion or build throws, the earlier route runs (`packLifted` +
`next build` + `next start`), `report.asIs.convert = { mode: 'packed', failed }` and a warning says so. Every fallback goes to the owner
log (`copy/serverLog.js issueLogger`, reason `converted`, new code `f` in `copy/openItems.js REASONS`) and to KNOWN-ISSUES.md in the
download (`export/notes.js`, one section per part: page, tag / attribute, where, reason). Client: `AsIsChoice.jsx` wording for the
Next.js choice, `AsIsReport.jsx` "Converted into code" (counts, the fallbacks in plain words, each form: where the original sent it and
whether it keeps working if the original or its platform is shut down).

**Proof on the fixture — `test/convert-next.test.js`** (one browser; the fixture site as served stands in for a finished as-is copy):
the conversion facts; the same DOM as the original on every page (`verify/equivalence.js domSignature`, scripts off, moved pages
mapped, the two origins read as one) and every same-site link answered; the as-is rulers against the ORIGINAL (`check.js checkCopy`:
visual gate with the noise map at 1440 and 390 — diff ≤ 0.05 % outside noise and the same height —, clicks, hovers); Lighthouse through
`reaudit/measuredHost.js` on both sides, **three runs a side, alternated, judged on the medians, no tolerance** (the user's rule, the same as the React + Vite branch): the converted median is never below the original's in any category.
Result (2026-10-24, 9 pages, the lift-only stress page about.html left to the lift): **4 / 4 pass** — 16 components (header + footer shared), 2 fallbacks (the two inline handlers on /work), DOM identical on every page, every visual gate 0 % outside the noise map at both widths with equal heights, no click / hover mismatch, Lighthouse medians never below the original's; ~13 min, most of it the visual rounds. test/full-flow.test.js now expects the converted project for Next.js (served folder `out`, `pages/index.jsx`, `pages/_document.jsx`, `scripts/after-build.mjs`, `asIs.convert.mode === 'converted'`, no runtime in the preview page): **pass, 19.5 min** (2026-10-24, every stack, ordinary user and owner, through the real API).

**Not done / limits:** React + Vite and MERN writers (the core is shared: a writer needs its own project layout, a prerender of the
components with the same `RawHtml` unwrapping — the after-build pattern in `next.js AFTER_BUILD_SOURCE` —, and the same hoisting
fallbacks already in the core); no live site yet (the user names one); the zip of an as-is Next.js project ships the source (`out/` is
built by `npm run build`, as DEPLOY.md says); a `<form>` keeps the original's `action` — the as-is form guard decides what happens on
submit, the forms list says so per form; a copy made before this has no `convert` section (make the copy again).

### Live test of the converted Next.js copy: nyaayai homepage (2026-10-25, stopped for a laptop shutdown, NOT finished)

Scratch data `C:/Users/urvas/Downloads/sas-work/nyaayai-next-data` (copied from `sas-work/nyaayai-data`, migrated with
`scripts/db-migrate.mjs --db ... --backup-dir ...`; the real data folder untouched). Results and logs:
`C:/Users/urvas/Downloads/remastly-live-results/nyaayai/nextjs-convert/`. Drivers: `remastly-live-results/scripts/nextjs-convert.mjs`
(env `REPACK_FROM` / `RESUME_FROM`) and `side-by-side.mjs` (pictures at 1440 / 390 + exactDiff map).
- Found and fixed generally on the way (committed, related tests pass): an inline style on `<svg>` broke the Next.js build
  (a742376); the preview / re-audit picked the project's saved stack instead of the stack the as-is copy was made in, so every
  non-HTML as-is copy made from the app failed its re-audit (a742376); the conversion dropped HTML comments, which a React-rendered
  site reads back as hydration markers: phone performance 80 -> 54, largest paint 7.9 s late, 3 loops lost (e515352).
- Run 3 (before the comment fix, `run-3-comments-dropped/`): visual 0 % at 1440, 0.002 % at 390, equal heights; clicks and 9 / 9
  hovers like the original; computer Lighthouse 84 -> 98, phone 80 -> 54; 18 components, 17 parts kept as HTML (16 `<link>` + 1
  async script standing in the body); 3 forms, all guarded.
- Run 4 (with the fix, "Package again" from db54dfd5) was stopped after the 1440 gate (0.0002 %, equal height). A package job keeps
  no checkpoint and needs none: the source copy db54dfd5 is intact in the scratch data.
- Run 5 (2026-10-25, "Package again" from db54dfd5, comments kept; original not reachable, so compared with the saved picture):
  visual 0.0005 % / 0.002 %; Lighthouse medians of three, phone 80 -> 92, computer 84 -> 96. The phone drop of run 3 was the
  dropped comments (React-rendered markup read without its hydration markers).
- Run 6 (2026-10-25, b6441de, "Package again" from run 5's copy 1c41a1fd — db54dfd5 was removed by retention): 47 fixes kept
  (45 names, 2 structured data), fix gate 0 px; Lighthouse phone 80 -> 86, computer 84 -> 96, accessibility 90 -> 94; "fixes
  served" = served (compared by meaning). Live original vs copy: equal heights, 0.26 % at 1440 / 0.13 % at 390, all of it the
  third-party chat search bar (botza.panscience.xyz widget, not downloadable, 3 console errors), not the conversion. Pictures
  in `remastly-live-results/nyaayai/nextjs-convert/pictures/`.
- Fixed in b6441de: sections found inside builder wrappers (`planSections`: nyaayai = SiteNav, Hero, Section3, NyaayAIReflects,
  SolutionsAcrossThe, UnifyingFragmentedLegal, BuiltOnProof, OurCertifications, SuccessStories ×3, SeeHowNyaay, WeAnsweredAll,
  SiteFooter ×3, SvgTemplates; the ×3 are Framer's per-width versions); "fixes served" compared by meaning; a comment with a
  quote broke the Next.js build (convert-next failed on 6cc8ee8).
- Comments before `<html>` kept (`prologOf` → `data-sas-prolog` on `<Html>` → the after-build step puts them back in front of
  `<html>`). Run 7 (from run 6's copy c7c5df3b): the export starts exactly like the original (both Framer comments); Lighthouse
  phone 80 -> 87, computer 84 -> 95, accessibility 90 -> 94.
- Open: BuiltOnProof is still 127 KB (one titled section holding a long list).

### `npm run dev` of a converted Next.js copy showed an original built with Next.js unstyled (gardner.panscience.ai, 2026-10-25)

- Cause: the original's own files under `/_next/` (gardner, App Router: `/_next/static/chunks/*.css` / `*.js`) go to
  `site-files/`, which only the after-build step copies into `out/`; `next dev` answers every `/_next/` address itself, so they
  were 404s. Dev also ignores `unstable_runtimeJS: false` (adds its runtime + `body{display:none}` until it runs) and skipped every
  after-build fix (RawHtml, prolog, raw attributes).
- Fix (generic): the project ships `scripts/finish-page.mjs` (the page finishing, shared), `scripts/after-build.mjs` (applies it to
  `out/`) and `scripts/dev.mjs` (`npm run dev`): Next's dev handler on an internal loopback port, `site-files/` served first, every
  HTML answer finished like the build with Next's dev runtime removed, the copy's own `404.html` for a missing page. Next's own head
  tags are now removed by position (first charset / viewport metas, last `<noscript data-n-css>`), so a Pages Router original's
  identical-looking tags stay. Test: `convert-next-dev.test.js` (App Router home + Pages Router `/about/`; dev = build byte for byte,
  same DOM / styles / script / pixels as the original).
- Reserved by the other stacks' dev servers (for the React + Vite / MERN conversion): Vite answers `/@vite/*`, `/@fs/*`, `/@id/*`,
  `/@react-refresh`, `/node_modules/*` and serves the project's own files at their paths (`/src/*`, `/index.html`, config files); its
  build writes `/_app/` here (`assetsDir`), so an original's `/_app/` collides. MERN adds the Express routes `/api/health`,
  `/api/forms/:id` and `/thanks`.

### React + Vite writer (branch `convert-react`, 3b2b340 + the merge of `accounts` c8d265d, 2026-10-25) — code done, browser tests NOT run

- `server/src/recreate/convert/react.js` on the shared core: every page `src/pages/<Page>.jsx` (body of section components +
  `document` = doctype, prolog, html / body props + raw attributes, head), `src/components/*.jsx` (shared ones once),
  `src/routes.js`, `src/entry-server.jsx` (renders a page: body after a marker so React 19's image preload hints fall away, head
  one element at a time so React keeps its order), `src/finish-page.js` (puts back RawHtml parts, the page's comments
  (`data-sas-comment`) and the prolog before `<html>`), `scripts/prerender.mjs` (`dist/` = `public/` + the pages), `scripts/dev.mjs`.
  Pages keep their addresses (no `urlChanges`). Prerendered, never hydrated: `dist/` holds no React code. `verifyConverted`
  (no browser) holds every built page against its as-is page — elements, attributes, text, the comments of head and body, the
  prolog — and refuses any added script / stylesheet; a failure packages the copy as before (`report.convert.mode 'packed'`).
- `npm run dev` = Vite used **only** to load the components (`ssrLoadModule`, no client, `hmr` / `ws` off, no dependency scan,
  every module invalidated per page request): `public/` is served first at every address — `/@vite/`, `/@fs/`, `/@id/`,
  `/@react-refresh`, `/node_modules/`, `/src/`, `/vite.config.js`, `/package.json`, `/_app/` included — then the pages at their
  address and their file (`/` and `/index.html`), a folder page without its slash → 301, the copy's 404 page, GET / HEAD only.
  The page is rendered by the same `render` + `finish-page.js` as the build: dev = build byte for byte.
- Wired: `behavior/preserve/stage.js CONVERTERS` (React + Vite and Next.js share one branch; the export folder `dist/` / `out/`
  is served as static files with host headers).
- Tests: `convert-react-build.test.js` 6/6 (no browser, real toolchain: the build, the check, comments + prolog, dev byte for byte
  at every page address, the reserved addresses, an edit shown on reload), `convert-document` 10, `copy-served` 4, `copy-notes` 3,
  `copy-deploy-commands` 9 pass. **Browser tests (2026-10-25, one at a time):** `convert-react` 6/6, `full-flow` (React + Vite) pass,
  `convert-next` 4/4, `convert-next-dev` 3/3, `reaudit-stack` 6/6, `copy-page-counts` 3/3; full suite not run.
- **Live proof, nyaayai homepage** (`remastly-live-results/nyaayai/react-convert/RESULTS.md`): visual 0.26 % at 1440 / 0.19 % at
  390, same heights; Lighthouse medians phone 75/84/100/85 → 88/94/100/85, computer 81/84/100/85 → 96/94/100/85; hovers 14/14,
  clicks 1/1, reveals 84/85, loops 18/18, feed 3030 vs 3040 ms; no console error, nothing leaves the copy; 17 components,
  17 raw fallbacks (body `<link>`s + an async script); `npm run dev` = build byte for byte (488 files + the page).
- **Open, not decided**: a fresh lift leaves nyaayai's botza chat script out (chat-widget rule, `extract.js scriptCandidates`),
  while the earlier Next.js copy kept it and botza refused it (domain lock). Same pixels; which one is wanted is the user's call.

### MERN writer (branch `convert-mern`, from `convert-react` 8b3ad1a, 2026-10-25) — done, browser tests and live proof passed

- `server/src/recreate/convert/mern.js`: `client/` = the React + Vite conversion, `convertToReact` called as it is (no change to
  the React writer or the shared core); `server/` = an Express server (`convert/mern/server/`: `app.js`, `site.js`, `match.js`,
  `index.js`, `dev.js`, `open-store.js`, plus `forms.js` / `store.js` / `limiter.js` of the MERN template; `headers.js` written from
  `copy/securityHeaders.js`). Root `package.json`: `install:all`, `dev`, `build` (= the client's build), `start`; deps express +
  mongodb only. Built with the `mern` toolchain (`buildConvertedMern`, steps read from the client's own build script).
- Serving (`site.js`): the rules of the static server the React build is measured on (`serveCopy`): folder → 301, clean URLs,
  pages / sw.js `no-cache`, the rest a year, brotli / gzip from a cache; the copy's files answer first at every address
  (`/api/health`, `/api/forms/…`, `/thanks` and Vite's included; a POST still reaches the API); the copy's 404 page; the security
  headers, no CSP (the original's scripts run). `npm run dev` = the same app with `client/public` + pages rendered by the client's
  `entry-server.jsx` (Vite only loads components): byte for byte the build.
- Forms (`planForms`): own server (no action, relative, the original's host) → wired; another service, mailto, script, and own
  forms `describeForm` refuses (GET / search, password, file) → not stored, said why. The pages stay identical: `client/public/
  sas-forms.json` gets `endpoint: /api/forms`, so the copy's form guard sends the fields there; the server finds the form by
  Referer page + field names (`match.js`); without script a relative action posts to this server too (303 → /thanks). Report:
  `asIs.convert.forms[]` with `wired`, `goesTo`, `note` (plain words), `wiredForms`; `needsAPerson` counts only the unwired;
  DEPLOY.md says "N forms are saved in MongoDB" (`deployMd formsSaved`); the zip ships the source, not `client/dist`.
- Wired: `stage.js CONVERTERS.mern` (`runs: 'server'`): checked on its own server (`startStack(..., { env: { FORMS_STORE: 'memory' } })`),
  headers counted as the server's. A failure packages as before (`packLifted`).
- Tests: `convert-mern-build.test.js` 8/8 (no browser). **Browser tests (2026-10-25, one at a time, after merging convert-react
  2dcf29f):** `convert-mern` 6/6, `full-flow` (`SAS_FLOW_STACKS=mern`) pass, `preserve-forms` 3/3, `convert-react` 5/5,
  `convert-next` 4/4, `preserve-completion-same-origin` / `preserve-complete` / `preserve-ranged` pass; full suite not run.
  `convert-mern.test.js` now builds its copy like `convert-react.test.js` (the fixture as served, about.html left to the lift).
  `full-flow`: a failed flow is reported before the extra "Compare now" check; `SAS_FLOW_KEEP=1` keeps the data folder.
- **Found by full-flow and fixed (shared core, `behavior/preserve/complete.js serviceWorkerSource`)**: the copy's service worker
  answered "404 not in this copy" for every address of the original's host that is not one of the copy's files, also on the copy's
  own address. A copy deployed at the original's domain (or on the same host name, as in tests) therefore had its own form endpoint
  (MERN `/api/forms`, or a FORM_ENDPOINT on the same site) refused. The copy's own origin is now left to the copy's own server;
  the original's other addresses are still refused. Test `preserve-sw-own-origin.test.js` (no browser).
- **Live proof, nyaayai homepage** (`remastly-live-results/nyaayai/mern-convert/RESULTS.md`, run on its own Express server):
  visual 0.26 % / 0.19 %, same heights; Lighthouse medians of 3 against the live original phone 61/84/100/85 → 90/94/100/85,
  computer 84/84/100/85 → 96/94/100/85; hovers 14/14, clicks 2/2, reveals 85/85, loops 19/19, feed 3030 vs 3050 ms; no console
  error, nothing leaves the copy; the 3 newsletter forms wired to `/api/forms` and one stored by the check; `npm run dev` = build
  byte for byte (486 files + the page). Re-audit rows the same as the React run.

### Forms of another service go to it in the download; the zip keeps the original's node_modules paths (2026-10-25, `convert-mern`)

User decision: a form that posts to another service (a form service, a newsletter, a CRM) must post there in the downloaded copy,
exactly as on the original, in every stack; the guard holds forms only in the app's preview and in our checks.
- **Guard** (`complete.js FORM_GUARD`, now readable source): it decides synchronously from the form's action (the submit
  button's `formaction` first). Another host, or `mailto:` / `tel:` → not intercepted, so the browser and the page's own script send it.
  No action, a relative one, this site, or the original's host (`sas-forms.json originalHosts`, written by `registerServiceWorker({
  siteUrl })` without touching an endpoint the owner set), or `javascript:` → held as before (FORM_ENDPOINT, or "not connected
  yet"). If the form is submitted before the settings have loaded, it is held and then sent again with `requestSubmit`. While
  `window.__sasHoldForms` is set (`HOLD_FORMS`) a service form is held and says "Held in this preview: the downloaded copy sends
  this form to <host>".
- **Held in**: the preview shim (`previewShim.js`), every copy-side check context (`check.js isolated`), the completion passes
  (`complete.js`), and the re-audit's motion / click probe (`reaudit/motion.js`).
- **Report per form** (`copy/formRoutes.js`: `formDestination` moved here from `convert/mern.js`, which re-exports it, plus
  `formRoute`, `formRoutesOfCopy`, `formCounts`, `formsReadmeSection`): `report.asIs.formRoutes[]` gives `goesTo` = service | mail-app |
  endpoint | not-connected | as-original (MERN adds copy-server / not-stored) and a plain-words `note`, for every stack.
  `needsAPerson` counts only not-connected / not-stored forms. It is shown in the HTML README, the packaged-stack READMEs
  (`pack.js`), DEPLOY.md (`deploy.js formLines`), the report (`render.js`) and the app (`AsIsReport.jsx`).
  `convert/document.js formsOf` (shared core) uses `formRoute` for its note and gains `goesTo`; `worksWithoutOriginal`
  keeps its meaning. A page without the guard keeps the old as-original wording.
- **Zip** (`export/zip.js projectOwnFile` / `packagesOf`): node_modules / .ssr / .next / dist / out are left out only directly
  inside one of the project's own packages (the project, `client/` or `server/` with a package.json). An original's
  `/node_modules/…` or `/dist/…` file is kept (in public/, site-files/, client/public/, or a plain HTML copy's folder). Before
  this, a plain HTML as-is copy also lost the original's /dist/ and /out/ files.
- **Limit**: a form with no service action whose own script posts to a service (by fetch from a submit handler) is held as
  the original's own server's form.
- Tests (no browser): `form-guard.test.js` 7/7 (the guard's own source in a stand-in page), `zip-project-files.test.js` 2/2
  (every stack). Browser: `preserve-forms.test.js` 3/3, `convert-mern.test.js` forms test pass (2026-10-25).

### nyaayai's "What is Nyaay AI?" chat bar missing in the copy (botza.panscience.xyz, 2026-10-25): the service's domain allow-list

- The copy keeps the widget's script exactly (`<script src="https://botza.panscience.xyz/widget/chatbot-widget.js">`, answered
  200). The widget then asks `GET /api/chatbot/w/cfg/<id>` with `Content-Type: application/json`, so the browser sends a
  preflight first. botza answers `Origin: https://www.nyaayai.com` with 204 + `Access-Control-Allow-Origin: https://www.nyaayai.com`;
  any other origin (the copy's, or a plain new domain) gets **500 `{"message":"Not allowed by CORS"}`**. Not a copy fault.
- Reported generically (`recreate/behavior/preserve/domainLock.js`, run by `stage.js` after the checks): the copy's page is
  opened with the network on, every failing request to another site is asked again server-side as the original's domain (and its
  www. twin) and as another domain; allowed for the first and refused for the second = an open item (reason a) "This part (<host>)
  only loads on the original's domain. It will appear once your new domain is allowed in that service's settings." Test:
  `copy-domain-lock.test.js`.

## Deploy guide: open points (2026-10-25)

Fixed on `accounts` after the guide was merged (both were "Known risks" in it, now updated there):
- **Per-address limits behind Caddy.** Express now believes `X-Forwarded-For` only from the proxies `SAS_TRUST_PROXY` names,
  default `loopback` (Caddy on the same machine); nobody else can choose their address, and a value that would let them
  (`true`, a hop count, a typo) stops the server at start (`config/index.js trustProxySetting`). Sign-ups and failed sign-ins
  are counted per real visitor again; OTP checks are counted per session, as before. Test `trust-proxy.test.js`.
- **Fixed stack-preview ports 4501–4503.** Each run of an as-is stack server gets a free port picked for it
  (`preserve/serveStack.js startStack`); a port another server holds is never taken for the copy (it is detected and another
  port is tried, at most 3). Two jobs side by side (`SAS_MAX_JOBS` ≥ 2) no longer meet. Test `stack-ports.test.js`.

Still open, decided when the server is set up:
1. **Lighthouse's Chromium sandbox on Ubuntu 24.04** (DEPLOY-TOOL.md step 4). Playwright starts its browsers with
   `--no-sandbox`, but Lighthouse's Chrome is started by `chrome-launcher` without it (`audit/lighthouse/worker.js`), and 24.04
   restricts the user namespaces Chromium's sandbox needs (AppArmor). Untested on a real 24.04 server: run the one-line check in
   the guide as the `sas` user; if it fails, add the AppArmor profile the guide gives. Never fix it by turning the sandbox off.
2. **First-start order.** The guide's order matters and has not been rehearsed end to end on a fresh server: install, set the
   `.env`, `npm run db:migrate -w server` (creates the owner from `SAS_OWNER_EMAIL`; with accounts on the server refuses to
   start before it), `npm run mail:test`, then start the API, then Caddy (DNS must point at the server first, for the
   certificate). Do it once on the real server following the guide line by line, and fix the guide where it differs.
3. **Which branch, and which git remote.** The guide uses `<tool-repo-url>` / `<tag>` placeholders (the site is in `website/`
   since the `monorepo` branch, so there is no site repository to name). The
   launch work (accounts, data lock, job limits, cleanup, production refusal, the two fixes above) is on `accounts`; nothing has
   been pushed. Decide the launch branch (merge `accounts` into `main`, or deploy a tag of `accounts`), the remote it is pushed
   to and who can read it, then fill the placeholders.

Checked against the conversions (2026-10-25, after `convert-react` was merged; DEPLOY-TOOL.md steps 1, 4 and 14 updated):
- **Toolchains are found only at `<release>/server/toolchains/<id>/node_modules`** (`config/paths.js toolchainDir`). That is
  a plain folder; the links to `Website-Audit-exact` in the worktrees are a development shortcut, so a server just runs
  `npm run setup:toolchains -w server -- react-vite next mern` in each release. No code change needed for that.
- **Locked (done after this check)**: `server/toolchains/<id>/package-lock.json` committed for next, react-vite and mern,
  written with `npm install --package-lock-only --ignore-scripts --before=2026-10-11` (releases at least two weeks old);
  `setup:toolchains` runs `npm ci --ignore-scripts` (a `node_modules` link is removed as a link first, never emptied);
  `toolchainStatus` = `lockedInstall`: every locked package at its place and version, lockfile in step with package.json and
  its `overrides`, optional native builds for other systems may be absent. Test `toolchain-lock.test.js` (4, no browser).
  This worktree (`accounts`) now has real installs, not links to `Website-Audit-exact` (whose shared installs were
  1–4 packages newer than the lock: caniuse-lite, electron-to-chromium, postcss, qs). The other worktrees still link there,
  so their status now reads "not installed as locked" until they run the setup.
- **Downloads ship the lockfile too (2026-10-25)**: `toolchains/lockfile.js` cuts a `package-lock.json` for every package of a
  downloaded project (top, `client/`, `server/`) from the toolchain's lockfile: the project's direct packages and all they pull
  in, at the toolchain's place, version and integrity, with npm's dev / optional / devOptional / peer flags recomputed for
  the project and npm's own key order. No npm, no network. Written in `behavior/preserve/stage.js` (as-is: converted or
  packed, `report.asIs.lockfiles`) and `export/fromIr.js` (clean stacks, `outputs[stack].lockfiles`); a package the toolchains
  do not hold at its pinned version fails the job rather than ship an unlocked download. READMEs, `install:all` and DEPLOY.md
  (`deploy.js describePackage().locked`) say `npm ci`. Checked on all 11 packages the writers produce (3 converted incl. the
  MERN client, 3 packed, 3 clean incl. MERN client + server): `npm ci --offline` installs each, `npm install --package-lock-only`
  rewrites each lockfile byte for byte the same, and the 3 converted projects build with `npm run build` from that install.
  Tests: `download-lockfiles.test.js` (8), `copy-deploy-commands.test.js` (lockfile ships, no `npm install`), no browser.
- **Disk**: a converted copy adds the as-is copy again in the stack project (React + Vite +75 MB, MERN +75 MB, Next.js +75 MB
  on nyaayai's 85 MB copy). Next.js's `.next/` (71 MB) used to stay in the copy's folder until retention; it is now removed
  once the copy is built and checked (`stage.js` finally, after the servers stop: `next start` of a packed copy reads it),
  `convert/next.js dropBuildFolder`. Nothing later needs it: the preview and re-audit serve `out/` (`public/` packed), the
  zip already left it out, "Package again" converts and builds again from the kept as-is copy. Test
  `convert-next-no-build-folder.test.js` (3, no browser): after removing it, `npm run dev` serves both pages byte for byte as
  `out/`, and `npm run build` writes the same `out/` again.
  Toolchains ~0.45 GB per release (next 321 MB). Memory: a build is ~0.3–0.4 GB extra for under half a minute on one page
  (coarse samples); not measured on many pages.
- No new setting or system package: builds run with a fixed minimal environment (`build/toolchain.js`).
- MERN conversion (`convert-mern`, merged into `accounts` in eabadb9) does not change the toolchains.
- **Copy my site, faster with the same result (2026-10-25)** — only changes that cannot alter what is copied or measured:
  - *Pictures decoded once per comparison*: `check.js gateVerdict` compares each picture three times, and `exactDiff` read it
    band by band through a fresh sharp pipeline every time. Each picture is now decoded once (`pixels.js decodePicture`,
    within `DECODED_BUDGET_BYTES` 512 MB; past it, the band path as before). Proof: the saved original pictures of nyaayai,
    parchaa and sankalpam (`remastly-live-results/*/recreate/as-is/baseline`), 21 verdicts (3×3 gates at 1440 and 390, both
    colour thresholds, 3-vs-capture, a width mismatch, masked areas): every result deep-equal to the old code, six runs.
    The 15 gate verdicts, median of 3: 78.2 s → 24.4 s; per copied page (visual 1440 + 390 + fix gate) nyaayai −15 s,
    sankalpam −10 s, parchaa −6 s.
  - *Lift and referenced files downloaded 6 at once* (`preserve/prefetch.js`, `AT_ONCE` 6): `pageLift.js` lists, before each
    loop, the files the loop will download (the same filters as `localize`) and starts them ahead; the loop still takes
    each result in its own order, so names, hashes and the manifest are decided exactly as before. `referenced.js` does the
    same per round, within its file budget. Proof: the kept captures of parchaa, nyaayai and sankalpam lifted with the old
    and the new code, back to back: every file's sha256 (216 / 475 / 95 files), the lift result, the manifest and the
    referenced result deep-equal. Times: parchaa lift 28.1 → 18.4 s, referenced 10.9 → 3.6 s; sankalpam lift 12.8 → 2.8 s;
    nyaayai referenced ~14 → ~4 s, its lift unchanged (~90 s: one 6400 px PNG, bandwidth-bound either way).
  - *No whole crawl when the as-is pages are chosen* (`discover.js`, `crawl({ only })`): only the chosen pages are fetched,
    and that result is used only when the whole crawl's answer is fixed in advance: every chosen page in the crawl's first
    queue (homepage link, analysis page or sitemap, all queued before the first fetch and started in order) at a place the
    budget reaches (`firstQueue`), fetched without a redirect. Otherwise (deeper page, past the budget, redirect, robots
    block, stopped) the whole crawl runs as before. Proof: `discoverPages` old vs new on nyaayai, parchaa, sankalpam and
    gardener with four page sets each (homepage; + 2 linked pages; + the deepest page; + every page found): all 16 results
    deep-equal (pages with url / outPath / slug / source / depth / flags, skipped, beyondLimit, sitemap, robots, llms).
    nyaayai 14–20 → 1–3 pages fetched (~2 s → ~0.8 s), parchaa 10 → 1–3; "every page" fell back on both. A few seconds per
    copy on these sites; more on a client-rendered site, whose crawl renders its pages in the browser.
- **Full suite before the merge to main (2026-10-25, not finished)** — logs and lists in
  `C:\Users\urvas\Downloads\remastly-live-results\suite\`. First run: 70 of 192 files done, 1 failure, a stale test
  (`recreate-exact`: its fixture put the image under the faint text; fixed in ebb4fa2, 14/14). The other 122 files in
  batches of 15: batches 1–4 (60 files) and 7 (15) passed, 0 failures; 5 tests skipped on purpose (the axe-based
  contrast fixer set aside by the PR #1 merge 283b108, "follow-up: compare with main-before-merge").
  Batch 5 failed 35 tests only because the cleanup closed its browsers while it ran (Claude Code's memory guard had killed
  the driver, not the node runner, which went on): all "browser has been closed", not real. Batch 6: 3 real failures,
  most likely stale tests, not fixed yet: `recreate-mern` / `recreate-next` "real export" fetch the preview's path
  `/preview/<token>/…` as a full address (previews moved under the app's address on 2026-10-24), and the Next zip test
  does not expect `DEPLOY.md`. Batch 8 was cut off.
  **Completed 2026-10-26** (`suite\day2\`): the last 34 files (`suite\remaining.txt`), the 22 browser files alone 5 at a
  time, then the 12 others: 270 passed, 4 failed, all stale tests, none a bug, updated in 848db63 (no code changed):
  `recreate-generate`, `recreate-mern`, `recreate-next` still treated a preview as a server of its own (a port, an
  absolute URL); since 6b2cdbf it is a path under the app's address, its pages served with their addresses moved under
  `/preview/<token>/`, and `script-src` names the app's address (a sandboxed page has no 'self'). The Next zip test did
  not expect `DEPLOY.md`, in every download since c7fa9a4. After the updates: 13/13, 6/6, 12/12. **All 192 files have now
  run; no failure is left.** Still open: the 5 skipped contrast-fixer tests above (before or after the merge to main).
  How to run batches: `SAS_TEST_BROWSER_CONCURRENCY=1 node test/run-tests.js <files>` from `server/`, browser files alone;
  `suite\batches.sh` waits until no runner is left before `suite\cleanup-tests.ps1` closes leftovers (only Playwright's
  Chromium and this worktree's test node processes).

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
7. **DONE (L2: 1b7e222, c61e005) — the database and a second process** (user, 2026-10-24; the gotcha under "Where things are
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

## Branch `owner-options` (worktree `../Website-Audit-owner`, from `step4-lighthouse` fc059a4), 2026-10-24

Done in parallel with the step-4b session; nothing pushed; full suite not run (one test file at a time, `npx vite build`).
1. **PARKED 7 fixed (4dbd6db)**: `routes/recreate.js EXACT_FILE` and the folder picker have their backslashes back; `recreate-exact-route.test.js`
   requests one file of every kind the comparison writes (names from `bandFile` / `copyBand` / `mapFile` / `cropFile`) and bad names. Only an
   exact-mode run shows that table, so ordinary copies never saw the 404s. A sweep (regex literals with a bare `d{`, `s+`, `w+`, an unescaped
   `.ext$`) over `server/src`, `client/src`, `scripts` found nothing else.
2. **New-site address optional (20bb9a0)**: the Copy panel and the settings dialog accept an empty address and say what the copy does without
   one (as-is: canonical / robots.txt kept as lifted, no sitemap.xml, an open item "new-site address"; clean: the original's address written
   and a report warning). The Create step asks once before the first copy, then starts at once. Server unchanged (already optional).
3. **Owner-only options, enforced on the server** (see `docs/ACCOUNTS.md` "Owner-only options"): `accounts/roles.js isOwner / refuseNonOwner`;
   `routes/recreate.js ownerOnlyOptions`, `routes/projects.js ownerOnlySettings`, POST …/export; **`NODE_ENV=production` refuses to start
   with accounts off** (`config/index.js startupProblems`). App: `store.me` / `selectIsOwner`; the Create step's "Advanced options" and the
   Results step's build-another-stack picker draw for the owner only; an ordinary user with an as-is copy gets "Rebuild from the last visit"
   (`reuseAsIs`, text says it shows the site as it was then). The engines are untouched: `recreate/index.js` runs clean / exact / as-is from
   the payload for any caller — the route, `recreate/jobs.js autoResume`, and the per-page fallback, which will call them from
   `copy/run.js checkPage` (`deps.rebuildClean`, `deps.correct` → the clean pipeline and `verify/exact/correct.js`) in-process, never through
   the route. Tests: `owner-options.test.js` (6).
4. **Task 4 — read-only re-score of the published "visual match" 93 (collateral) and 98 (indikaai)**, 2026-10-24. What the two
   numbers are (from `remastly-website/lib/content.ts`): collateral's 93 = the **homepage view score** of exact run 3019a275
   (13 Oct; `fidelity.pages['/'].views.desktop.score` and `.mobile.score` = 93: 35 % sizes 0.97 + 25 % boxes 0.99 + 40 % `visual`
   0.856; the site score is 96, the SSIM diff 93); indikaai's 98 = **`fidelity.score`** of exact run f6035800 (15 Oct; `visual`
   0.996–0.998 per view, diff 98–99). Both rulers tolerate what the question names: `verify/layout.js visualSimilarity` shrinks both
   pictures to 96 px wide and counts a pixel as the same when its largest channel difference is ≤ 32 levels (`COLOR_TOLERANCE`), to
   3 decimals of the page; `verify/visualDiff.js` is SSIM on luma at 384 / 96 px with a colour factor free up to 12 levels.
   **How**: a scratch copy of the real `app.db` (+ WAL) and of collateral's run folder (`capture/<slug>/<view>-full.webp`,
   `fidelity/<slug>/<view>-full.webp`, `report.json`), re-scored with the pipeline's own functions plus `verify/exact/pixels.js
   exactDiff` (YIQ distance, threshold 0.1, antialiased edges set aside, every pixel) on every page × view (12 pages × 5 views);
   the phone pictures of the capture are DPR 2 and the fidelity render DPR 1, so the larger was scaled to the other's width first
   (Lanczos; an approximation, so said). Script and full table kept in `C:/Users/urvas/Downloads/remastly-live-results/collateral-rescore-2026-10-24/`.
   Scratch copies deleted afterwards; nothing written to the real data or the marketing site.
   **Collateral, real figures** (stored → re-run → exact ruler): homepage desktop visual 0.856 → 0.862, exact **11.36 %** differing
   pixels; mobile 0.857 → 0.862, exact 11.25 %; tablet 0.826, exact 15.5 %; laptop 0.879, exact 9.4 %; large-phone 0.907, exact 8.3 %.
   With the exact ruler in the 40 % visual slot the homepage reads **94** on desktop and mobile (published 93): the 96-px ruler
   counted slightly *more* difference (13.8 %) than the pixel-exact one (11.4 %), because a shifted block blurs across more
   thumbnail pixels. Site-wide: stored 96 → 96.55 with the exact ruler; exact % per view: desktop 2.4, laptop 2.4, tablet 3.5,
   large-phone 3.5, mobile 4.5 (mean 3.25 %); the SSIM diff 93 re-runs as 93.7. **So the 93 is not overstated by the rounding or
   the 32-level tolerance** (the tolerance is the same size as the slack the exact ruler gives, and the layout half of the score
   dominates). What *is* true: it is a layout-and-thumbnail composite, not a pixel figure; the same run's exact engine (one recipe
   both sides, the copy's script on, 252 slots) measured **diffMean 5.3 %, worst 21.1 %, 0 of 252 slots accepted** (homepage 1440:
   0.90 %, 375: 1.09 %, 1920: 5.9 %, 639: 16.0 %). A pixel claim for that copy is "≈ 1 % at 1440 and 375, up to 16–21 % at
   in-between widths", not 93 of 100.
   **Indikaai: not re-scorable.** The pictures of f6035800 exist in no store (the real data has only the 23 Oct as-is copy of a new
   project id and a failed clean one; `sas-corpus` keeps indikaai runs 092a894e and 938bd167 only; `sas-work` the same as real) —
   retention keeps two recreates per project. Only the marketing site's crops of its first screen survive
   (`public/shots/indikaai-original.webp` / `-copy.webp`, 900 × 563, cut from that run's `capture/index/exact` and
   `fidelity/index/exact` per `docs/redesign-notes.md`): exactDiff **0.0116 %** (59 pixels) on that first screen. With `visual`
   0.996 at 96 px the whole page could hide at most changes ≤ 32 levels per channel or thinner than ~4 CSS px at 375 wide; nothing
   can be said about them without the pictures. The 98 is neither confirmed nor refuted beyond its first screen.

## Branch `job-lock` (same worktree, from `owner-options` cc1afba), 2026-10-24 — one server per data folder, jobs judged by heartbeat

Why: jobs live in the memory of the process that runs them, and `db/index.js` used to mark every queued / running row failed
**at import** — a second server, or any script importing the module, killed the bookkeeping of a live job and `autoResume` then
adopted (renamed) its workspace. Two servers on one `app.db` would also prune each other's recreate folders. Both are closed, generically:
- **Heartbeat** (`jobs/liveness.js`, column `heartbeat_at TEXT` on `analyses` / `recreates` / `reaudits`, idempotent `addColumn`):
  `JobManager` writes it with the row and then every **`HEARTBEAT_MS` = 15 s** while the job is queued or running (through the wait
  for the global lock), `clearInterval` once the row is final; `ownJobs` is the set of ids this process runs. A row is **stale**
  after **`STALE_MS` = 120 s** without a beat, or with none at all (written by an older server). `adoptStaleJobs()` marks stale rows
  failed with the old text ("The server restarted while this job was running. Run it again." — the app's `copy.js` knows that
  case) with a conditional write (`COALESCE(heartbeat_at,'') = <the value read>`), so a beat between read and write keeps the
  job; rows with a fresh heartbeat are counted (`alive`) and never touched, so their workspace is never adopted or renamed.
  **Why 15 s / 120 s**: a beat is one tiny WAL write, so 15 s is free; 120 s = 8 missed beats, longer than any event-loop stall a
  live process has shown here (5–10 s freezes on an overloaded laptop; the interrupts watcher counts sleep from 30 s), short
  enough that a crashed server's job is picked up within ~2–4 min of the next start. Laptop sleep suspends every process on the
  machine together, so it cannot make a live job look stale to a server started on wake (and the lock refuses one anyway).
- **Who decides**: `src/index.js` only — `recoverStaleJobs()` (`recreate/jobs.js`: adopt + `resumeInterruptedRecreates(rows)` for
  the recreates among them) once the server listens, then `watchStaleJobs()` every `STALE_MS`. `db/index.js` touches no job row;
  `interruptedRecreates` is gone (`resumeInterruptedRecreates` now takes its rows). A script that imports the module to read a
  database triggers nothing.
- **Lock file** (`config/dataLock.js`, `<DATA_DIR>/server.lock` = `{ pid, host, startedAt, port }`): `holdDataLock()` in
  `src/index.js` before the migrations check; created atomically (`wx`), touched every 15 s, removed on `process.exit` (the
  SIGINT / SIGTERM shutdown goes through it) only while it still names our pid. A second server exits 1 with
  "Not starting: Another server is already using the data folder <dir> (process <pid> on <host>, port <p>, started <t>). Stop it
  first, or give this server its own folder with SAS_DATA_DIR. If no server is running there …, delete <file> and start again."
  Recovery: same host → the lock is held while that pid is alive (`process.kill(pid, 0)`; a crash / kill -9 / TerminateProcess
  leaves the file and the next start takes it over; a reused pid is the one blind spot, hence the message); another host (shared
  disk) → held while the file was touched within `LOCK_STALE_MS` = 120 s. Unreadable file = nobody's. Only the server takes it:
  scripts, `db:migrate` and tests never do (`scripts/dev.js` kills the old child and awaits its exit before starting the next, so
  the dev loop sees a dead pid and takes over).
  **Containers (second commit)**: a restarted container often gets the same pid (1) and a new hostname, so (1) the lock carries a
  random **`INSTANCE_ID`** made at start, and that id alone says whether the file is ours when it is touched (`refresh`, false and a
  one-time warning when another instance holds it now) or released (`release`, never another's); (2) a lock **naming our own pid**
  cannot be a live process (we have not written one yet) and is taken over at once, whatever host it names; (3) a lock from
  **another host** (replaced container, shared disk) blocks at most `LOCK_STALE_MS` = 120 s after it was last touched, and the
  refusal says that its server cannot be checked from here, when the lock expires ("expires N s from now"), and that deleting the
  file starts now — so a restart policy that starts the container again gets through within two minutes. Stated trade-off of
  (2): two live containers that are both pid 1 on one shared volume would take each other's lock over; that is the
  misconfiguration the lock exists for, and the job heartbeat (`jobs/liveness.js`) still keeps either one's jobs from being
  marked failed by the other.
- Tests: `test/job-lock.test.js` (7): a child process holds the lock → refused with pid and file named → killed like a crash →
  taken over; a foreign-host lock fresh / stale / garbage, and release never removing another's; **two real `src/index.js`
  servers on one scratch data folder** (B exits 1 naming A, A still answers, A killed → C starts and holds the lock); heartbeat
  written while queued and running and stopping with the job, `isStale` rules, a live job never marked from "outside" and own
  jobs never judged; startup recovery marking only the stale and heartbeat-less rows while a live running and a live queued row
  and the live job's `.tmp` workspace stay untouched, then the same job continued once its heartbeat ages out; the read-after-beat
  race; a second process importing `db/index.js` marking nothing and taking no lock. Also run: `recreate-jobs` 15, `recreate-resume`
  7, `keep-awake` 2, `perf` 10, `stage0` 8, `stage2` 9, `stage3-signout` 2. Full suite not run.

## Launch readiness — job limits (branch `job-lock`, Task A, 2026-10-24)

Hosting is not decided, so every limit is an env setting read at call time (`server/src/jobs/limits.js`, documented in
`server/.env.example`); one job uses several GB and two at once took a 15 GB machine down, so the defaults are one at a time.
- **`SAS_MAX_JOBS`** (1–8, default 1): jobs running at once on this server. `jobs/manager.js` replaced the strict serial chain by one
  FIFO line with that many slots, for every kind (Analyze, Recreate, Re-audit and the stack exports that use `exclusive()` directly);
  order is never changed. `lockBusy()` / keep-awake unchanged.
- **`SAS_JOBS_PER_USER`** (1–20, default 1): running or waiting jobs one account may have, counted across kinds by the project's
  `owner_id`; a second start is refused with `JobLimitError` → 409 `{ error, limit: 'user', busy: { kind, projectId, jobId } }` (no
  `analysisId` / `recreateId` key, so the app shows the sentence instead of following a job). With accounts off everyone is the one
  local user (owner null), so the cap is the whole queue's depth there — raise it to queue several sites. The server's own follow-up
  jobs (`{ system: true }`: the resume after a restart, the re-audit after a copy) are not counted against the account; owner
  accounts follow the same caps (nothing reads the role).
- **Place in line**: a waiting job's `message` says "Next in line: starts when the job before it finishes." or "Waiting in line: N jobs
  run or wait before this one.", pushed over the same SSE path on every change, and the snapshot carries `queue: { ahead, position,
  memory? }` while queued. `AnalyzeProgress.jsx` shows the server's sentence when queued.
- **`SAS_JOB_MAX_MINUTES`** (1–1440, default **240**, was 480 until the hold-up review below; 0 = none): the hard limit of one running
  job, above every pipeline's own budget (Analyze 6 min × scale ≤ 30, Recreate 12 min / `SAS_RECREATE_MINUTES` ≤ 60 or per-page limits
  for every page, an as-is copy 20 min per page + 10 per stack, exact mode none): 240 covers every fixed budget, every real run recorded
  (longest 146 min) and an as-is copy of up to 11 pages at its budget rate; with one job at a time it is also the longest anyone waits
  behind one job. A larger site needs it raised or 0, and the row's error names the setting. When it
  hits, the job is asked to stop exactly like the app's Stop (`controller.abort()`: Recreate saves its checkpoint, `reason: 'stopped'`,
  "Continue where it stopped" works; Analyze and Re-audit now take `signal` and end at their next step, their browser and proxy
  closing on the way out), the row reads "Stopped after N minutes: the time limit for one job (SAS_JOB_MAX_MINUTES). What was
  finished is kept.", and a run that has not ended `TIMING.hardStopGraceMs` = 60 s later loses its slot anyway (row closed, next job
  starts, the late end logged, never written over the row).
- **`SAS_JOB_MIN_FREE_MB`** (default 2048; 0 = no check): free memory the first job in line needs before it starts, looked at again
  every 5 s (`TIMING.memoryPollMs`); meanwhile its message reads "Waiting for memory: X MB free, Y MB needed…". The line keeps its
  order (a small job never jumps a large one). A job that waited for memory longer than the hard limit fails with the reason
  instead of stalling the queue silently. 2 GB = the pipeline's own rules for one job (`audit/resources.js`: 150 MB × 4 contexts,
  300 MB kept free, 900 MB before a second browser) plus Lighthouse's Chrome; macOS reports "unknown" and is never gated.
- **With the heartbeat and the lock**: a queued job beats from the moment its row exists; the row keeps `payload_json`
  (`{ payload, warnings, system }`, new column) so a queued job of a dead server is put **back in line in `started_at` order with
  the same row** (`requeueJobs` → `manager.requeue`, the row claimed by a conditional heartbeat write, `liveness.js claimQueued`, so
  two servers can never both take it); a queued row without a payload (older server) is failed like a running one. `GET /api/health`
  reports `jobs: { running, waiting, max, freeMB?, limits }`, and the start-up log prints the four limits.
- Tests: `test/job-limits.test.js` (6): settings and bounds; FIFO with 1 and 2 slots and the exact sentences and `queue` fields pushed
  to a subscriber; the per-account cap (refusal names the blocking job, another account passes, system jobs not counted, accounts-off
  = one local user, cap 2); the memory gate (held with the sentence, released when memory returns, failed with the reason after the
  hard limit, off at 0); the hard limit on a run that honours the stop and on one that ignores it (slot moves on after the grace
  period, the late end leaves the row alone), 0 = none; the restart requeue (order, same ids, claimed heartbeats, warnings kept, a
  second pass starts nothing twice, a row another server took is left). Also passing: job-lock 10, recreate-jobs 15, recreate-resume 7,
  keep-awake 2, perf 10, owner-options 6, stage0 8, reaudit-stack 6; `npx vite build`. Full suite not run; no browser test.

## Launch readiness — disk cleanup (branch `job-lock`, Task B, 2026-10-24)

**Measured** (read-only, on scratch copies of real data: the 18-project folder `C:\sasd2` and the live-run folder of 2026-10-23/24;
each file counted once, hard links included):

| What | Size | Where it goes |
|---|---|---|
| A finished clean copy (Oct 6–7 runs, 7–30 pages) | 16–235 MB | capture 5–152 MB (the biggest part), fidelity shots 2–41, assets + site + dist 6–35 (hard-linked, counted once), ir 1–3, re-audit raw 1–3; a built stack adds 23–72 MB |
| An as-is copy of one page (nyaayai, 2026-10-23) | 132 MB | its lift `as-is/` 83 MB, capture 9, packed stack 36, re-audit 3 |
| A workspace a crashed job left (`<id>.tmp`) | 10–118 MB | the live folder's: 118 MB, of which **36 MB scratch** (`.lift-tmp` etc.) nothing would have removed |
| An analysis | 1–3 MB | screenshots 0.1–0.4 MB (already kept for the latest 3 only) |
| `lighthouse-original` per website | 3.5 MB | the original's Lighthouse runs, reused by later re-audits |
| Temp folder leftovers on this machine | 26 `sas-cache-*` folders, 15 MB | a job's shared static-file cache, left by every crashed or killed job since 2026-10-16 |

**Policy** (`server/src/jobs/cleanup.js`, env in `server/.env.example`): `SAS_KEEP_COPIES_DAYS` (default **30**; 0 = never by age),
`SAS_CLEANUP_HOURS` (default 6; 0 = start-up and after-job passes only), `SAS_CLEANUP_DRY_RUN=1` (the server's passes only log).
A pass removes exactly four kinds of thing, each with its reason in the log line: (1) scratch inside a copy's folder (`dist.tmp`,
`stacks/*.tmp`, `*.html-ref.tmp`, the as-is stage's `.lift-tmp` / `.fetch` / `.complete-tmp` / `.referenced-tmp` / `unfixed`; never
`capture/.network`, which a rebuild from the capture lifts from again); (2) a `<id>.tmp` workspace whose job is over and cannot be
continued (the one resumable stopped copy is kept for the existing 7 days; a queued or running job's folder is never touched,
whichever process runs it, and a row still open without a heartbeat is left to the job recovery, which runs first); (3) a finished copy
older than the setting that is **not its website's newest finished copy** — the newest is never removed by age, whatever its date
(its row gets `removed_at`, new column, so the record of the job stays); a copy folder no row knows, once still for a day;
(4) `sas-cache-*` / `sas-migrate-*` in the temp folder older than the hard job limit (a day when there is none). Previews of a folder
about to go are stopped first. Analyses are not aged out (the re-audit's baseline; 1–3 MB each). Runs: at start-up after the job
recovery, after every copy (`sweepJobScratch` for that copy, then the existing per-project retention `pruneRecreates`, which keeps the
newest two clean copies / newest output per stack / the lift), and every `SAS_CLEANUP_HOURS`. By hand: `npm run cleanup -w server --
--dry-run` prints the disk table (per website: analyses, copies with their scratch, workspaces; the temp folder) and every item it
would remove or keep with the reason; without the flag it removes, and refuses while a server holds the data folder's lock (it cleans
by itself). Why 30 days: longer than every window the app has (7 days to continue a stopped copy, 7 days before an analysis is called
stale), one plan period, and bounded cost (one extra copy per website for a month: 100 websites × ~100–250 MB = 10–25 GB).
- Tests: `test/cleanup.test.js` (8): settings; `folderSize` counts a hard link once; old copies go and the only / newest copy never does,
  scratch inside a kept copy goes, `capture/.network` stays, rows record the removal, a second pass finds nothing, days = 0 removes
  nothing by age; workspaces (running / own / open-row kept, resumable kept 7 days then removed, dead and unknown removed, a stray
  folder after a day only); the temp folder (hard limit or a day); dry run lists and removes nothing, `SAS_CLEANUP_DRY_RUN` honoured;
  the after-job sweep touches only that copy; `measureDisk`. Also passing after the hooks: recreate-jobs 15, job-lock 10, job-limits 6,
  stage0 8, recreate-resume 7, perf 10. The script was dry-run on a scratch copy of the live data folder. Full suite not run.

### For the hosting discussion — how long a job really takes (measured runs only)

Sources: every finished job row of the two scratch folders above (2026-10-06/07: clean copies with the sweep; 2026-10-23/24: as-is
copies) and the live-results summaries (`remastly-live-results/*/summary.json`). No multi-page as-is copy has been run yet; its
per-page figure below is the pipeline's own budget (`asIsBudgetMs`: 20 min per page + 10 per stack), which the one-page runs match.

| Job | Runs | Typical | Worst | Per page |
|---|---|---|---|---|
| Analyze (whole site, 1–25 pages) | 17 done | 25–160 s (most 21-page runs 25–66 s) | 305 s (parchaa, 10 pages) | ≈ fixed: Lighthouse on the homepage twice; the crawl adds ~5–10 s a page |
| As-is copy (the product; 1 page each) | 3 done | 1023–1164 s (17–19 min) | 1329 s (22 min) | 17–22 min for the first page: discovery + capture 4.5–6 min, lift + completion + checks 11–18 min; **budget 20 min/page** |
| Clean copy, older mode with sweep (10–30 pages) | 7 done | 1407–1802 s (23–30 min) | 8794 s (146 min: nyaayai 30 pages, network stalls in capture) | 73–141 s/page typical, 293 s/page worst |
| Re-audit | 23 done | clean 145–239 s; as-is one page 292–298 s (3 Lighthouse runs × 2 devices × both sides) | 399 s | ≈ fixed; +2–3 s a page |

**Memory per job** (the live log of the sankalpam run, 2026-10-24, free memory sampled every few seconds; the pipeline's own rules in
`audit/resources.js`):

| Measure | Value | Source |
|---|---|---|
| Free memory before / lowest during one as-is copy + re-audit | 5065 MB / 2845 MB → **≈ 2.2 GB used by one job** | `remastly-live-results/sankalpam/final-2026-10-24.log` |
| Server process peak RSS during that run | 702 MB (the rest is Chromium and Lighthouse's Chrome) | same log |
| What the pipeline reserves by its own rules | 150 MB × 4 contexts + 300 MB kept free + 900 MB before a second browser ≈ 1.8 GB | `audit/resources.js`, `recreate/index.js roomForSecondBrowser` |
| Gate before a job starts | `SAS_JOB_MIN_FREE_MB` 2048 | `jobs/limits.js` |
| Two jobs at once | a 15 GB machine crashed (reported by the user; the mode is not recorded) | not measured here |

**The hold-up problem.** With `SAS_MAX_JOBS=1` and a 480-minute backstop, one as-is copy of a 24-page site (480 ÷ 20) would run the full
backstop and every other account would wait 8 hours behind it; the pipeline's own budget ends it there, the limit never fires.
1. **Backstop 240 minutes — applied (default changed 2026-10-24).** It covers every run recorded (the longest, the 146-minute clean copy
   of 30 pages, with room), an as-is copy of up to 11 pages at the budget rate (11 × 20 + 10 = 230 min), Analyze (6) and a re-audit (7)
   many times over. A larger site needs the setting raised or a page cap, and the row says so. The worst wait for the next person
   halves, 480 → 240 min. Page limits and the slot count stay settings (`recreate_pages`, `SAS_MAX_JOBS`); the hosting decision sets them:
2. **A per-plan page limit bounds the wait directly**, because the as-is budget is 20 min a page: 3 pages → a job of at most 70 min,
   5 pages → 110 min, 10 pages → 210 min (the existing `recreate_pages` setting already caps pages; a plan would set it from the
   account). With a 5-page plan and one slot, nobody waits longer than 110 min behind one job, and the typical as-is job stays well
   under it (the measured one-page jobs: 17–22 min).
3. **More slots.** The live log shows free memory falling from 5065 to 2845 MB during one as-is copy (≈ 2.2 GB per job, server peak RSS
   702 MB, the rest Chromium); with `SAS_JOB_MIN_FREE_MB=2048` guarding each start, `SAS_MAX_JOBS=2` is safe on an 8 GB host by those
   numbers and `3` on 16 GB. Two slots mean the second person never waits behind the first, and the third waits for the shorter of two
   jobs; with k jobs of P pages queued behind one slot the last waits ≈ k × 20P min, with two slots about half.
Not measured: an as-is copy of more than one page (the per-page cost after the first page should be lower, discovery and the stack
pack are paid once), and memory with two jobs truly side by side.

## Parchaa re-audit rows (2026-10-24, all three done: hovers, loops, best practices)
- **Hovers 0 of 5 → FIXED** (commit after 116da51): cause as below; fix = the re-audit tells the copy's probe which elements hovered on the original (`hoverFirstFor`: tag|text keys, `captureInteractions({ first })` probes them before everything else, `stats.first/firstProbed`) and `hoverBudgetFor` covers them at `FIRST_MS` 2.5 s each (parchaa 10.5 → 12.5 s). Re-measured on the saved copy: **5 of 5** (`remastly-live-results/parchaa/motion-2026-10-24/first/copy-motion.json`). Tests: `recreate-hover-probe` 4/4, `reaudit-motion` 13/13 (+1 pre-existing skip). Full suite not run.
  Original finding: the copy's hovers work. The re-audit's hover probe got `hoverBudgetFor` = probed × 1.5 s = 10.5 s, spent it on 5 elements that never revert (each waits the scripted settle time) and never reached the five cards; with 60 s it probed 14 and found all 5. Evidence: `remastly-live-results/parchaa/motion-2026-10-24/copy-motion.json`.
- **Loops 14 of 16 → FIXED**: every one of the 16 loop elements moves in the copy (watched 3 s on both sides, same angle ranges: `remastly-live-results/parchaa/motion-2026-10-24/loops-watch.json`); the check was wrong. Four badges rock ~3.5°/s, so a 2.2 s recording covers 5–12° (`loop-evidence.log`), right at the probe's 5° minimum: caught near a turning point a badge fell under it and `captureLoops` dropped it at once instead of watching it longer like the other slow movers. Fix: `movesSlowly()` (`SLOW_FLOOR`: a change above noise but under a channel's minimum) → watched `slowWatchMs` like a `move`. Same code on both sides, so the capture is steadier too. Re-measured: **16 of 16** (`loops-fix/copy-motion.json`). Test: `recreate-loops` 4/4 (+1 rocking badge). Full suite not run.
- **Best practices computer 100 → 96 (`errors-in-console`) → FIXED** (commit after 0893020): one 404 in the copy, `/cms/…/zDzR8K3ip-indexes-default-0.framercms?range=0-120`. The runtime reads a CMS index in byte ranges through a `range=from-to[,from-to]` query (the CDN answers 200 with exactly those bytes; the runtime checks status AND length, so a whole file at the bare path would throw too), and it does so **only for a visitor**: it checks `navigator.webdriver`, which is true in every Playwright visit (the capture, the completion passes, my first console diff) and false under Lighthouse. Evidence: `remastly-live-results/parchaa/motion-2026-10-24/cms-trigger.log` (no Playwright variant — service worker, UA, CPU 4×, 20 s, axe, hovers, Tab, scroll, resize — made the request; hiding `webdriver` did, at 3.1 s), `lh-copy-instrumented-desktop.json` (the project's own Lighthouse: the request at 2.4–3.7 s, 404, BP 0.96). The original scores 100 because its CDN serves every range. Fix, all general (`preserve/ranged.js`): the completion pass opens the copy as a visitor (`VISITOR_SHIM`, only `webdriver`); a same-origin `?range=` request fetches the slice AND the whole file from the original, keeps the whole file only when it holds the slice at those offsets (`answerRanged`; `askOriginal` memoised, one ask per address), and the copy slices it itself — an inline script after the URL shim on a first visit (`rangeShim`, wraps `fetch`, works under the preview shim too) and `sw.js` later (`RANGED`); the lift does the same for a slice found in the record (`pageLift.js ranged`); `report.ranged` + one line in the as-is report; `gotWorse.js` evidence names the case and `hasFileExt` allows 10-letter extensions. **Proof on the saved parchaa copy, re-completed against the live original: both CMS files kept whole (42 739 + 41 886 B, verified), Lighthouse desktop best practices 1.0, `errors-in-console` pass, no CMS 404** (`lh-copy-ranged-desktop.json`, `lh-copy-ranged-desktop-completion.json`). Tests: `preserve-ranged` 2/2 (record + pass, first visit + worker, a host that ignores the query), `preserve-completion-same-origin` 2/2 (updated: its chunk address is a `?range=`), `copy-got-worse` 6/6, `preserve-complete`, `preserve-url-base`, `preserve-asis-preview`, `recreate-lift` pass; client builds. Full suite not run. Limits: only `fetch` from the document is sliced on a first visit (a worker's request waits for the service worker); a copy made before this needs the as-is copy made again.
