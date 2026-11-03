---
id: react-vite
kind: stack
version: 1
title: React + Vite
---
React 19 with Vite. Pages are components under src/pages, shared pieces under src/components, styles as CSS modules or one
global stylesheet built on the design tokens. Keep components small and presentational; state only where interaction needs it.
Every page is prerendered to HTML by the existing build (src/pages.js lists them), so put each page's title, description and
structured data in its page metadata, never only in client-side code. Use plain <a> links between pages.
