# Step 5 — per-page fallback: plan (2026-10-24, awaiting the user's OK; no code yet)

Today a page that fails a check in an as-is copy is listed as "unresolved" (`copy/openItems.js`, marker `·`). The decided design
(docs/COPY-MY-SITE.md §1f, §6): such a page is rebuilt clean in the chosen stack, corrected against the original for a bounded
time, and the better of the two versions is kept. `copy/run.js checkPage` is the tested model of that decision (fakes only); the
engines it needs exist (`recreate/generate.js`, `verify/exact/correct.js`, `reaudit/lighthousePages.js`, `reaudit/measuredHost.js`)
and are called **in-process** — the owner-only check of branch `owner-options` applies to the routes, never to the engines.
Generic only; deploy-ready (Launch readiness L4 / L5 rules).

## 1. When a page counts as failed

The same thresholds the copy already judges by (`copy/thresholds.js pageProblems`), no new numbers:

| check | fails when | measured by (today) |
|---|---|---|
| visual, 1440 and 390 | score < 65, i.e. more than 3.5 % of pixels differ in every pairing outside the noise map | `preserve/check.js visualCheck` in the as-is stage |
| height, each width | off by more than 5 % of the original's | same |
| controls | fewer than all of the original's visible controls behave the same | `clickProfile` |
| hovers | fewer than 90 % of the original's hovers match | `hoverProfile` |
| console | any error the original does not have | `offlineCheck` |
| Lighthouse (homepage) | performance < 50, or SEO / accessibility / best practices below the original's | the stage's homepage run |

Rules on top:
- Only a problem **nobody can explain** triggers the fallback: an item with reason a (third-party), b (backend), c (owner) or e
  (deploy) is not a reason to rebuild — a rebuild cannot bring a chat widget or a login back. The trigger set is the problems whose
  reason is `unresolved` (and later d).
- A page whose lift failed outright (lift blockers, a document that would not store, a page the completion pass left asking the
  original) is a failed page too, even before its checks.
- Order: worst page first (`copy/run.js badness`: number of failing checks, then the visual shortfall), after the fixes and the
  packaging, before the re-audit. At most `MAX_FALLBACK_PAGES` (5) per job; the rest stay as-is and say "not tried: the job's time
  was used by other pages" — an honest marker, not a reason of the spec.
- Lighthouse per page is a **decider** (part 2), not a trigger: measuring every page with Lighthouse before deciding costs 2–6 min a
  page. The homepage's run exists already and stays a trigger.

## 2. How "better" is decided

Both versions are measured **in one pass with the same ruler** the re-audit uses: `pictureRounds` takes three sides at once (as-is
page, rebuilt page, live original), so both copies are compared with the same three pictures of the original and share one noise
map (`gateVerdict`: `exactDiff` at 0.05 + noise map); `clickProfile`, `hoverProfile`, `offlineCheck` on both; Lighthouse on both
through `openMeasuredHost` with `compareLighthousePages` (medians of up to 3 runs, the original's runs cached) on **that page
only**, phone and computer. The as-is page's earlier numbers are not reused: the two are judged minutes apart on the same machine.

The decision, in this order (one ordering, so no two rules can disagree):
1. **Gates a version must pass to be kept at all**: no request leaving the copy (safety), no console error the original does not
   have, and not fewer working controls than the other version. Behaviour first: an as-is page keeps the original's own script, a
   rebuilt page has only our motion script, so a page whose value is its interaction stays as-is unless the rebuild matches it.
2. **Fewer failing checks wins.** The Lighthouse comparison enters here: each category (phone or computer) where a version's median is
   below the original's is one failing check, exactly the re-audit's "got worse" row. So a rebuilt page that is below the original
   in a category where the as-is page is not can never win on that row, and the launch rule "never lower than the original" holds
   for whichever version is kept.
3. **Tie on count: the smaller visual difference wins**, with a margin: within max(0.05 %, 2 × the page's own noise share) the two
   are equal (the same margin idea as `verify/exact/correct.js marginForNoise`).
4. **Still tied: the as-is page wins.** The original's own code beats ours when nothing measurable separates them.

What that means for the asked case, "the rebuilt page looks slightly different but scores higher": if both pass the visual threshold
and the rebuilt page clears a check the as-is page fails (say performance 42 vs 61, or a Lighthouse category the original's own page
is below), the rebuilt page is kept, and the report says in words that it looks 0.8 % different and why it was kept. If the rebuilt
page does **not** pass the visual threshold, it cannot win on any score: a page that does not look like the original is not a copy.

## 3. Time and memory (Launch readiness L4, L5)

- **Per page** `FALLBACK_PAGE_MS` = 12 min, hard, made of: the clean rebuild of that page (IR, its own assets, emit: ≤ 2 min), the
  exact baseline of that page at a **reduced slot list** — the two check widths, the 1440×600 window and the site's own
  breakpoints, ≤ 6 slots instead of ~20 (`slots.js exactSlots({ max })` + a width filter; ≤ 90 s a slot), the correction box of the
  spec (5 min, `correctExact({ deadline })`, which already stops at a deadline and keeps what it accepted), and the decision pass
  (pictures, probes, Lighthouse 2 modes × 1–3 runs). A page that runs out of its box keeps whatever was measured by then; a page
  whose baseline could not be taken (original down) is rebuilt without correction and judged against the saved pictures, said so.
- **Per job** the fallback gets what the as-is budget has left (`asIsBudgetMs` = pages × 20 + 10 min; `SAS_RECREATE_MINUTES` wins when
  set) and never more than `FALLBACK_JOB_MS` = 45 min, whichever is smaller; never `Infinity` (an as-is copy is not an exact run). So a
  very long site adds at most 45 min, 5 pages, to its job.
- **Memory**: the stage's browser, the exact renderer and Lighthouse's Chrome never run at once: the check browser is closed before a
  rebuild, each piece opens and closes its own. Lighthouse runs only when `freeMemoryMB()` leaves 1.5 GB beyond the reserve
  (`resources.js`), else the decision is made without it and the page says "Lighthouse not compared: not enough memory". `PAGE_MB`
  150 per context stays the unit. The live proof measures peak RSS of the job for HANDOFF L4 (two jobs once crashed a 15 GB machine).

## 4. How the rebuilt page fits into the copy

- **Files**: the rebuilt page is emitted as plain files (the page's HTML with its inline CSS, `assets/<name>-<hash>.*`, `js/motion.js`)
  into the lifted copy (`as-is/copy`) at the page's own `outPath`, replacing the lifted document; its assets have hashed names, so
  they cannot collide with the original's paths. It is written before `packLifted` / the html copy, so every stack carries it the
  same way (React + Vite and Next.js copy `public/` unchanged; MERN serves the folder). The replaced lifted page is kept under
  `as-is/fallback/<slug>/` with both versions' measurements and pictures.
- **Links**: the rebuilt page's links go through the existing resolver to the as-is pages' own paths; the as-is pages link to it by
  the same path, so nothing on their side changes. The link pass runs again on the rebuilt page.
- **Scripts and the service worker**: the rebuilt page has none of the original's script and does not register `sw.js`. The service
  worker the as-is pages register maps **original-host** addresses only and lets same-origin requests through, so the rebuilt
  page's files are served normally; the test proves it with the worker active. A same-origin path the worker maps ("two sizes of
  one path", `sameOrigin`) is excluded for the rebuilt page's files.
- **Navigation between the two kinds**: a plain link works both ways. A client-side router in the as-is pages (a framework's own
  navigation) that asks for route data of the rebuilt page gets 404 and falls back to a full load — this must be seen in the fixture
  (a page that navigates client-side), not assumed; if a framework does not fall back, the rebuilt page's link is marked for a full
  load by the link pass (`data-` attribute the router ignores is not generic; the generic way is the 404 → full-load behaviour, to be
  verified, else the page stays as-is and the reason says why).
- **Head**: canonical, link previews and structured data of the rebuilt page follow `copy/address.js` as the as-is pages do.
- The rest of the copy is untouched: the fixes already proven on the as-is pages stay; the rebuilt page gets the clean pipeline's
  own fixers (it is a clean build).

## 5. What the user sees

- **Per page** (Results → the copy's pages, `CopyPages.jsx`): "Kept: the original's own page" or "Kept: a rebuilt page", with one
  sentence why, in words: "The original's own page failed <checks>; the rebuilt one passes <n> of them and looks <x> % different
  (the original's page: <y> %)." / "Both were tried; the original's own page is kept because the rebuilt one <reason>." A page where
  neither passes keeps the better one and its open items now carry a real reason (d: the fix that would pass changes the look; a:
  third-party) instead of `unresolved`; `unresolved` stays only for a page the fallback did not reach, with "not tried: …".
- **Summary line** (`regress.js summaryLine`): `counts.rebuilt` is real.
- **KNOWN-ISSUES.md** (`copy/deploy.js knownIssuesMd`): a page kept rebuilt gets an entry even when it passes: "This page is a rebuilt
  version, not the original's own code: it looks <x> % different and <controls> of <n> controls behave as on the original." A page
  where both failed: the existing entry plus "Tried: the original's own page, then a clean rebuild with <m> min of correction;
  kept: <which>, because <...>."
- **Server log** (`copy/serverLog.js`): one line per decision (page, both versions' numbers, kept, why).
- Switching to the other version from the report (spec reason d: "apply it from the report") is a follow-up, owner-only; v1 keeps
  the other version on disk so that button has something to switch to.

## 6. Files, tests, live proof

Files:
- `src/copy/fallback.js` (new): the `deps` of `checkPage` — `measure` (the three-sided pass above), `autoRepair` (v1: none; returns
  false and the text says "none for this stack" — the routing / MIME / trailing-slash repairs of §1f are a follow-up), `rebuildClean`,
  `correct`, `explain`; the decision rules of part 2 as pure functions (`betterOf`).
- `src/copy/run.js`: `checkPage` exported and given the gates / Lighthouse-as-checks / margin rules; `badness` unchanged.
- `src/recreate/generate.js`: `buildPages(ctx, pages)` and `emitPages` extracted so one page is built from its saved capture without
  the whole stage (behaviour of the stage unchanged, covered by the existing generate tests).
- `src/recreate/assets/index.js`: `assetsStage` callable for one page's asset list (an as-is job runs no assets step).
- `src/recreate/exactCapture.js` / `capture/exact.js`: `captureExactPage` with a given slot list, callable for one page.
- `src/reaudit/lighthousePages.js`: `compareLighthousePages` for one page with a `measuredUrl` (the measurement host) in-process.
- `src/recreate/behavior/preserve/stage.js`: after the checks, the fallback loop within its budgets; installs the winner; re-runs the
  link pass and `measureServed` for that page; `counts.rebuilt`.
- `src/copy/openItems.js` (a `kept` / `tried` field), `src/copy/deploy.js knownIssuesMd`, `src/copy/serverLog.js`,
  `client/src/components/recreate/CopyPages.jsx`, `docs/COPY-MY-SITE.md` §1f / §12, HANDOFF.
Tests (related files only, one at a time, `SAS_TEST_BROWSER_CONCURRENCY=1`):
- `copy-run.test.js` (+4): the gates, Lighthouse rows as failing checks, the noise margin tie, as-is wins a tie.
- `copy-fallback.test.js` (new, real pipeline on a fixture of three pages served on a scratch port): page A's runtime draws nothing
  without its API (blank as-is → visual fails) → rebuilt and kept; page B passes → untouched, no fallback cost; page C's rebuild would
  score higher on Lighthouse but looks > 3.5 % different → as-is kept with the sentence; links A ↔ B work in a browser with the
  service worker active; a client-side navigation from B to A ends on A's content; the React + Vite package builds with A inside;
  KNOWN-ISSUES.md and the per-page text; the per-page and per-job time boxes stop the loop (`now` injected).
- `preserve-fallback-fit.test.js` if the service-worker / routing cases grow past one file.
Live proof, one small site, scratch data, `SAS_MAX_PARALLEL=1`: **makememo, whole site (3 pages)** first — today every page of it
passes, so the proof there is "nothing triggers, nothing changes, the job's time and peak memory are unchanged". A real trigger needs
a page that fails: none of the two sites measured this week has one (nyaayai's open items are owner / third-party). So the second
proof is the first page that fails in the end-of-plan multi-site run (parchaa or flexibench are the likeliest, ≤ 10 pages): that
site is re-run with the fallback on and both versions' numbers go into HANDOFF. No site-specific logic anywhere; the fixture's
"blank without its API" page is the generic failure mode the fallback exists for.

## 7. Risks and limits, honestly; estimate

- A rebuilt page rarely beats the original's own page on interaction (the controls gate): the fallback mostly helps pages whose
  runtime needs a backend or draws blank, which is the case it was asked for. Where both fail, the result is a better-measured
  "still open", not a fix.
- The correction needs the live original for its baseline; the original down means a rebuild without correction (said so).
- Cost: up to 12 min and one Lighthouse comparison per failing page, 45 min per job at most; a 2–6 min Lighthouse decider is the
  largest single piece and is skipped under memory pressure (then the decision is weaker and says so).
- A mixed copy (as-is pages + a rebuilt page) differs in small things between pages (font subsets, motion script); the label says
  which page is which.
- Client-side routing into a rebuilt page and the service worker's scope are the two places a copy could break in a way the checks
  on that page alone do not see: both are in the fixture test; a framework that does not fall back to a full load keeps the page
  as-is with the reason.
- The visual threshold (3.5 % of pixels) is coarse: a small broken area on a tall page passes it; the fallback inherits that from
  §4 and does not change the thresholds.
- Memory and time figures are estimates until the live proof measures them; HANDOFF L4 / L5 get the measured numbers.
- Estimate: **3½–4 days**: ½ day generate / assets / exact-capture extraction (behaviour unchanged, existing tests); 1 day
  `fallback.js` (rebuild, correct, three-sided measure, Lighthouse decider) + `copy-run` rules; 1 day stage integration, service
  worker / links / routing, UI, KNOWN-ISSUES, server log; ½ day the fixture test end to end; ½–1 day the live proof and HANDOFF.
