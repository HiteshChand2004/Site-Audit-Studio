# Number audit

Every run-like number or fact on the site, checked against `data/example-runs.json`. Nothing was changed on any page.
Searched `app/`, `components/`, `lib/`, `README.md`, `docs/` for 91, 98, 99, 15/15, 0.02, 0.64, 390, "under 1%", scores, counts and times.

Support column: **yes** = in the data, **no** = the data says something different, **not stored** = the data has nothing on it.

## What the data says about makememo.ai (the labelled example)

- Lighthouse before: mobile 59, desktop 98. **After: none** (no re-audit).
- Pixel difference, as-is copy: 0.55% at 1440, 0.28% at 390. No fidelity score stored.
- Hover page check: 15 changed in the copy, 15 in the original, no mismatch (19 visible).
- Offline errors: 0. The console-errors audit is not stored.
- Copy stack: `html`. Weaknesses found in the audit: 2.
- For comparison, nyaayai's re-audit "after" is mobile 91 / desktop 99.

## Hits

| file:line | What it claims | Supported? |
| --- | --- | --- |
| `lib/content.ts:163` `lighthouseOriginal: 91` (feeds `AuditStory.tsx:40`, `CompareWipe.tsx:36`, `ExampleRun.tsx:14`, `ProductMocks.tsx:33`) | makememo.ai's original scores 91 | **no.** makememo's stored "before" is 59 mobile / 98 desktop. 91 matches nyaayai's mobile "after". |
| `lib/content.ts:164` `lighthouseCopy: '98–99'` (feeds `AuditStory.tsx:201`, `ProductMocks.tsx:34`) | makememo's copy scores 98–99 | **no / not stored.** makememo has no "after" value. 98 is makememo's own desktop "before"; 99 matches nyaayai's desktop "after". |
| `lib/content.ts:165` `visualDiff: 'under 1%'` (used at `CompareWipe.tsx:178`) | visual difference under 1% | **yes.** 0.55% at 1440 and 0.28% at 390 (as-is pixel diff). |
| `lib/content.ts:166` `hovers: '15/15'` (used at `ExampleRun.tsx:19`) | 15 of 15 hovers kept | **yes, derived.** 15 changed in copy vs 15 in original, no mismatch. "15/15" is not a stored field. |
| `lib/content.ts:167` `consoleErrors: 0` (used at `ExampleRun.tsx:20`) | 0 console errors | **not stored.** Only "0 offline errors" exists for makememo; the console audit is missing. |
| `components/hero/timeline.ts:18-19` `SCORE_ORIGINAL = 91`, `SCORE_COPY = 98` | hero gauges count to 91 then 98 | **no** (same reason as the first two rows) |
| `components/hero/HeroStage.tsx:66` `+{SCORE_COPY - SCORE_ORIGINAL}` | shows "+7" | **no** (derived from the above) |
| `components/hero/HeroStage.tsx:174-175` (hidden caption) | makememo.ai: "Three issues are found and fixed", copy "built in Next.js", "Lighthouse score of 98 against 91" | **no.** The copy's stack is `html`, not Next.js; the audit found 2 weaknesses; scores as above. |
| `components/home/AuditStory.tsx:41` `SCORE_TO = 98` | copy scores 98 | **no / not stored** |
| `components/home/CompareWipe.tsx:37` `SCORE_TO = 98` | copy scores 98 | **no / not stored** |
| `components/home/ExampleRun.tsx:15` `TO = 98` and `:83` `<small>–99</small>` | copy shows 98–99 | **no / not stored** |
| `components/home/ExampleRun.tsx:18` `value: '<1%'` | visual difference <1% | **yes** (hard-coded again, not from `EXAMPLE_RUN`) |
| `components/home/AuditStory.tsx:200-201` | "In the example run on makememo.ai, Lighthouse went from 91 to 98–99" | **no** |
| `components/mockups/ProductMocks.tsx:33-34` | report page rings: Original 91, Copy 98–99, "example run on makememo.ai" | **no** |
| `lib/content.ts:145`, `:179`, `app/features/page.tsx:79`, `app/how-it-works/page.tsx:27`, `components/features/FeatureVisuals.tsx:208` | "below 80 is flagged" | **yes.** Stored `fidelity.threshold` is 80 in every run. |
| `app/how-it-works/page.tsx:17`, `app/page.tsx:16`, `lib/content.ts:178` | audit takes "a minute or two (up to six / about six on slow sites)" | **mostly yes.** 51 finished audits: min 12 s, median 66 s, max 305 s (about 5 min). "Up to six" is slightly above the max seen. |
| `lib/content.ts:147`, `:178`, `app/page.tsx:16` | a copy takes "several minutes per page" | **yes.** The makememo copy (1 page) took about 518 s. |
| `lib/content.ts:186` | "Rebuild from the last visit" takes "well under a minute" | **not stored** |
| `components/home/CompareWipe.tsx:19-22` | four example issue/fix pairs (description, alt text, headings, unused JS) | **not stored** (illustrative; makememo's audit had 2 weaknesses) |
| `lib/content.ts:177` | four stacks | **yes** for the product; only Plain HTML runs exist in the data |
| `README.md:68` | old hero: "79 on phones", "counter reaches 8", "98% visual match badge" | **no / stale.** That component (`CinematicHero.tsx`) no longer exists; the README is out of date. |
| `README.md:70` | hero fits "844 px high at 390 × 844" | layout size, not a result; stale text |
| `docs/SITE-PLAN.md:4`, `docs/HANDOFF.md:23-24` | document the same 91 / 98–99 / <1% / 15/15 / 0 claims | same as above |

## Searched, not found

- `0.02` and `0.64`: no hits in any page, component, content file or doc (only unrelated CSS values such as `0.98` and `0.97`).
- `390`: only `README.md:70` (a layout size) and `docs/HANDOFF.md:70` (a screenshot width). Not a run claim.

## Summary

- The wrong numbers come from one place: `EXAMPLE_RUN` in `lib/content.ts:161-168`, plus three hard-coded copies: `timeline.ts:18-19` (hero), and the `98` constants in `AuditStory.tsx:41`, `CompareWipe.tsx:37`, `ExampleRun.tsx:15` with the literal `–99` at `ExampleRun.tsx:83`.
- Supported by the data: visual difference <1%, 15/15 hovers (derived), the 80 threshold, the timing claims (roughly).
- Not supported: every Lighthouse figure, "0 console errors", and "built in Next.js / three issues" in the hero caption.
