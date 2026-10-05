// The one script the recreated site may carry (Phase 4b.4, extended for interactive parts in full-site C.2). Fixed: the same
// file for every site; it reads only the document and makes no request. The safety gate allows exactly this file
// (verify/appProfiles.js `motion`) and nothing else. Two independent parts:
//   1. scroll reveal - adds `js-motion` to <html> (the reveal rules apply only then, so a visitor without script or with
//      prefers-reduced-motion sees the finished page) and `is-in` to a `data-motion~="rv"` element when it scrolls into
//      view (removed again when it leaves, for `rp` elements);
//   2. interactive parts - the `data-w` tokens of ir/widgets.js: menus / dropdowns / accordions (click or hover, Escape and a
//      click outside close them), dialogs (Escape, a click on the backdrop or on a close button), tabs (click, arrow keys)
//      and sliders (next / previous move the track by one slide). States are the classes `w-open` / `w-shut`
//      (emit/widgetCss.js) and aria-expanded / aria-selected.
export const MOTION_FILE = 'js/motion.js';

export const MOTION_JS = `(function () {
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
  var all = document.querySelectorAll('[data-w]');
  if (!all.length) return;
  var CLOSE = /close|dismiss|cancel|\u00d7|\u2715|\u2716/i;
  var opened = [];
  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function find(token) { return document.querySelectorAll('[data-w~="' + token + '"]'); }
  function inside(entry, node) {
    if (entry.trigger.contains(node)) return true;
    for (var i = 0; i < entry.panels.length; i++) if (entry.panels[i].contains(node)) return true;
    return false;
  }
  function setState(entry, on) {
    each(entry.panels, function (p) { p.classList.toggle('w-open', on); });
    entry.trigger.setAttribute('aria-expanded', on ? 'true' : 'false');
    var at = opened.indexOf(entry);
    if (on && at < 0) opened.push(entry);
    if (!on && at >= 0) opened.splice(at, 1);
  }
  function toggle(trigger, kind, mode, id) {
    var entry = { trigger: trigger, panels: find(kind + 'p' + id), kind: kind, timer: 0 };
    if (!entry.panels.length) return;
    trigger.addEventListener('click', function (e) {
      if (trigger.tagName === 'A' || trigger.tagName === 'BUTTON') e.preventDefault();
      setState(entry, opened.indexOf(entry) < 0);
    });
    trigger.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && trigger.tagName !== 'BUTTON' && trigger.tagName !== 'A') {
        e.preventDefault();
        setState(entry, opened.indexOf(entry) < 0);
      }
    });
    if (mode === 'h') {
      var enter = function () { clearTimeout(entry.timer); setState(entry, true); };
      var leave = function () { entry.timer = setTimeout(function () { setState(entry, false); }, 150); };
      trigger.addEventListener('mouseenter', enter);
      trigger.addEventListener('mouseleave', leave);
      each(entry.panels, function (p) { p.addEventListener('mouseenter', enter); p.addEventListener('mouseleave', leave); });
    }
    if (kind === 'm') {
      each(entry.panels, function (p) {
        p.addEventListener('click', function (e) {
          var hit = e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
          if (e.target === p || (hit && p.contains(hit) && CLOSE.test((hit.getAttribute('aria-label') || '') + ' ' + hit.textContent))) {
            setState(entry, false);
            trigger.focus();
          }
        });
      });
    }
  }
  function tab(trigger, id, index) {
    trigger.addEventListener('click', function (e) {
      if (trigger.tagName === 'A') e.preventDefault();
      choose(id, index);
    });
    trigger.addEventListener('keydown', function (e) {
      var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      var next = find('bt' + id + ':' + (index + step))[0];
      if (next) { e.preventDefault(); next.focus(); choose(id, index + step); }
    });
  }
  function choose(id, index) {
    for (var i = 0; ; i++) {
      var tabs = find('bt' + id + ':' + i);
      if (!tabs.length) break;
      var on = i === index;
      each(tabs, function (t) { t.setAttribute('aria-selected', on ? 'true' : 'false'); });
      each(find('bp' + id + ':' + i), function (p) { p.classList.toggle('w-open', on); p.classList.toggle('w-shut', !on); });
    }
  }
  function slide(control, dir, id) {
    var track = find('ck' + id)[0];
    if (!track) return;
    control.addEventListener('click', function (e) {
      if (control.tagName === 'A') e.preventDefault();
      var kids = track.children;
      if (kids.length < 2) return;
      var step = kids[1].offsetLeft - kids[0].offsetLeft || kids[0].offsetWidth;
      var view = track.parentElement ? track.parentElement.clientWidth : track.clientWidth;
      var max = Math.max(0, kids.length - Math.max(1, Math.round(view / step)));
      if (track.scrollWidth > track.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(track).overflowX)) {
        track.scrollBy({ left: dir === 'n' ? step : -step, behavior: 'smooth' });
        return;
      }
      var at = Number(track.getAttribute('data-w-at') || 0) + (dir === 'n' ? 1 : -1);
      at = at > max ? 0 : at < 0 ? max : at;
      track.setAttribute('data-w-at', String(at));
      track.style.transform = 'translateX(' + -at * step + 'px)';
    });
  }
  each(all, function (el) {
    (el.getAttribute('data-w') || '').split(/\\s+/).forEach(function (t) {
      var m = /^([dm])([th])(\\d+)$/.exec(t);
      if (m) return toggle(el, m[1], m[2], m[3]);
      m = /^bt(\\d+):(\\d+)$/.exec(t);
      if (m) return tab(el, m[1], Number(m[2]));
      m = /^c([nv])(\\d+)$/.exec(t);
      if (m) slide(el, m[1], m[2]);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !opened.length) return;
    var last = opened[opened.length - 1];
    setState(last, false);
    last.trigger.focus();
  });
  document.addEventListener('click', function (e) {
    opened.slice().forEach(function (entry) {
      if (entry.kind === 'd' && !inside(entry, e.target)) setState(entry, false);
    });
  });
})();
`;

/** Where the app stacks (React + Vite, Next.js, MERN) serve it from: the root of the site, like their assets. */
export const MOTION_SRC = `/${MOTION_FILE}`;
/** The tag the app stacks put in each page's head (the plain-HTML build uses a path relative to the page). */
export const MOTION_TAG = `<script src="${MOTION_SRC}" defer></script>`;
