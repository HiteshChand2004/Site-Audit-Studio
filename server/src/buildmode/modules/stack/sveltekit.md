---
id: sveltekit
kind: stack
version: 1
title: SvelteKit
---
SvelteKit with Svelte 5, every page prerendered to static HTML (adapter-static): one +page.svelte per route under src/routes
(src/routes/+page.svelte is /, src/routes/menu/+page.svelte is /menu/), a root +layout.svelte with the shared header and footer
and the global stylesheet, each page's <svelte:head> with its title, meta description, canonical, Open Graph and JSON-LD.
Components under src/lib/components (imported through #lib), written with runes ($state, $props, $derived) in JavaScript; state
only where interaction needs it (menus, tabs, accordions). One global stylesheet built on the design tokens, plus scoped
<style> where a component needs its own. Plain <a> links between pages, every page reached by a link. No load functions, no
server code, no package beyond SvelteKit and Svelte, nothing loaded from another site.
