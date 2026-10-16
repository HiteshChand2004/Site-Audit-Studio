# Handoff — exact-mode, 2026-10-16

Where the work stands at the end of the session, for whoever picks it up next. The project's full history is in `CLAUDE.md`
(note: the condensed `CLAUDE.md` with the Release 1 section is on the WIP branch, not yet approved), the spec in
`CLONER_SPEC.md`, the plan and decisions in `docs/fidelity-audit.md`.

## Branches

| Branch | Last commit | What it holds |
|---|---|---|
| `exact-mode` | this file, on top of `297322a` | Finished, tested work. Every commit passed the pre-commit hook. |
| `wip/handoff-2026-10-16` | `7da3325` (on top of `438f7a1`) | Unfinished / unverified work of the last round + this session's audit scripts + the unapproved `CLAUDE.md`. Committed with `--no-verify`. |

## What works now

Release 1 fixes this session, each with a from-scratch fixture that fails on the code before the fix and passes after
(`server/test/recreate-framer-patterns.test.js` + `fixtures/animation/framer-patterns.html`, normal + exact mode + the
three app stacks, unless noted):

| Commit | Fix (all generic) |
|---|---|
| `ea331f2` | Script hovers that start late / ease back slowly are polled, not read at fixed times. The visibility guard no longer freezes elements that move by design (it had frozen the logo ticker — a Release 1 regression). `stroke-dashoffset` captured and rebuilt (lines drawn along SVG paths). Multi-channel traces for cycling cards. Click probe: focusable `div tabindex` controls, controls re-found by path after a reload, any navigation reloads and goes on, link siblings / plain links after two navigations skipped, limit applied after ranking. `maxHeaderSize` 256 KB (a Next export's 20 KB CSP made the re-audit fail). Corpus: 8 sites pinned. |
| `8eb0273` | Video tier: the page clock is paused robustly under load ("Cannot fast-forward to the past"). |
| `bfe8688` | FAQ answer drawn inside the clicked item is the panel (appeared + spans the control). `js/motion.js calm()` never stops loops in auto-switching sections. Phone view records loops in every copy; phone-only elements get them. Loop scanner reads two intervals (stepped motion). |
| `411d031` | Bare hand-cursor boxes are click candidates (≤ 8 per page, top bar first). Hover/focus tokens reach every width version of an element (exact: `shareHoverAcrossVersions`; rebuilt: `shareHoverWithNarrowTwins`). Fixture made responsive (it had widened the phone view to 680 px). |
| `4a280bc` | States step clicks with the real mouse (Framer tap handlers ignore `el.click()`), and scrolls the page through when a planned control's path no longer resolves (a section drawn only on scroll was missing after a reload). Re-audit loop row pairs loops by element (path → place → kind). |
| `297322a` | A resumed recreate keeps the mode it was started in (exact / no time limit). An exact copy auto-resumed after a server restart had silently become an ordinary one. |

### nyaayai homepage, before vs after (exact copy `ab2729a9`, code `297322a`)

"Before" = nyaayai's pinned capture rebuilt with the code from before this session (`610a4df`). Both sides measured with
the same tool (`scripts/handoff/element-audit.mjs` on the WIP branch: every control clicked on a fresh page, hovers,
cursors, sections, moving elements). Raw results: `data/handoff/audit-before2.json`, `audit-after3.json`.

| | 1440 px | 390 px |
|---|---|---|
| OK on both | 50 | 38 |
| Fixed | 5 | 8 |
| Still broken | 9 | 8 |
| Broken now, OK before | 1 (blog card — see below, likely rotation) | 0 |
| Elements that keep moving (original 18 / 15) | 3 → 8 | 0 → 0 |

Fixed on nyaayai: the FAQ opens (all 4 at 390 px, 2 at 1440 px by the tool — but see the FAQ note below), hovers of "Learn
More", "Press Room", "Partner With Us", "Submit", a top-bar control at 1440 px. The app's own re-audit of this copy:
clicks 5 of 6 like the original (only Botza's "Collapse search bar" differs), hover end states 29 of 30, loops 16 of 22.

## What is still broken, and why

| Item | Known cause | State |
|---|---|---|
| Phone loops at 390 px (copy 0 moving, original 15) | The phone view records 21 loops, but in the merged tree those elements are shared with the desktop; the rule skipped shared elements, so no token reached the phone version of the as-is markup. | Fix on the WIP branch (item 1), checked in HTML only. |
| FAQ "one at a time" at 1440 px | **nyaayai's FAQ is independent toggles, and the copy already behaves exactly like the original** step by step at both widths (`faq-seq.mjs`: `---- O--- OO-- -O-- OO-- O---` on both). The "opens but doesn't close" came from the audit tool: Framer redraws a question's icon as a new element on close, and the tool compared element ids. A site with a real accordion would still be wrong: the probe could not record group behaviour for answers drawn only while open. | Fix on the WIP branch (item 2): passes in exact mode; normal mode unfinished. The audit tool should check toggles by sequence instead of ids (not done). |
| 6 of 22 desktop loops | Not investigated. | Open. |
| Second "Partner With Us" hover (1440 px) | Not investigated (the first one is fixed). | Open. |
| Two top `div` controls at 390 px | Fixed at 1440 px by the bare-pointer rule; at 390 px probably the narrow-view click budget (8 s, `NARROW_CLICK_VIEWS` in `capture/index.js`). | Open (raise the budget if confirmed). |
| Blog card "Zero Knowledge Proofs…" reported missing at 1440 px | Most likely the blog section rotates its cards, so each side showed a different card when measured. Not confirmed. The audit should compare the set of items seen over one full rotation. | Open. |
| Botza ("Ask Botza", "Collapse search bar", icon button) | A third-party chat widget injected by a script from another host. Its behaviour needs Botza's service; the copy must not run third-party chat code. The static launcher is in the copy. | Should be reported as "excluded by rule", not broken (not done). |

## What is on the WIP branch (`wip/handoff-2026-10-16`)

- `438f7a1` — **not verified** (the 4-stack runs and the regression test files were not run; the last test run was stopped):
  1. **Phone loops into the phone markup** (`ir/motion.js`): phone loops on shared elements → token only into the phone
     version of an exact copy's markup (`viewTokens`). Fixture: a bar slid in both width versions of a per-width slot. Old
     code fails (`exact phone-version bar 190,190`), new passes — HTML only.
  2. **FAQ group behaviour by sequence** (`capture/clicks.js sequenceDrawnPanels`, `capture/states.js`): lists joined by
     position, real clicks, open A → open B → A again; `exclusive`, `sequence`, `listPaths`; an unprobed neighbour stands
     in when only one member was probed; scroll-through when paths no longer hold their text; unprobed members planned
     when the area is the control itself. Fixture: a one-at-a-time list with tap handlers. Passes in exact mode; in
     normal mode the run still failed on the growing FAQ (probe budget) when stopped. No old-code proof yet.
  3. `inspect.js probeBudget`: a run without a time limit gets the exact probe budget. Untested.
  4. The patterns test runs both modes with `unlimited: true`.
  5. `CLAUDE.md` condensed + Release 1 section — **waiting for the user's approval of the diff**.
- `7da3325` — this session's audit / diagnosis scripts in `server/scripts/handoff/` (see the commit message).

Next steps in order: finish item 2 in normal mode and prove both items on old code; run them in all four stacks and the
affected test files (list below); then the user's items 3–5 (rotation-aware audit, the three open nyaayai items, Botza as
"excluded by rule"); then a fresh exact nyaayai copy and the table again; the 8-site corpus check only when the user says
the machine is free.

## How the pipeline fits together

Analyze (`server/src/audit/`) → Recreate (`server/src/recreate/index.js`, steps in `STAGES`):

1. **Capture** (`recreate/inspect.js` → `capture/index.js capturePage` → `captureView` per view): snapshot
   (`capture/snapshot.js`), as-is document (`capture/asis.js`, exact), probes — hover (`interactions.js`), clicks
   (`clicks.js`), states / FAQ / tabs / panels (`states.js`), loops + canvas (`loops.js`), reveals (`reveal.js`), feeds
   (`feeds.js`), pointer followers (`pointer.js`), scroll-linked (`scrolllinked.js`), video tier (`videotier.js`). Output
   `capture/<slug>/<view>.json`, `<view>-motion.json`, `<view>-asis.json`. Exact baseline: `capture/exact.js`.
2. **IR** (`recreate/ir/`): merged tree per page (`tree.js`), styles (`styles.js`), motion tokens (`motion.js`), states
   (`states.js`), exact copies keep the original markup and CSS (`asis.js applyAsIs`, width versions `data-sas-v`).
   Saved as `ir/site.json`.
3. **Emit** (`recreate/emit/`): HTML (`html.js`, `css.js`, `motionCss.js`, `motionScript.js` = the one `js/motion.js`),
   React + Vite (`react/`), Next.js (`next/`), MERN (`mern/`).
4. **Verify / audit**: build + safety + verification (`build/`, `verify/`), exact comparison (`verify/exact/`), visibility
   and hit-test guards (`verify/visibility.js`, `verify/hittest.js`), re-audit + fix checklist (`server/src/reaudit/`,
   motion rows in `reaudit/motion.js`).

## Saved captures

- **nyaayai** (project `1f98e132-…`): latest exact copy `ab2729a9-4344-424f-b7fc-a538796c7774` — copied to
  `C:\Users\urvas\Downloads\Site-Audit-Studio-main\data\handoff\nyaayai-ab2729a9-…` (capture, assets, ir, report).
  The pinned corpus capture (pre-Release-1, used as "before"): `data\corpus\nyaayai\` (`b9f1be6f`).
- **makememo.ai** (project `6f9b07e8-…`): latest exact copy `21c5125e-f76b-47d8-85ee-949eb89d263a` — copied to
  `data\handoff\makememo-21c5125e-…`; the one before, `af136e45-…`, is still under the project folder. Not in the corpus
  registry yet.
- All 8 corpus sites: `data\corpus\<name>\` (`scripts/corpus.mjs --pin`), out of retention's reach. The project folders
  keep only the two newest copies per site — copy anything you need elsewhere.

## Commands and how long they take (this machine, ~4–6 GB free memory)

```bash
git config core.hooksPath .githooks                     # once: the pre-commit hook
npm run test:precommit -w server                        # every source file parses + fast unit tests: ~30–60 s
node server/test/run-tests.js server/test/<file>.test.js   # one file (from server/): unit ~5 s, browser fixtures 3–15 min
SAS_SKIP_APP_STACKS=1 node test/run-tests.js test/recreate-framer-patterns.test.js   # patterns, HTML only: ~5–8 min
node test/run-tests.js test/recreate-framer-patterns.test.js                          # + React / Next / MERN: ~15–25 min
npm run test:fixtures -w server                         # all fixtures, all 4 stacks: ~1.5–2 h
node scripts/corpus-compare.mjs --stacks html           # 8 sites, previous release vs HEAD: ~2–2.5 h (not run yet)
```

Affected-files set to run after capture / motion changes: `recreate-framer-patterns`, `recreate-motion-calm`,
`recreate-clicks`, `recreate-widgets`, `reaudit-clicks`, `recreate-states-off`, `recreate-states-split`,
`recreate-hover-toggle`, `recreate-exact-probes`, `recreate-loops`, `recreate-motion-ir`, `recreate-animation-lab`,
`recreate-animation-rules`, `recreate-feeds`, `recreate-exact-asis-*`, `recreate-capture`, `reaudit-motion`.

Run one browser-heavy test at a time: two at once on this machine has run out of memory and had runs killed. An exact
nyaayai copy takes ~25–30 min (2.5 h when memory ran short). Start the API server as a hidden process
(`node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/index.js` in `server/`) — a minimized `npm run dev`
window received Ctrl+C twice and stopped mid-run; a server whose parent console died could no longer launch Chromium.

## Rules (from the user)

- **Generic only**: no site-specific code, no per-URL handling; platform knowledge only in `detection/rules/*.json`.
- Every fix gets a **from-scratch fixture** for its pattern, and its test **must fail on the old code** and pass on the new.
- **Never worse than before**: no regression in any stack; the corpus check blocks a release on a regression.
- **Lifting** the original's scripts only for the user's own / authorised sites (decision in `CLONER_SPEC.md`), and only
  known libraries / the site's small interaction scripts — **never trackers, analytics, auth, payment or chat widgets**.
- The copy must **never depend on the original site or its CDNs** at run time (all assets local, no live links).
- One step at a time; a WIP commit per step; the full 4-stack fixture suite before a step's final commit; never merge into
  main; push only when asked.
