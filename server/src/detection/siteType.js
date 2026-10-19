// @ts-check
// The site-type detector (CLONER_SPEC Phase 1 item 9): a page drawn on a canvas instead of in the DOM cannot be cloned
// from its structure - there is no structure, only pixels. Flutter Web is the common case (its <flutter-view> /
// <flt-glass-pane> / flt-* elements), but the rule is general: one or more canvases covering most of the window while the
// page holds very little text of its own. Analyze reports it; Recreate stops with a clear message instead of producing a
// broken copy of an empty shell (the way a bot-protection challenge stops both, audit/http.js isBotChallenge).

/** Share of the window canvases must cover, and the most text (characters) such a page may hold, to be canvas-rendered. */
export const CANVAS_COVER_MIN = 0.6;
export const CANVAS_TEXT_MAX = 200;
/** flt-* elements that mark a Flutter Web page on their own. */
export const FLUTTER_ELEMENTS_MIN = 3;

export const CANVAS_RENDERED_MESSAGE = 'This page is drawn on a canvas (canvas-rendered, for example Flutter Web): it has no HTML structure to copy, only pixels. Site Audit Studio cannot clone it; the analysis screenshots are the only preview of it.';

/**
 * Page function: what decides the site type, read from the rendered page. Canvases' coverage is the share of the window
 * they cover together (overlaps not counted twice, measured on a grid); text is the page's visible text, white space
 * collapsed (Flutter's semantics tree, when enabled, is hidden text and is not counted unless it is visible).
 */
export function readSiteTypeEvidence() {
  const all = [...document.querySelectorAll('*')];
  const flutter = all.filter((el) => /^flt-|^flutter-/i.test(el.tagName)).length;
  const canvases = [...document.querySelectorAll('canvas')].filter((c) => {
    const s = getComputedStyle(c);
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
  }).map((c) => c.getBoundingClientRect());
  // Coverage of the window on a 40 × 40 grid (canvases inside a shadow root - Flutter's - are reached through their host's box).
  const hosts = all.filter((el) => el.shadowRoot && el.shadowRoot.querySelector('canvas')).map((el) => el.getBoundingClientRect());
  const boxes = [...canvases, ...hosts];
  let covered = 0;
  const N = 40;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = ((i + 0.5) * innerWidth) / N;
      const y = ((j + 0.5) * innerHeight) / N;
      if (boxes.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) covered++;
    }
  }
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return {
    flutterElements: flutter,
    flutterView: Boolean(document.querySelector('flutter-view, flt-glass-pane')),
    canvases: canvases.length + hosts.length,
    canvasCover: Math.round((covered / (N * N)) * 100) / 100,
    textLength: text.length,
    elements: all.length,
  };
}

/**
 * The site type from that evidence: `canvas-rendered` (with the reason) or `standard`.
 * @param {{ flutterElements?: number, flutterView?: boolean, canvases?: number, canvasCover?: number, textLength?: number } | null | undefined} e
 * @returns {{ type: 'canvas-rendered' | 'standard', reason: string | null, evidence: object | null }}
 */
export function classifySiteType(e) {
  if (!e) return { type: 'standard', reason: null, evidence: null };
  const text = e.textLength ?? 0;
  if (e.flutterView || (e.flutterElements ?? 0) >= FLUTTER_ELEMENTS_MIN) {
    return { type: 'canvas-rendered', reason: `Flutter Web elements (${e.flutterView ? 'flutter-view / flt-glass-pane' : `${e.flutterElements} flt-* elements`})`, evidence: e };
  }
  if ((e.canvasCover ?? 0) >= CANVAS_COVER_MIN && text <= CANVAS_TEXT_MAX) {
    return { type: 'canvas-rendered', reason: `canvases cover ${Math.round((e.canvasCover ?? 0) * 100)} % of the window and the page has ${text} characters of text`, evidence: e };
  }
  return { type: 'standard', reason: null, evidence: e };
}
