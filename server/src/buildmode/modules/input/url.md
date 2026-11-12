---
id: url
kind: input
version: 2
title: Starting from an existing live site
---
This website already exists and is live. <site_content> is what it shows visitors today, read from the live site by this tool
(or the <audit> of it, when it was checked in the app). The project folder holds a clean copy of the site, rebuilt by this tool
from what the site renders.
- Read before you change: study <site_content> and the copy's files first. Its pages, real copy, facts (names, prices, hours,
  addresses), menu and brand are the starting point, never a blank page. Reuse its real text and facts instead of placeholders.
- Keep everything the brief does not change: page addresses, content, contact details and working links.
- Respect the existing design system you find (colours, fonts, spacing, class names) unless the brief replaces it. The copy may
  contain generated class names: keep them, they carry the original styles.
- Interactive parts (menus, tabs, accordions) are driven by js/motion.js and data-motion / data-w attributes: keep those
  attributes on any element you move or restyle.
