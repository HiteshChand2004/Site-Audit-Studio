// The one script the recreated site may carry (Phase 4b.4): shows scroll-reveal elements when they come into view, and
// (step 2 of the "as is" fixes) opens and closes panels: a click on a `wt` control toggles `is-open` on its area (the
// nearest ancestor with a `wN` token) and keeps the control's aria-expanded in step; the open state is CSS (emit/motionCss.js).
// It also adds `is-scrolled` to a bar (`data-scroll-at`: px, or a share of the window height `0.92vh`) once the page is scrolled
// that far, and shows the state a `data-w-go` control points to (tabs, carousels, filters).
// Everything else about motion (hover, focus, loops, the reveal animation itself) is CSS; for the reveal this file only
//   1. adds `js-motion` to <html> - the reveal rules apply only then, so a visitor without script (or with
//      prefers-reduced-motion) sees the finished page, never hidden content;
//   2. adds `is-in` to a `data-motion~="rv"` element when it scrolls into view (and removes it again when it leaves,
//      for `rp` elements: the reveal repeats, like the original's).
// It is fixed (the same for every site), reads only the document and makes no request: the safety gate allows exactly this
// file (verify/appProfiles.js `motion`) and nothing else.
export const MOTION_FILE = 'js/motion.js';

export const MOTION_JS = `(function () {
  var bars = document.querySelectorAll('[data-scroll-at]');
  if (!bars.length) return;
  var limit = function (el) {
    var v = el.getAttribute('data-scroll-at') || '0';
    return /vh$/.test(v) ? parseFloat(v) * window.innerHeight : parseFloat(v);
  };
  var queued = false;
  var update = function () {
    queued = false;
    for (var i = 0; i < bars.length; i++) bars[i].classList.toggle('is-scrolled', window.scrollY >= limit(bars[i]));
  };
  window.addEventListener('scroll', function () {
    if (!queued) {
      queued = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
})();
(function () {
  var AREA = /(^| )w[0-9]+( |$)/;
  var touched = {};
  var rendered = function (el) {
    return el.getClientRects().length > 0 || window.getComputedStyle(el).display === 'contents';
  };
  // The states a page does not start in wait inside <template data-w-tpl> (kept out of the page until needed): the first
  // time their set is used they are put in place. They take the place of an area already revealed, so they are shown as such.
  var materialize = function (id) {
    var tpls = document.querySelectorAll('template[data-w-tpl="' + id + '"]');
    for (var i = 0; i < tpls.length; i++) {
      var shown = tpls[i].content.querySelectorAll('[data-motion~="rv"]');
      for (var r = 0; r < shown.length; r++) shown[r].classList.add('is-in');
      var first = tpls[i].content.firstElementChild;
      if (first && /(^| )rv( |$)/.test(first.getAttribute('data-motion') || '')) first.classList.add('is-in');
      tpls[i].parentNode.replaceChild(tpls[i].content, tpls[i]);
    }
  };
  // Shows state \`index\` of set \`id\` and hides the others. A state the stylesheet does not show at this window width
  // (the original rendered that area differently there) is not switched to: the visible one stays.
  var show = function (id, index) {
    materialize(id);
    var states = document.querySelectorAll('[data-w-set="' + id + '"]');
    var target = [];
    var shownBefore = false;
    for (var i = 0; i < states.length; i++) {
      if (states[i].getAttribute('data-w-i') === String(index)) target.push(states[i]);
      else if (!states[i].hasAttribute('hidden') && rendered(states[i])) shownBefore = true;
    }
    var wasHidden = [];
    for (var j = 0; j < target.length; j++) {
      if (target[j].hasAttribute('hidden')) wasHidden.push(target[j]);
      target[j].removeAttribute('hidden');
    }
    var visible = false;
    for (var k = 0; k < target.length; k++) if (rendered(target[k])) visible = true;
    if (!visible && shownBefore) {
      for (var w = 0; w < wasHidden.length; w++) wasHidden[w].setAttribute('hidden', '');
      return 0;
    }
    for (var h = 0; h < states.length; h++) if (target.indexOf(states[h]) < 0) states[h].setAttribute('hidden', '');
    return states.length;
  };
  // Carousels that move on by themselves (data-w-auto="ms:step"); a click restarts the wait.
  var autos = document.querySelectorAll('[data-w-auto]');
  for (var a = 0; a < autos.length; a++) {
    (function (el) {
      var id = el.getAttribute('data-w-set');
      var parts = (el.getAttribute('data-w-auto') || '').split(':');
      var ms = parseInt(parts[0], 10);
      var step = parseInt(parts[1], 10) || 1;
      if (!(ms > 0)) return;
      window.setInterval(function () {
        if (document.hidden || Date.now() - (touched[id] || 0) < ms) return;
        materialize(id);
        var states = document.querySelectorAll('[data-w-set="' + id + '"]');
        var n = states.length;
        var current = 0;
        for (var i = 0; i < n; i++) if (!states[i].hasAttribute('hidden')) current = parseInt(states[i].getAttribute('data-w-i'), 10);
        show(id, (((current + step) % n) + n) % n);
      }, ms);
    })(autos[a]);
  }
  // A card's hovered look (data-w-hv box): put in place the first time the card is pointed at or focused; the stylesheet
  // then swaps the two on :hover / :focus-within.
  var hoverIn = function (e) {
    var box = e.target && e.target.closest ? e.target.closest('[data-w-hv]') : null;
    if (!box) return;
    var tpls = [];
    for (var c = box.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === 'TEMPLATE' && c.getAttribute('data-w-tpl') === 'hover') tpls.push(c);
    for (var i = 0; i < tpls.length; i++) box.replaceChild(tpls[i].content, tpls[i]);
  };
  document.addEventListener('pointerover', hoverIn, { passive: true });
  document.addEventListener('focusin', hoverIn);
  var noteTimer = null;
  document.addEventListener('click', function (e) {
    // A short message (data-w-note="id:ms"): shown on click, hidden again after ms (0 = until the next one).
    var note = e.target && e.target.closest ? e.target.closest('[data-w-note]') : null;
    if (note) {
      var spec = (note.getAttribute('data-w-note') || '').split(':');
      var all = document.querySelectorAll('[data-w-note-of]');
      for (var m = 0; m < all.length; m++) {
        if (all[m].getAttribute('data-w-note-of') === spec[0]) all[m].removeAttribute('hidden');
        else all[m].setAttribute('hidden', '');
      }
      if (note.tagName === 'A' && /^#?$/.test(note.getAttribute('href') || '')) e.preventDefault();
      if (noteTimer) window.clearTimeout(noteTimer);
      var ms = parseInt(spec[1], 10);
      if (ms > 0) {
        noteTimer = window.setTimeout(function () {
          for (var q = 0; q < all.length; q++) all[q].setAttribute('hidden', '');
        }, ms);
      }
      return;
    }
    var go = e.target && e.target.closest ? e.target.closest('[data-w-go]') : null;
    if (go) {
      var to = (go.getAttribute('data-w-go') || '').split(':');
      if (go.tagName === 'A' && /^#?$/.test(go.getAttribute('href') || '')) e.preventDefault();
      touched[to[0]] = Date.now();
      show(to[0], to[1]);
      return;
    }
    var t = e.target && e.target.closest ? e.target.closest('[data-motion~="wt"]') : null;
    if (!t) return;
    var area = t;
    while (area && !(area.getAttribute && AREA.test(area.getAttribute('data-motion') || ''))) area = area.parentElement;
    if (!area) return;
    if (t.tagName === 'A' && /^#?$/.test(t.getAttribute('href') || '')) e.preventDefault();
    var open = area.classList.toggle('is-open');
    if (t.hasAttribute('aria-expanded')) t.setAttribute('aria-expanded', open ? 'true' : 'false');
    // One panel at a time in a list marked data-w-one (an accordion): the others close.
    var list = open && area.closest ? area.closest('[data-w-one]') : null;
    if (list) {
      var others = list.querySelectorAll('.is-open');
      for (var k = 0; k < others.length; k++) {
        if (others[k] === area || !AREA.test(others[k].getAttribute('data-motion') || '')) continue;
        others[k].classList.remove('is-open');
        var c = others[k].querySelector('[data-motion~="wt"][aria-expanded]');
        if (c) c.setAttribute('aria-expanded', 'false');
      }
    }
  });
})();
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('IntersectionObserver' in window) || reduce) return;
  var items = document.querySelectorAll('[data-motion~="rv"]');
  if (!items.length) return;
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (entry.isIntersecting) {
        el.classList.add('is-in');
        if (!/(^| )rp( |$)/.test(el.getAttribute('data-motion') || '')) observer.unobserve(el);
      } else if (el.classList.contains('is-in')) {
        el.classList.remove('is-in');
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
  root.classList.add('js-motion');
  for (var i = 0; i < items.length; i++) observer.observe(items[i]);
})();
`;

/** Where the app stacks (React + Vite, Next.js, MERN) serve it from: the root of the site, like their assets. */
export const MOTION_SRC = `/${MOTION_FILE}`;
/** The tag the app stacks put in each page's head (the plain-HTML build uses a path relative to the page). */
export const MOTION_TAG = `<script src="${MOTION_SRC}" defer></script>`;
