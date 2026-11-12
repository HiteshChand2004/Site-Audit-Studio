---
id: nextjs
kind: stack
version: 2
title: Next.js (App Router, static export)
---
Next.js App Router with output: 'export'. Each page is app/<route>/page.jsx exporting `metadata` (title, description,
openGraph, alternates.canonical); app/layout.jsx holds <html lang>, the shared header and footer and the global stylesheet.
Shared components in components/. Server components by default; add 'use client' only to the small parts that need
interaction. Fonts are local files linked from the layout (never next/font, which downloads at build time); plain <img> with
width and height (static export). Add JSON-LD as a <script type="application/ld+json"> in the page. Only next, react and
react-dom: no other package, no route handlers, nothing loaded from another site.
