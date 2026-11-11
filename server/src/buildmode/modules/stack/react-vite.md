---
id: react-vite
kind: stack
version: 2
title: React + Vite
---
React 19 with Vite, as a multi-page site: every page is its own .html file (index.html, menu/index.html …) holding the page's
full <head> (title, meta description, canonical, Open Graph, JSON-LD) and a <div id="root"> its entry script renders into. Page
components under src/pages, shared pieces under src/components, styles as one global stylesheet built on the design tokens
(or CSS modules). Keep components small and presentational; state only where interaction needs it (menus, tabs, accordions).
Every page is drawn once at build time and its HTML written, so the content is there before the script runs. Plain <a> links
between pages. Only react and react-dom: no router, no other package, nothing loaded from another site.
