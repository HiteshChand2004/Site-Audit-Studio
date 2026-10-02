// The one script the recreated site may carry (Phase 4b.4): shows scroll-reveal elements when they come into view.
// Everything else about motion (hover, focus, loops, the reveal animation itself) is CSS; this file only
//   1. adds `js-motion` to <html> - the reveal rules apply only then, so a visitor without script (or with
//      prefers-reduced-motion) sees the finished page, never hidden content;
//   2. adds `is-in` to a `data-motion~="rv"` element when it scrolls into view (and removes it again when it leaves,
//      for `rp` elements: the reveal repeats, like the original's).
// It is fixed (the same for every site), reads only the document and makes no request: the safety gate allows exactly this
// file (verify/appProfiles.js `motion`) and nothing else.
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
`;
