// The views a page can be captured in, widest first (Phase 4b.6.3 added the laptop view). The IR keeps one set of
// styles per view and writes them as a base (the first view) plus one media query per narrower view; the
// cascade of media queries makes each view build on the wider one. A view may be missing for a page (its
// capture failed); the desktop view is required.
//   desktop 1440  the base layout
//   laptop  1024  the layouts between desktop and tablet (Framer's tablet variant starts at 810, many sites
//                 change layout at 1024–1280): without it the IR has nothing to say about 900–1400 px
//   tablet   768
//   large-phone 700  exact mode only (see EXACT_ONLY_VIEWS): the band between a phone and a tablet. Measured on a
//                 real site, the original had three layouts below 1024 - under 640, then 640-767, then 768 and up -
//                 while the copy had two, so its 375 px styles governed 640-767 and the page came out 12-14% too
//                 short across that whole band. A boundary inside a gap between captured views cannot be followed
//                 by moving a breakpoint: whichever side wins, one of the two regimes gets styles never measured
//                 for it (here, moving it would have made 640 worse, -17% instead of -12%). The band needs a
//                 capture of its own, and 700 sits inside the one every common framework declares (576/640 to 767).
//   mobile   375
//
// ENABLED_VIEWS lists the views that are captured, fitted, measured and emitted. Desktop only was tried for a while
// (Oct 2026: no media queries, phones got the desktop layout) and undone in as-is step 4: all four views again, with the
// width sweep and the responsive check. Data saved while only desktop was on simply has one view (no media queries).
const ALL_VIEWS = [
  { id: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { id: 'laptop', width: 1024, height: 768, dpr: 1, mobile: false },
  { id: 'tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  { id: 'large-phone', width: 700, height: 900, dpr: 2, mobile: true },
  { id: 'mobile', width: 375, height: 812, dpr: 2, mobile: true },
];
const ENABLED_VIEWS = ['desktop', 'laptop', 'tablet', 'large-phone', 'mobile'];

export const RECREATE_VIEWS = ALL_VIEWS.filter((v) => ENABLED_VIEWS.includes(v.id));
export const VIEW_IDS = RECREATE_VIEWS.map((v) => v.id);
// Widths of every known view: data saved while all views were on still names them.
export const VIEW_WIDTHS = Object.fromEntries(ALL_VIEWS.map((v) => [v.id, v.width]));
/** Views that are captured with a media query of their own (all but the first). */
export const MEDIA_VIEWS = VIEW_IDS.slice(1);
// Every known view, widest first. The IR and CSS code that processes saved data follows the views the data has (a copy
// saved while all views were on still has tablet / phone styles, and building another stack from it must keep them).
export const KNOWN_VIEWS = ALL_VIEWS;
export const KNOWN_VIEW_IDS = ALL_VIEWS.map((v) => v.id);
export const KNOWN_MEDIA_VIEWS = KNOWN_VIEW_IDS.slice(1);

/**
 * Views captured only when accuracy is worth the time. A fifth view costs a fifth of the capture again on every
 * page, which an ordinary twelve-minute run cannot afford and an exact run exists to spend. A run without it is
 * not degraded - it is what every run was before: the capture has no body for that view, and the IR already
 * follows the views the data has, because a view can always be missing for a page.
 */
export const EXACT_ONLY_VIEWS = ['large-phone'];

/** The views a capture should visit. @param {{ exact?: boolean }} o */
export const viewsFor = ({ exact = false } = {}) => (exact
  ? RECREATE_VIEWS
  : RECREATE_VIEWS.filter((v) => !EXACT_ONLY_VIEWS.includes(v.id)));
