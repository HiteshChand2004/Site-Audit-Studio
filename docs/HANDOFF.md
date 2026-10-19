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

- **Visual check is noisy** (step 1 of the next work). nyaayai desktop 1440: 83.7 in one run, 0 in another
  (pixel diff 1.6 % then 14.7 % on the same capture). An as-is copy should be identical to the original.
- **Per-page fallback** (auto-repair, clean rebuild of the page, time-boxed correction) is **not** wired. The open
  items say "unresolved" (`reasonFor` marker `unresolved`, not one of the spec's five reasons). `copy/run.js` has the
  decision logic with fakes only (unit-tested).
- **Zero-regressions loop** over the re-audit is **not** live: the as-is job does not run the re-audit, so
  "got worse" is never measured. `copy/run.js` `zeroRegressions` has the logic with fakes only.
- **Fixers on the as-is output** are not wired: the as-is copy has none of the fix-all fixers applied
  (alt text, names, head/SEO, contrast, etc.).
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
