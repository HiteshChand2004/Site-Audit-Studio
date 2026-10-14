// The one script the recreated site may carry (Phase 4b.4): shows scroll-reveal elements when they come into view, and
// (step 2 of the "as is" fixes) opens and closes panels: a click on a `wt` control toggles `is-open` on its area (the
// nearest ancestor with a `wN` token) and keeps the control's aria-expanded in step; the open state is CSS (emit/motionCss.js).
// It also adds `is-scrolled` to a bar (`data-scroll-at`: px, or a share of the window height `0.92vh`) once the page is scrolled
// that far, and shows the state a `data-w-go` control points to (tabs, carousels, filters). A panel the original drew
// away from its control (`data-w-panel-of`: a dialog, a drawer) opens on its control and closes again the way the original
// closed it: the control itself, Escape or a click outside (`data-w-dismiss`), or the close control inside it (`data-w-x`).
// A control that is a link to another page but kept the visitor on the page in the original carries `data-w-stay`: the copy
// does not follow the link either. Last, it takes the layout parts
// the stylesheet hides at the current width (`data-w-lay`) out of the page until a resize needs them (a smaller DOM).
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
  // A part that changes by itself (data-w-feed: a feed adding rows, a ticker): a state shown again plays the entrance of
  // every element in it, but the original only animated what its script had just added. So on each step, what the
  // state shown before already had (the same tag and text) is held still, and only the new elements play their entrance.
  var keyOf = function (el) {
    return el.tagName + '|' + (el.textContent || '').split(/\\s+/).join(' ');
  };
  var calm = function (before, next) {
    var seen = {};
    var old = before ? before.querySelectorAll('*') : [];
    for (var p = 0; p < old.length; p++) seen[keyOf(old[p])] = (seen[keyOf(old[p])] || 0) + 1;
    var all = next.querySelectorAll('*');
    for (var q = 0; q < all.length; q++) {
      var el = all[q];
      if (el.hasAttribute('data-w-calm')) {
        el.style.animation = el.getAttribute('data-w-calm');
        el.removeAttribute('data-w-calm');
      }
      var key = keyOf(el);
      if (seen[key] > 0) {
        seen[key]--;
        el.setAttribute('data-w-calm', el.style.animation || '');
        el.style.animation = 'none';
      }
    }
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
        var before = null;
        for (var i = 0; i < n; i++) {
          if (!states[i].hasAttribute('hidden')) {
            current = parseInt(states[i].getAttribute('data-w-i'), 10);
            before = states[i];
          }
        }
        var next = (((current + step) % n) + n) % n;
        // A feed whose original re-renders it whole (data-w-feed="all", capture/feeds.js) replays every entrance, as shown.
        if (el.hasAttribute('data-w-feed') && el.getAttribute('data-w-feed') !== 'all') {
          var targets = document.querySelectorAll('[data-w-set="' + id + '"][data-w-i="' + next + '"]');
          for (var t = 0; t < targets.length; t++) calm(before, targets[t]);
        }
        show(id, next);
      }, ms);
    })(autos[a]);
  }
  // Elements that follow the pointer (data-w-follow="kx,ky,cx,cy,mx,my,tauMs,fixed,share", capture/pointer.js): a custom cursor,
  // mouse parallax. Each is moved to where the original's script put it for the mouse position (its centre was at cx,cy
  // with the mouse at mx,my, and moves k times the mouse's move), easing with the measured time constant. On its own
  // translate property, so a transform of its own stays as it is. Nothing under reduced motion, nothing for touch.
  var followers = document.querySelectorAll('[data-w-follow]');
  var calmMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (followers.length && !calmMotion) {
    var trail = [];
    for (var f = 0; f < followers.length; f++) {
      var v = followers[f].getAttribute('data-w-follow').split(',').map(Number);
      trail.push({ el: followers[f], kx: v[0], ky: v[1], cx: v[2], cy: v[3], mx: v[4], my: v[5], tau: v[6], fixed: v[7] === 1, share: v[8] > 0 ? v[8] : 0, x: 0, y: 0, base: null });
    }
    var pointer = null;
    var following = false;
    var lastFrame = 0;
    var follow = function (now) {
      var dt = lastFrame ? now - lastFrame : 16;
      lastFrame = now;
      var moving = false;
      for (var i = 0; i < trail.length; i++) {
        var it = trail[i];
        if (!it.base) {
          var r = it.el.getBoundingClientRect();
          it.base = { x: r.left + r.width / 2 + (it.fixed ? 0 : window.scrollX), y: r.top + r.height / 2 + (it.fixed ? 0 : window.scrollY) };
        }
        var tx = it.cx + it.kx * (pointer.x - it.mx) - it.base.x;
        var ty = it.cy + it.ky * (pointer.y - it.my) - it.base.y;
        // A share of the way per frame, as a follower's script usually moves it (it falls behind more when frames come
        // slower, like the original's): the share a 60 Hz frame covers with the measured time constant.
        var share = it.share > 0 ? it.share : it.tau > 0 ? 1 - Math.exp(-16.67 / it.tau) : 1;
        it.x += (tx - it.x) * share;
        it.y += (ty - it.y) * share;
        if (Math.abs(tx - it.x) > 0.3 || Math.abs(ty - it.y) > 0.3) moving = true;
        it.el.style.translate = it.x.toFixed(2) + 'px ' + it.y.toFixed(2) + 'px';
      }
      if (moving) {
        window.requestAnimationFrame(follow);
      } else {
        following = false;
        lastFrame = 0;
      }
    };
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!following) {
        following = true;
        lastFrame = 0;
        window.requestAnimationFrame(follow);
      }
    }, { passive: true });
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
  // A link that opened a panel in the original stayed on the page there (data-w-stay), as did a control that switched a
  // state in place; a bare "#" link never leads anywhere either.
  var keepHere = function (el, e) {
    if (el.tagName !== 'A') return;
    if (el.hasAttribute('data-w-stay') || /^#?$/.test(el.getAttribute('href') || '')) e.preventDefault();
  };
  // Panels the original drew away from their control (data-w-panel-of): opened by their control, closed again by it, by
  // the close control inside them, by Escape or by a click outside - whichever the original did (data-w-dismiss).
  var panelOf = function (id) {
    return document.querySelector('[data-w-panel-of="' + id + '"]');
  };
  var openPanel = function (panel, open) {
    if (!panel) return;
    if (open) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
    var controls = document.querySelectorAll('[data-w-panel="' + panel.getAttribute('data-w-panel-of') + '"]');
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].hasAttribute('aria-expanded')) controls[i].setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };
  var openPanels = function () {
    var all = document.querySelectorAll('[data-w-panel-of]');
    var out = [];
    for (var i = 0; i < all.length; i++) if (!all[i].hasAttribute('hidden')) out.push(all[i]);
    return out;
  };
  var dismisses = function (panel, way) {
    return (' ' + (panel.getAttribute('data-w-dismiss') || '') + ' ').indexOf(' ' + way + ' ') >= 0;
  };
  // What "outside" is measured against: the layer itself where the area around it is the whole page (a dialog).
  var layerOf = function (area) {
    return (area.querySelector && area.querySelector('[data-w-layer]')) || area;
  };
  // A panel whose open state is in the stylesheet (an area marked wN) is open with \`is-open\`, or - one the page showed open
  // when it loaded (data-w-open, the first answer of a FAQ) - until the visitor closes it (\`is-shut\`). setOpen keeps both
  // marks and the control's aria-expanded in step, whichever way the panel is opened or closed.
  var isOpen = function (area) {
    return area.classList.contains('is-open') || (area.hasAttribute('data-w-open') && !area.classList.contains('is-shut'));
  };
  var setOpen = function (area, open, control) {
    area.classList.toggle('is-open', open);
    if (area.hasAttribute('data-w-open')) area.classList.toggle('is-shut', !open);
    var c = control && control.hasAttribute('aria-expanded') ? control : area.querySelector('[data-motion~="wt"][aria-expanded]');
    if (c) c.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  var openAreas = function (root, selector) {
    var all = root.querySelectorAll(selector);
    var out = [];
    for (var i = 0; i < all.length; i++) if (AREA.test(all[i].getAttribute('data-motion') || '') && isOpen(all[i])) out.push(all[i]);
    return out;
  };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    var open = openPanels();
    for (var i = 0; i < open.length; i++) if (dismisses(open[i], 'esc')) openPanel(open[i], false);
    // A panel whose open state is in the stylesheet: the same, by its area.
    var areas = openAreas(document, '[data-w-dismiss]');
    for (var k = 0; k < areas.length; k++) if (dismisses(areas[k], 'esc')) setOpen(areas[k], false);
  });
  // The keyboard: a control the copy switches that is not a native button (a focusable box with a button role, a link
  // acting as a toggle) answers Enter and Space with the same click the mouse gives, as the original's script made it;
  // a <button>, <summary> or form control already turns those keys into a click by itself.
  var CONTROL = '[data-w-go], [data-motion~="wt"], [data-w-panel], [data-w-note], [data-w-x]';
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var key = e.key === 'Spacebar' ? ' ' : e.key;
    if (key !== 'Enter' && key !== ' ') return;
    var el = e.target;
    if (!el || !el.matches || !el.matches(CONTROL) || el.isContentEditable) return;
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (tag === 'A' && el.hasAttribute('href') && (key === 'Enter' || el.getAttribute('role') !== 'button')) return;
    e.preventDefault();
    el.click();
  });
  var noteTimer = null;
  document.addEventListener('click', function (e) {
    var target = e.target && e.target.closest ? e.target : null;
    // The close control inside a panel.
    var x = target ? target.closest('[data-w-x]') : null;
    if (x) {
      var inPanel = x.closest('[data-w-panel-of]');
      keepHere(x, e);
      if (inPanel) {
        openPanel(inPanel, false);
        return;
      }
      var inArea = x.closest('[data-w-dismiss]');
      if (inArea && isOpen(inArea)) {
        setOpen(inArea, false);
        return;
      }
    }
    // A control that opens a panel drawn elsewhere (data-w-panel="pK").
    var opener = target ? target.closest('[data-w-panel]') : null;
    if (opener) {
      var panel = panelOf(opener.getAttribute('data-w-panel'));
      keepHere(opener, e);
      if (panel) {
        openPanel(panel, panel.hasAttribute('hidden'));
        return;
      }
    }
    // A click outside an open panel closes it, where the original closed it that way.
    var openNow = openPanels();
    for (var o = 0; o < openNow.length; o++) {
      if (!dismisses(openNow[o], 'out') || (target && (openNow[o].contains(target) || target.closest('[data-w-panel="' + openNow[o].getAttribute('data-w-panel-of') + '"]')))) continue;
      openPanel(openNow[o], false);
    }
    var outs = openAreas(document, '[data-w-dismiss]');
    for (var oa = 0; oa < outs.length; oa++) {
      if (!dismisses(outs[oa], 'out') || (target && (layerOf(outs[oa]).contains(target) || target.closest('[data-motion~="wt"]')))) continue;
      setOpen(outs[oa], false);
    }
    // A short message (data-w-note="id:ms"): shown on click, hidden again after ms (0 = until the next one).
    var note = e.target && e.target.closest ? e.target.closest('[data-w-note]') : null;
    if (note) {
      var spec = (note.getAttribute('data-w-note') || '').split(':');
      var all = document.querySelectorAll('[data-w-note-of]');
      for (var m = 0; m < all.length; m++) {
        if (all[m].getAttribute('data-w-note-of') === spec[0]) all[m].removeAttribute('hidden');
        else all[m].setAttribute('hidden', '');
      }
      keepHere(note, e);
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
      keepHere(go, e);
      touched[to[0]] = Date.now();
      // The control of the state on show, clicked again, leads to the set's "off" state where it has one (data-w-off: the
      // original closed the open item of an accordion or a FAQ).
      var owner = document.querySelector('[data-w-set="' + to[0] + '"][data-w-off]');
      if (owner) {
        var on = document.querySelectorAll('[data-w-set="' + to[0] + '"]');
        for (var o = 0; o < on.length; o++) {
          if (!on[o].hasAttribute('hidden') && rendered(on[o]) && on[o].getAttribute('data-w-i') === to[1]) {
            to[1] = owner.getAttribute('data-w-off');
            break;
          }
        }
      }
      show(to[0], to[1]);
      // A panel of a list that keeps one open at a time (data-w-alone="group:closed state"): opening it closes the others.
      var me = document.querySelector('[data-w-set="' + to[0] + '"][data-w-alone]');
      if (me) {
        var mine = (me.getAttribute('data-w-alone') || '').split(':');
        if (String(to[1]) !== mine[1]) {
          var mates = document.querySelectorAll('[data-w-alone^="' + mine[0] + ':"]');
          for (var g = 0; g < mates.length; g++) {
            var sid = mates[g].getAttribute('data-w-set');
            if (sid !== to[0]) show(sid, (mates[g].getAttribute('data-w-alone') || '').split(':')[1]);
          }
        }
      }
      return;
    }
    var t = e.target && e.target.closest ? e.target.closest('[data-motion~="wt"]') : null;
    if (!t) return;
    var area = t;
    while (area && !(area.getAttribute && AREA.test(area.getAttribute('data-motion') || ''))) area = area.parentElement;
    if (!area) return;
    keepHere(t, e);
    var open = !isOpen(area);
    setOpen(area, open, t);
    // One panel at a time in a list marked data-w-one (an accordion): the others close.
    var list = open && area.closest ? area.closest('[data-w-one]') : null;
    if (list) {
      var others = openAreas(list, '.is-open, [data-w-open]');
      for (var k = 0; k < others.length; k++) if (others[k] !== area) setOpen(others[k], false);
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
(function () {
  // Layout parts other window sizes show (data-w-lay, hidden here by the stylesheet) wait outside the page, like the
  // original's other layouts: fewer elements to style and lay out. A resize puts them all back and parks again what
  // the stylesheet hides at the new width. In a React / Next.js page this waits until the page is hydrated.
  if (window.__sasKeepLayouts) return;
  var parts = Array.prototype.slice.call(document.querySelectorAll('[data-w-lay]'));
  if (!parts.length) return;
  var parked = [];
  var park = function () {
    for (var i = 0; i < parts.length; i++) {
      var el = parts[i];
      if (!el.parentNode || window.getComputedStyle(el).display !== 'none') continue;
      var mark = document.createComment('');
      el.parentNode.replaceChild(mark, el);
      parked.push([mark, el]);
    }
  };
  var restore = function () {
    for (var i = 0; i < parked.length; i++) if (parked[i][0].parentNode) parked[i][0].parentNode.replaceChild(parked[i][1], parked[i][0]);
    parked = [];
  };
  var queued = false;
  var start = function () {
    park();
    window.addEventListener('resize', function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        restore();
        park();
      });
    });
  };
  var app = document.querySelector('script[type="module"], script[src*="/_next/"]');
  var hydrated = function () {
    var keys = Object.keys(parts[0]);
    for (var k = 0; k < keys.length; k++) if (keys[k].indexOf('__reactFiber') === 0) return true;
    return false;
  };
  if (!app) return start();
  var tries = 0;
  var wait = window.setInterval(function () {
    if (hydrated()) {
      window.clearInterval(wait);
      start();
    } else if (++tries > 100) window.clearInterval(wait);
  }, 100);
})();
`;

/** Where the app stacks (React + Vite, Next.js, MERN) serve it from: the root of the site, like their assets. */
export const MOTION_SRC = `/${MOTION_FILE}`;
/** The tag the app stacks put in each page's head (the plain-HTML build uses a path relative to the page). */
export const MOTION_TAG = `<script src="${MOTION_SRC}" defer></script>`;
