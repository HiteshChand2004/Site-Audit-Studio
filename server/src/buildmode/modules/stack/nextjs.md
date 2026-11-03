---
id: nextjs
kind: stack
version: 1
title: Next.js (App Router, static export)
---
Next.js App Router with output: 'export'. Each page is app/<route>/page.jsx exporting `metadata` (title, description,
openGraph, alternates.canonical). Shared components in components/. Server components by default; add 'use client' only to the
small parts that need interaction. Use next/font for fonts and plain <img> with width and height (static export). Add JSON-LD
as a <script type="application/ld+json"> in the page.
