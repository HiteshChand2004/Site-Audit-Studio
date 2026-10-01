// A hover effect driven by script only (no :hover rule), like builder runtimes do: the Recreate motion capture
// has to find it by probing (4b.1).
const logo = document.querySelector('.logo');
if (logo) {
  logo.addEventListener('mouseenter', () => { logo.style.letterSpacing = '2px'; });
  logo.addEventListener('mouseleave', () => { logo.style.letterSpacing = ''; });
}
