// A page with one of each interactive part, built the way sites build them (script-driven, no library), plus controls
// that must not count. Used by the click capture (recreate-clicks) and the rebuild (recreate-widgets) tests.
export const WIDGETS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Widgets</title>
<style>
body { margin: 0; font: 16px sans-serif; }
header { display: flex; gap: 16px; padding: 10px; }
.burger { width: 40px; height: 30px; }
.drawer { display: none; padding: 10px; background: #eee; }
.drawer.open { display: block; }
.dd { position: relative; }
.dd-panel { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #ccc; }
.dd:hover .dd-panel { display: block; }
.acc-body { display: none; }
.acc-item.open .acc-body { display: block; }
.tabs [role=tabpanel][hidden] { display: none; }
.viewport { width: 400px; overflow: hidden; }
.track { display: flex; transition: transform 0.2s; }
.slide { flex: 0 0 400px; height: 100px; background: #ddd; }
.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); }
.modal.open { display: block; }
.modal .box { background: #fff; margin: 100px auto; width: 300px; padding: 20px; }
</style></head><body>
<header>
  <button class="burger" aria-label="Open menu" aria-expanded="false" aria-controls="drawer">☰</button>
  <div class="dd"><a href="#" class="dd-trigger">Products</a><div class="dd-panel"><a href="/a.html">Item A</a><a href="/b.html">Item B</a></div></div>
  <a href="/about.html">About</a>
</header>
<nav id="drawer" class="drawer"><a href="/x.html">X</a> <a href="/y.html">Y</a></nav>
<section>
  <div class="acc-item"><button class="acc-head">Question one</button><div class="acc-body">Answer one</div></div>
  <div class="acc-item"><button class="acc-head">Question two</button><div class="acc-body">Answer two</div></div>
</section>
<details><summary>Native details</summary><p>Inside details</p></details>
<div class="tabs">
  <div role="tablist"><button role="tab" aria-selected="true" data-t="1">Tab 1</button><button role="tab" aria-selected="false" data-t="2">Tab 2</button><button role="tab" aria-selected="false" data-t="3">Tab 3</button></div>
  <div role="tabpanel" id="p1">Panel 1</div><div role="tabpanel" id="p2" hidden>Panel 2</div><div role="tabpanel" id="p3" hidden>Panel 3</div>
</div>
<div class="carousel">
  <div class="viewport"><div class="track"><div class="slide">1</div><div class="slide">2</div><div class="slide">3</div></div></div>
  <button class="prev" aria-label="Previous slide">‹</button><button class="next" aria-label="Next slide">›</button>
</div>
<button class="open-modal">Book a demo</button>
<div class="modal"><div class="box">Dialog text <button class="close">Close</button></div></div>
<button class="noop" type="button">Does nothing</button>
<div class="search"><input aria-label="Search"><button class="collapse">Collapse search bar</button></div><div class="search-closed" style="display:none">Search closed</div>
<button class="go-script">Go by script</button><button class="go-router">Go by router</button>
<a href="/elsewhere.html" class="leave">A page link</a>
<script>
const burger = document.querySelector('.burger'), drawer = document.querySelector('#drawer');
burger.addEventListener('click', () => { const o = drawer.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
document.querySelectorAll('.acc-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== 'p' + t.dataset.t; });
}));
let n = 0; const track = document.querySelector('.track');
document.querySelector('.next').addEventListener('click', () => { n = Math.min(2, n + 1); track.style.transform = 'translateX(' + (-400 * n) + 'px)'; });
document.querySelector('.prev').addEventListener('click', () => { n = Math.max(0, n - 1); track.style.transform = 'translateX(' + (-400 * n) + 'px)'; });
const modal = document.querySelector('.modal');
document.querySelector('.open-modal').addEventListener('click', () => modal.classList.add('open'));
modal.querySelector('.close').addEventListener('click', () => modal.classList.remove('open'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });
document.querySelector('.collapse').addEventListener('click', () => { document.querySelector('.search').style.display = 'none'; document.querySelector('.search-closed').style.display = 'block'; });
document.querySelector('.go-script').addEventListener('click', () => { location.href = '/elsewhere.html'; });
document.querySelector('.go-router').addEventListener('click', () => { history.pushState({}, '', '/routed'); document.title = 'Routed'; });
</script>
</body></html>`;
