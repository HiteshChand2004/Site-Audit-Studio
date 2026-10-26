# Copy my site — plan

One button, "Copy my site". It produces a ready copy in the chosen stack: every page as the original (animations, effects,
hovers, clicks), with every problem fixed except the ones that genuinely cannot be fixed. No mode choice for the user.

## 1. Pipeline behind the button (per stack)

| Step | What | Existing code it builds on |
|---|---|---|
| a. Capture | every page, every view | `recreate/inspect.js`, `capture/*` |
| b. As-is | original markup, sheets and scripts-as-lifted for every page (the base) | `recreate/behavior/preserve/*`, `ir/asis.js`, `asIs` option |
| c. Fixes on the as-is output | the fixers that can run safely on the original's own markup (see §2) | `fixers/*` with `asIs` guards |
| d. Package | the chosen stack (html, react-vite, nextjs, mern) | `preserve/stage.js ASIS_STACKS`, `export/*` |
| e. Verify every page | cold visit, visual difference at 1440 and 390 px vs the original, hovers and controls vs the original, console errors, Lighthouse on the homepage | `reaudit/*`, `verify/visualDiff.js`, `capture/measure.js` |
| f. Per-page fallback | a page below threshold: (1) auto-repair known stack issues (routing, trailing slashes, MIME types, asset paths, service-worker scope), re-check once; (2) if still below, rebuild that page clean in the chosen stack, run a time-boxed exact correction on it, keep the better of the two | `recreate/index.js` (clean), `exact/correct.js` |
| g. Zero regressions | every "got worse" item is diagnosed and fixed generically, re-packaged and re-checked, within a time budget | `reaudit/compare/rules.js` statuses |
| h. Unresolved | a page still failing: deliver its best version; list it in `KNOWN-ISSUES.md` (zip) and the report; log to a server log the admin can read | new `copy/knownIssues.js` |

## 2. Which fixers run on the as-is output

Allowed on the as-is output (they do not change pixels or behaviour on purpose):
SEO head and meta (titles, descriptions, canonical), structured data (JSON-LD, FAQ, Organization), alt text, accessible names,
accessibility attributes (duplicate ids, frame titles, tabindex), image sizes and WebP (responsive variants only when pixels stay the same),
security and caching headers (`_headers`), `llms.txt` and sitemap/robots, and broken-link handling (§3).

Not allowed (they change pixels or behaviour on purpose; they are reason **d** when they would have helped):
colour contrast rewriting, font subset pruning, sprite and layout parking, head-text rewriting beyond titles and descriptions
that are missing or duplicated, dead-link unlinking, LCP entrance removal.

## 3. Broken links

- A link is called broken only after re-checks with retries (3 attempts, 2 s apart) from a real browser, not only HEAD/GET.
- 401, 403, 429 and timeouts are "couldn't verify", never "broken".
- Safe automatic fixes (internal links only, against the original):
  - wrong path or trailing slash → the copy's page with that path;
  - the link redirects → its final URL;
  - `http://` that works on `https://` → `https://`;
  - the page does not exist on the original either (confirmed 404) → the copy's 404 page.
- External dead links are not changed. They are flagged with a suggested fix (remove the link, or an obvious replacement) for the owner to decide.
- Links that cannot be verified stay unchanged and are noted "couldn't verify".
- Every link has a recorded action in the report.

## 4. Thresholds (from the measured runs; the same numbers the app already uses)

| Check | Pass | Source |
|---|---|---|
| Visual difference per page, 1440 and 390 px | ≥ 65 | `verify/visualDiff.js` threshold, `FIDELITY_THRESHOLD` family |
| Page height, each width | within 5 % of the original | `fidelity` size rule |
| Hover parity (paired hovers, same end state and timing) | ≥ 90 % of the original's | `motion` rows: pass ≥ 90 %, open 50–90 %, regressed < 50 % |
| Controls (clicks, FAQs, tabs) | every control behaves as the original | `motion.clicks` row |
| Console errors | none the original does not have | `capture/exact.js` console record |
| Lighthouse, homepage, each category | not below the original's; performance ≥ 50 | `rules.js` pass ≥ 0.9, fail < 0.5 |

Fallback trigger (§1f): any page below the visual or the controls threshold, or with a new console error.

## 5. Got worse and still open — the only allowed reasons

Every item left open (got worse, or still open) must name one reason:

- **a** third-party code outside the copy's control (embeds, external scripts);
- **b** needs a real backend or credentials the user must supply (forms, login, payments);
- **c** needs the owner's decision (dead external links, content or brand choices);
- **d** the fix would change the original's look, animation or behaviour, breaking as-is fidelity: show what the fix would change
  and let the user apply it from the report;
- **e** cannot be verified locally (depends on real hosting): noted in `DEPLOY.md`.

Any fix that makes a visual, hover/control or console check worse is reverted automatically and listed under **d**.

## 6. Time limits

- The whole run has a limit set per run (default 45 minutes); pages are checked in order and the run never waits for one page.
- Fallback per page: at most 5 minutes of exact correction (the time box), then the better version is kept.
- Zero-regression loop: at most 3 rounds per project, each round re-packages only the affected pages.
- A stopped run keeps its finished pages (the existing checkpoint).

## 7. UI states

- Copy step: one primary button "Copy my site" → one short panel (stack with a one-line description, default Plain HTML; the
  new-site address; the authorisation confirmation; pages default to every page). The stack is chosen only here; the duplicate
  stack choice in "Change settings" is removed.
- The existing options (Clean rebuild, Original as-is, Create an exact copy, Rebuild from the last visit, Change settings) move
  under a collapsed "Advanced options". Nothing is removed.
- One progress view with the stages: Capturing → Copying → Fixing → Packaging → Checking → Done.
- Results: one summary line ("12 pages copied in Next.js · 11 as-is, 1 rebuilt · Got worse: 0 · Fixed: 9 · Still open: 2"),
  then "Got worse", "Fixed" and "Still open" with reasons, a per-page table (as-is or rebuilt, scores, what was fixed and what is
  open), and one download button, enabled only when the pipeline has finished.

## 8. Downloads

- `DEPLOY.md` in every download, written for its stack: how to run locally (HTML: a small static server, not double-clicking
  `index.html`; React/Next: `npm install` then `npm run dev`; MERN: `npm run install:all` then `npm start`), how to deploy on the two
  best hosts for the stack, the form endpoint (`FORM_ENDPOINT`), the new-site address, HTTPS for the service worker, and any
  reason-e items to check after deploying.
- `KNOWN-ISSUES.md` in the zip when any page or item is open.

## 9. Retention

Keep the latest finished copy (and its report) for each project and stack while the project exists. Older copies may be deleted.
Existing rule: `recreate/workspace.js pruneRecreates` keeps the two newest clean copies and the newest as-is copy per stack. The
new rule adds: never delete the newest finished copy of a stack.

## 10. Rules

- Form data is never sent to the original. No trackers, analytics, auth, payment or chat widgets are copied.
- Tests use scratch data copies and scratch ports only (never the dev server on 4000 or 5173, never the real data folder).

## 11. Where each setting moves

- Stack choice: from "Change settings" to the "Copy my site" panel (main flow). "Change settings" keeps the address and page limit.
- Exact mode, clean rebuild, as-is, rebuild from the last visit, stop / resume: under "Advanced options".
- Thresholds: `server/src/copy/thresholds.js`.

## 12. What is implemented in this branch

- This plan.
- `server/src/copy/`: thresholds, broken-link classification, open-item reasons, zero-regression decision, `DEPLOY.md` and
  `KNOWN-ISSUES.md` generators, the per-stack facts for DEPLOY.md. Unit tests only.
- Not yet: the single pipeline run behind the button (orchestration of §1 a–h), the UI panel and results rewrite, and the real
  runs on makememo.ai and nyaayai (they need the machine-free signal).
