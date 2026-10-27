# data/example-runs.json: where each field comes from

Raw extraction, no rounding, no averaging, nothing invented. Missing = `null`. Nothing here is wired into any page.

**Source:** a copy of `Site-Audit-Studio-main/data/app.db` (+ `-wal`, `-shm`) made in `%TEMP%\remastly-site-readonly\`, opened
read-only. The original was never opened. The `projects/` folder was only listed and grepped (read-only).
Extractor script: `%TEMP%\remastly-scripts\extract.mjs` (not in the repo).

## What counts as a "run"

72 entries (`runs[]`):

- `runKind: "reaudit"` (68): a finished re-audit (`reaudits.status = 'done'`). It joins the original audit (`analyses`) and the copy (`recreates`) and is the only record that has both "before" and "after".
- `runKind: "recreate-without-reaudit"` (4): a finished copy (`recreates.status='done'`) with no re-audit, so no "after" numbers. Lighthouse `before` is taken from the audit (`analyses.result_json.scores`).

Failed runs are not listed. Every project has many re-runs; `isLatestForProject` marks the newest re-audit per project. Older runs are kept because you asked for every one. Several of them are partial or earlier tests.

## Fields

| JSON field | Source (table.column → JSON path) |
| --- | --- |
| `projectName`, `siteAddress`, `projectCreatedAt` | `projects.name`, `projects.url`, `projects.created_at` |
| `runDate` | `reaudits.finished_at` (or `recreates.finished_at` for recreate-only runs) |
| `stack` / `stackLabel` | `reaudits.result_json → stack, stackLabel` (recreate-only: `recreates.result_json → stack`). Values found: `html` ×71, `nextjs` ×1. **No React+Vite or MERN run was ever the primary stack.** |
| `mode` | `recreates.result_json → asIs.mode` or `exact.mode`: `as-is`, `exact`, or `null` for older runs before those modes existed |
| `placeholderBaseUrl` | Same source as `recreateBaseUrl`. Set to that value when it is a placeholder host (`test.example.com`, `*.test.com`), otherwise `null`. Currently makememo.ai (`https://test.example.com`) and www.nyaayai.com (`https://nyaayai.test.com`). |
| `isTestProject` | `true` only for the makememo.ai project, because you told me it was created for testing. It is a judgement about the whole project, not read from the database. |
| `recreateBaseUrl` | `recreates.result_json → baseUrl`. This is a placeholder host the copy was built for, not the site address. |
| `pagesInScope`, `pagesOutOfScope` | `reaudits.result_json → checklist.scope.pages / outOfScope` |
| `lighthouse.before` / `.after` | `reaudits.result_json → checklist.scores.before / .after`: `{mobile, desktop}` × performance, seo, accessibility, bestPractices. Home page only. (recreate-only runs: `after` = `null`.) |
| `visual.fidelityScoreAllPages` | `recreates.result_json → fidelity.score` (0–100, higher = closer; all pages) |
| `visual.fidelityPageScore`, `.desktop`, `.mobile` | `fidelity.pages[path "/"] → score`, `views.desktop / views.mobile → score`, `.diff.score`, `.low`. The fidelity `desktop` view is 1440 wide and its `mobile` view is **375** wide (stored viewport, `analyses.result_json → screenshots.views.mobile.viewport.width`). |
| `visual.asIsCheck1440`, `.asIsCheck390` | `recreates.result_json → asIs.checks.pages[0].visual[]` where `width` is 1440 / 390 (this separate as-is check really uses 390; the 375 above is the fidelity view) → `diffPct` (% of pixels differing, lower = closer). **Only exists for as-is runs** (2 runs: makememo.ai, www.nyaayai.com). `null` otherwise. |
| `hovers.before/after/matched/sameEnd` | `reaudits.result_json → checklist.motion.hover`. These are counts of hover rules found in the original / copy, and how many matched. They are **not** "passed vs total" by definition. |
| `hovers.asIsPageCheck` | `recreates.result_json → asIs.checks.pages[0].hovers`: `{copy:{visible,changed}, original:{visible,changed}, mismatch[]}`. This is the closest to "N of N hovers kept". Only for as-is runs. |
| `consoleErrors` | `checklist.items[]` where `key = "lighthouse.errors-in-console"` → `before`, `after`, `status`. Only present in 23 of 68 re-audits. Otherwise `null`. It is the Lighthouse "errors in console" audit (pass/fail), not an error count. |
| `asIsOfflineErrors` | sum of `asIs.checks.pages[].offline.errors.length` (as-is runs only; `null` otherwise) |
| `unresolved.counts` | `checklist.summary` (open, regressed, manual, changed, recheck, fixed, improved, pass, na, total) |
| `unresolved.items` | `checklist.items[]` with status `open`, `regressed` or `manual`: status, category, title |

## Things you should know before publishing anything

1. **makememo "test" project.** The project in the database is `makememo.ai`, address `https://makememo.ai/`. The address `https://test.example.com` appears only as `recreates.result_json → baseUrl` on its copy (a placeholder host; nyaayai has the same kind, `https://nyaayai.test.com`). Both runs carry `placeholderBaseUrl`; only makememo is also marked `isTestProject: true`, as you asked. If you meant a different project, tell me.
2. **The makememo run has no re-audit,** so there is **no "after" Lighthouse** for it in this database. The site's current example (`EXAMPLE_RUN`: 91 original vs 98–99 copy) cannot be reproduced from this data. makememo's stored "before" is mobile 59 / desktop 98. The numbers 91 (mobile) / 99 (desktop) are the **nyaayai** re-audit's "after". I can't tell whether the site's numbers came from a deleted run or a mix-up. Please check before keeping them.
3. What the makememo copy *does* have: visual diff 0.55% at 1440 and 0.28% at 390; hovers 15 changed in the copy and 15 in the original with no mismatch; 0 offline errors.
4. `consoleErrors` is a pass/fail audit status and is missing for most runs; there is no console-error count anywhere in the database.
5. Mobile and desktop Lighthouse differ a lot (e.g. flexibench after: mobile 98, desktop 73). I kept both.
6. `fidelity` is a different measure from `diffPct` and the two are not comparable. As-is runs have no fidelity score; exact runs have no `diffPct`.
7. The `projects/` folder has 15 directories but the database has 10 projects. Five folders (`2318a3cd…`, `94c2f7f2…`, `99d2c547…`, `a8a781ea…`, `fb6ee74c…`) have no database row and contain only audit files or nothing, so no runs were extracted from them. Each `recreate/*/report.json` has the same keys as `recreates.result_json` (checked on makememo), so no extra data was found there.
