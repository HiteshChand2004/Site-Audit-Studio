---
id: performance
kind: quality
version: 1
title: Speed (Core Web Vitals)
---
Target LCP under 2.5 s, CLS under 0.1 and minimal blocking on a mid-range phone. Images: modern formats (WebP/AVIF), explicit
width and height, responsive sizes, loading="lazy" below the first screen and fetchpriority="high" on the main hero image.
Fonts: at most two families, woff2, font-display: swap, preload the main one. CSS small and per page where the stack allows;
JavaScript only where needed, deferred. No layout shifts from late-loading content.
