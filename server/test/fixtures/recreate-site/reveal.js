// Scroll reveal like builder "appear" effects (with replay): an element is hidden until it scrolls
// into view and hidden again when it leaves. .appear-half needs half of the element in view (like an
// "amount" setting), so a tall element crossing the fold starts hidden.
const observe = (selector, threshold) => {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const shown = e.isIntersecting && e.intersectionRatio >= threshold;
      e.target.style.opacity = shown ? '1' : '0';
      e.target.style.transform = shown ? 'none' : 'translateY(40px)';
    }
  }, { threshold: [0, threshold] });
  document.querySelectorAll(selector).forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(40px)';
    el.style.transition = 'opacity 0.4s, transform 0.4s';
    io.observe(el);
  });
};
observe('.appear', 0);
observe('.appear-half', 0.5);
