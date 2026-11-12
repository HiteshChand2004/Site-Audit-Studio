---
id: vue-vite
kind: stack
version: 1
title: Vue + Vite
---
Vue 3 with Vite, as a multi-page site: every page is its own .html file (index.html, menu/index.html …) holding the page's
full <head> (title, meta description, canonical, Open Graph, JSON-LD) and a <div id="app"> its entry script mounts into. Page
components and shared pieces are single-file components (.vue, <script setup> in JavaScript) under src/components, styles as
one global stylesheet built on the design tokens plus <style scoped> where a component needs its own. Keep components small
and presentational; reactive state only where interaction needs it (menus, tabs, accordions). Every page is drawn once at
build time and its HTML written, so the content is there before the script runs. Plain <a> links between pages. Only vue: no
router, no store, no other package, nothing loaded from another site.
