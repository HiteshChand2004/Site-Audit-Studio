---
id: craft
kind: quality
version: 2
title: Visual craft and finish (always included)
---
The site must look like the work of a top design studio: something the owner is proud to show the same day. Generic, timid,
cluttered or unfinished is a failure, even when every check passes.

Layout and rhythm
- A content width of about 1120–1240 px, centred, with side padding of at least 20 px on phones and 32–48 px on larger screens.
- One spacing scale (for example 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 px) used everywhere. Sections breathe: 72–128 px of
  vertical space between them on computers, 48–72 px on phones. Related things sit close, unrelated things far apart.
- Every section has one job and one focal point. Vary the rhythm (text beside a visual, a full-width band, a grid of cards, a
  quote) so the page never feels like the same block repeated. No section may look empty or half-finished.
- Align everything to a grid; left-align body text. Centre only short things (a hero line, a section intro, a final call).

Typography
- A clear type scale with clamp(): a confident display size for the hero (about 44–76 px on computers, 34–44 px on phones),
  clearly smaller section headings, body text 16–18 px with a line height of 1.5–1.7 and lines of 45–75 characters.
- Headings with tight line height (1.05–1.2) and slight negative letter spacing for large serif or display faces. Small
  uppercase labels get letter spacing. At most two families; use weight and size, not more fonts, for hierarchy.

Header and navigation
- A header with the wordmark on the left and the navigation on the right, links spaced at least 24 px apart, the main action as
  a button. Never let links run into each other. On phones: the wordmark, the main action or a menu button, and a full-screen or
  drop-down menu that opens and closes with a button (aria-expanded, Escape closes it).

Colour and surfaces
- Use the palette with intent: one dominant background, one surface colour for cards, the primary colour mostly for actions.
  Every text colour passes WCAG AA contrast on its own background (4.5:1, large text 3:1); check light text on photos or
  colour blocks especially.
- Consistent radii, borders and shadows from the design tokens. Buttons have clear hover, focus and pressed states.

Images without photos
- There are no photos yet. Never fill large areas with crude cartoon shapes. Let typography, colour blocks, texture (a subtle
  grain, a fine pattern or gradient in the palette) and composition carry the design.
- Where a photo will clearly belong (a hero, a dish, the team), use an elegant placeholder frame: the right aspect ratio
  (for example 4:5 or 3:2), a soft tone-on-tone gradient in the palette, an optional small refined line icon, and descriptive
  alt text. Keep it in proportion with the content around it; it must never dominate a section or push the content off-screen.
  Small, simple, refined SVG motifs (a line drawing, an ornament) are welcome.
- Without real photos: at most three photo frames on a page, each with a clear purpose, and no gallery at all (a grid of
  empty frames looks unfinished). Every frame carries a motif or composition; never an empty block.

Content on the page
- Real, specific, well-written copy in the owner's voice. Short paragraphs. Headlines that say something about this business.
- Missing facts never show as notes or brackets in prominent places (see the content rules): the page must read as finished.

Visual review list (go through it at every size, on every screenshot)
- Does the first screen make someone want to stay and act within three seconds? Is the main action obvious?
- Is anything cramped, misaligned, overlapping, cut off or touching an edge? Do navigation links have clear space between them?
- Are sizes in proportion: no giant illustration, no tiny text, no oversized empty area, no wall of text?
- Is there a clear hierarchy in every section, and does the page keep its rhythm all the way down?
- Is any bracketed placeholder, note to the owner or leftover text visible where a visitor would notice it?
- On a phone: one column where it should be, comfortable tap targets, nothing sideways, the menu works, the main action is near.
- Would a top studio ship it? If not, change it and look again.
