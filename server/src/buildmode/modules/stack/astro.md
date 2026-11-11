---
id: astro
kind: stack
version: 1
title: Astro
---
Astro with static output: one .astro file per page under src/pages (index.astro is /, menu.astro is /menu/), a layout in
src/layouts holding the <html lang>, the full <head> (title, meta description, canonical, Open Graph, JSON-LD from props) and
the shared header and footer, components under src/components. Every page ships as plain HTML with its content and no
JavaScript unless a part needs interaction; that part gets a small plain <script> in its component, which Astro bundles into a
file. One global stylesheet built on the design tokens, plus scoped <style> where a component needs its own. Plain <a> links
between pages. No UI framework, no integration, no package: Astro alone, nothing loaded from another site.
