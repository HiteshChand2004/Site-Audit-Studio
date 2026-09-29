// Swaps data-src into src when the image scrolls into view (like common lazy-load widgets).
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.src = e.target.dataset.src;
    io.unobserve(e.target);
  }
});
document.querySelectorAll('img[data-src]').forEach((img) => io.observe(img));
