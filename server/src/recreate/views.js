// The views a page is captured in, widest first (Phase 4b.6.3 added the laptop view). The IR keeps one set of
// styles per view and writes them as a base (the first view) plus one media query per narrower view; the
// cascade of media queries makes each view build on the wider one. A view may be missing for a page (its
// capture failed); the desktop view is required.
//   desktop 1440  the base layout
//   laptop  1024  the layouts between desktop and tablet (Framer's tablet variant starts at 810, many sites
//                 change layout at 1024–1280): without it the IR has nothing to say about 900–1400 px
//   tablet   768
//   mobile   375
// The analysis screenshots (audit/screenshots.js VIEWS) stay at the three original views.
export const RECREATE_VIEWS = [
  { id: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  { id: 'laptop', width: 1024, height: 768, dpr: 1, mobile: false },
  { id: 'tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  { id: 'mobile', width: 375, height: 812, dpr: 2, mobile: true },
];
export const VIEW_IDS = RECREATE_VIEWS.map((v) => v.id);
export const VIEW_WIDTHS = Object.fromEntries(RECREATE_VIEWS.map((v) => [v.id, v.width]));
/** Views that have a media query of their own (all but the first). */
export const MEDIA_VIEWS = VIEW_IDS.slice(1);
