// The views a page can be captured in, widest first (Phase 4b.6.3 added the laptop view). The IR keeps one set of
// styles per view and writes them as a base (the first view) plus one media query per narrower view; the
// cascade of media queries makes each view build on the wider one. A view may be missing for a page (its
// capture failed); the desktop view is required.
//   desktop 1440  the base layout
//   laptop  1024  the layouts between desktop and tablet (Framer's tablet variant starts at 810, many sites
//                 change layout at 1024–1280): without it the IR has nothing to say about 900–1400 px
//   tablet   768
//   mobile   375
//
// DESKTOP ONLY FOR NOW (decided by the user, Oct 2026): only the views in ENABLED_VIEWS are captured, fitted, measured
// and emitted, so the copy has no media queries (on a phone it shows the desktop layout). The other views, the width
// sweep (recreate/sweep.js, responsive.js, verify/refine.js, ir/fluid.js) and the phone Lighthouse run are parked, not
// deleted: to bring them back, list the views here again, restore the sweep / responsive steps in recreate/index.js,
// the analysis views in audit/screenshots.js and the lighthouse-mobile step in audit/index.js.
const ALL_VIEWS = [
  { id: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { id: 'laptop', width: 1024, height: 768, dpr: 1, mobile: false },
  { id: 'tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  { id: 'mobile', width: 375, height: 812, dpr: 2, mobile: true },
];
const ENABLED_VIEWS = ['desktop'];

export const RECREATE_VIEWS = ALL_VIEWS.filter((v) => ENABLED_VIEWS.includes(v.id));
export const VIEW_IDS = RECREATE_VIEWS.map((v) => v.id);
// Widths of every known view: data saved while all views were on still names them.
export const VIEW_WIDTHS = Object.fromEntries(ALL_VIEWS.map((v) => [v.id, v.width]));
/** Views that are captured with a media query of their own (all but the first); none while only desktop is enabled. */
export const MEDIA_VIEWS = VIEW_IDS.slice(1);
// Every known view, widest first. The IR and CSS code that processes saved data follows the views the data has (a copy
// saved while all views were on still has tablet / phone styles, and building another stack from it must keep them).
export const KNOWN_VIEWS = ALL_VIEWS;
export const KNOWN_VIEW_IDS = ALL_VIEWS.map((v) => v.id);
export const KNOWN_MEDIA_VIEWS = KNOWN_VIEW_IDS.slice(1);
