---
id: responsive
kind: quality
version: 1
title: Desktop and mobile (responsive design)
---
Every page is designed for, and works on, both desktop and mobile: phones (320–430 px), tablets (768–1024 px) and desktops
(1280–1920 px). Desktop is not a stretched phone layout, and mobile is not a squeezed desktop.
When the task keeps the existing look (an edit or an audit fix), keep the desktop design as it is and only fix what breaks or
is hard to use on smaller screens.
- Layout: mobile-first CSS with min-width media queries; fluid grids (flex / grid, fr, %, clamp()); content centred at a
  comfortable maximum width (about 1200–1280 px) on large screens. Use the width on desktop (multi-column grids, media beside
  text, a wider hero); on phones grids collapse to one column (two on tablets) and side-by-side blocks stack, headline first.
- No sideways scrolling of the page at any width from 320 px up. Wide content (tables, comparisons, code) scrolls inside its own
  container or becomes cards on phones. Images and embeds never overflow their box.
- Navigation: the full menu on desktop; on phones a compact header with a menu button that opens an accessible panel
  (aria-expanded, Escape and a close button close it, focus stays inside while open). The main call to action stays reachable
  on phones, as a sticky bottom bar when the kind of site calls for one, never covering more than about 15 % of the screen.
- Type and spacing scale with the screen (clamp()): body text at least 16 px on phones, line length 45–75 characters on desktop,
  tighter section spacing on phones.
- Touch: tap targets at least 44 × 44 px with space between them; nothing works on hover only (what hover reveals is also
  reachable by tap or focus); form fields use the right type, inputmode and autocomplete so the phone shows the right keyboard.
- Images: srcset / sizes so phones download small files; a different crop for the hero on phones where the desktop one would
  cut off faces or text; aspect-ratio or width / height so nothing shifts while loading.
- Phones: the viewport meta tag, 100dvh instead of 100vh, and safe-area insets for screens with a notch.
- Before finishing, look at every page at 375 px (phone), 768 px (tablet) and 1440 px (desktop), fix what breaks, and say in
  finish that each page was checked at those widths.
