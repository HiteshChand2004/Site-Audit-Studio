# Redesign notes (22 Oct 2026)

> **Out of date (24 Oct 2026).** The example run is collateral.panscience.ai, not indikaai; `asIsRun` no longer holds pixel figures; indikaai's match score was removed; match scores are named "Layout and thumbnail match" with their scope; dreamhire.in is a card (its 1-page run of 14 Oct, labelled as not the latest).

## Pictures in `public/shots` (all WebP, 40–53 KB each)

Source: `Site-Audit-Studio-main/data/projects` (read-only; a copy of `app.db` was opened from a scratch folder).
Blank share = share of rows below the first screen (y ≥ 900) that sit inside a flat-colour run of 150 px or more
(`max − min ≤ 3` over the row), measured per picture and compared pair-wise ("one-sided" = blank in one picture only).

| File | Run | Mode | Captured | Rows measured | Blank (original / copy) | One-sided |
| --- | --- | --- | --- | --- | --- | --- |
| `indikaai-original.webp`, `indikaai-copy.webp` (1440 × 2040 crop) | indikaai.com, copy f6035800 | Exact copy | 15 Oct | 900–2040 | 0.0 % / 0.0 % | 0.0 % |
| `nyaayai-original.webp`, `nyaayai-copy.webp` (1440 × 900) | nyaayai.com, copy d515f72e | As-is | 19 Oct | none (first screen only) | n/a | n/a |

Rejected:
- makememo (as-is, 19 Oct): full page 72.9 % / 73.6 % blank (both sides); the original's first screen was captured mid-animation.
- nyaayai full page (as-is, 19 Oct): 16.2 % one-sided blank below the first screen, and the copy shows a strip of third-party logos that the original's picture lacks. Only the first screen is kept; no third-party logo is in it.
- sankalpam.ai (as-is, 21 Oct): not used. Its as-is check records 10.43 % pixel difference at 1440 px and 3.6 % at 390 px, and it is newer than the 18 Oct cutoff.
- The indikaai full-page original in `audit/…/screens` is 90 % blank; the pair used comes from `capture/index/exact` (original) and `fidelity/index/exact` (copy), 0.0 % one-sided. The marquee of customer names below y ≈ 2080 is cropped out.
- framer.app: not used anywhere.

Caveat on the test: the flat-row test cannot see a strip that is blank in one picture and full of content in the other; that is how the nyaayai logo strip was found (by eye). Every kept picture was also looked at.

## Fonts

Newsreader 500 (headlines, italic for the emphasised word) + Hanken Grotesk (everything else): the families panscience.xyz uses (read from its live computed styles and from the tool's saved copy). Replaces Instrument Serif + Geist.

## Run figures

`exampleRun` (indikaai.com, exact copy mode) is the single source for the example run; it now also holds the 42-item checklist and a reason for every open item. `asIsRun` (nyaayai.com, as-is mode) is a second labelled record, used only for the as-is pixel/hover figures. Its re-audit (not shown anywhere) records 11 items that got worse, so nothing on the site claims that zero items ever get worse; the site states the count per run.

## Logo strip, result cards, hero slot (22 Oct 2026, second round)

- Logo strip: favicons read from `favicon.bin` of each project (read-only), ICO decoded, flattened, greyscale, 96 px WebP in `public/logos`. Heading and the "own sites, not customers" line are in `lib/content.ts` (`logoStrip`).
- Result cards (`resultCards`, one latest re-audit per site, figures copied as stored): indikaai.com (exact, 15 Oct), botza.panscience.ai (standard mode, 8 Oct), panscience.xyz (standard mode, 8 Oct), collateral.panscience.ai (exact, 13 Oct).
  Left out: parchaa.com (latest run: visual match 41, 4 of 54 checks got worse), flexibench.io (latest run: visual match 41, 7 of 58 got worse, desktop performance 97 to 73), dreamhire.in (latest run: 5 pages, visual match 78 with 58 and 57 on the two screen sizes, 2 of 42 got worse), nyaayai.com and makememo.ai (as-is runs of 19 Oct: they fail the blank-share check, 16.2 % and 72.9 %; makememo also has no after-audit).
- Hero slot: `heroMedia` in `lib/content.ts`; `.hmedia__slot` is 16:9 at every width (1152 × 648 at 1440; 335 × 188 in a desktop browser at 390 with the 15 px scrollbar gutter, 350 × 197 on a phone with overlay scrollbars). Set `type: 'video'` and `src` to use a video. Verified with a temporary clip: plays, loops, muted, inline; paused on the poster under reduced motion; slot size identical before and after the video loaded; CLS 0 for the hero.
