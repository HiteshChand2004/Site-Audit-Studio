// Build mode's added stacks (src/buildmode/stacks.js): Vue + Vite, Astro and SvelteKit are built with their pinned toolchains
// like React + Vite and Next.js, Astro and SvelteKit inside the sandbox because their builds run the site's code; and any
// other technology is written as source only, with no preview, no build and a report that says so. Real builds, a real
// browser for what the built pages do, and the agent driven through its tool loop with a fake Claude client. Builds need the
// toolchains (npm run setup:toolchains -w server -- vue-vite astro sveltekit); Astro and SvelteKit need the sandbox (macOS).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { runAgent, toolsFor, workspaceNote } from '../src/buildmode/agent.js';
import { runEditor, ToolError } from '../src/buildmode/workspace.js';
import { BUILD_STACKS, projectFile, writeScaffold } from '../src/buildmode/stacks.js';
import { buildProject, checkSource } from '../src/buildmode/project.js';
import { checkBuiltSite, checkSourceProject } from '../src/buildmode/check.js';
import { sandboxAvailable } from '../src/buildmode/sandbox.js';
import { APP_PROFILES } from '../src/recreate/verify/appProfiles.js';
import { startSiteServer } from '../src/recreate/verify/server.js';
import express from 'express';
import { previewRouter, PREVIEW_PREFIX } from '../src/recreate/previewRoute.js';
import { inlineScriptHashes } from '../src/recreate/inlineScripts.js';
import { issuePreviewToken, previewPath, revokePreviewToken } from '../src/recreate/previewTokens.js';
import { toolchainStatus } from '../src/toolchains/index.js';
import { fileRuns, findText, replaceHits } from '../src/buildmode/sourcetext.js';
import { SERVER_DIR } from '../src/config/paths.js';

const VUE = BUILD_STACKS['vue-vite'];
const ASTRO = BUILD_STACKS.astro;
const KIT = BUILD_STACKS.sveltekit;
const OTHER = BUILD_STACKS.other;
const vueReady = (await toolchainStatus('vue-vite')).installed;
const astroReady = (await toolchainStatus('astro')).installed && sandboxAvailable();
const kitReady = (await toolchainStatus('sveltekit')).installed && sandboxAvailable();

const dirs = [];
const temp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-cat-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const put = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const DESCRIPTION = 'Trattoria Rosa, a family-run Italian restaurant in Pune with a wood-fired oven.';

/**
 * Opens the built site in a browser, clicks the button and returns what the page shows before and after. `preview`: through
 * the app's own preview route (sandboxed, scripts allowed by hash only), with the scripts setting the build's run gets.
 */
async function clickThrough(out, { preview = null } = {}) {
  let server;
  let address;
  let token = null;
  if (preview) {
    const app = express();
    app.use(PREVIEW_PREFIX, previewRouter({ frameAncestors: ['http://localhost'], inlineScriptHashes }));
    const listening = app.listen(0, '127.0.0.1');
    await new Promise((r) => listening.once('listening', r));
    token = issuePreviewToken({ root: out, kind: 'copy', scripts: preview.inlineBoot ? 'inline' : true });
    address = `http://127.0.0.1:${listening.address().port}${previewPath(token)}`;
    server = { close: () => new Promise((r) => listening.close(r)) };
  } else {
    server = await startSiteServer(out);
    address = `${server.origin}/`;
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(address, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const before = await page.locator('main').innerText();
    await page.getByRole('button').first().click();
    await page.waitForTimeout(200);
    return { before, after: await page.locator('main').innerText(), errors };
  } finally {
    await browser.close();
    await server.close();
    if (token) revokePreviewToken(token);
  }
}

test('the agent writes only its part of each new stack: configuration, packages and build output stay fixed', async () => {
  const dir = temp();
  const rules = (stack) => ({ writable: stack.writable, writableText: stack.writableText, listed: projectFile, text: stack.text, textText: stack.textText });
  const create = (stack, p) => runEditor(dir, { command: 'create', path: p, file_text: 'x' }, rules(stack));
  const cases = [
    [VUE, ['index.html', 'menu/index.html', 'src/components/Home.vue', 'src/pages/home.js', 'public/logo.svg'], ['vite.config.js', 'package.json', 'dist/index.html']],
    [ASTRO, ['src/pages/index.astro', 'src/layouts/Base.astro', 'src/components/Header.astro', 'src/scripts/menu.js', 'public/x.svg'], ['astro.config.mjs', 'package.json', 'src/middleware.js', 'src/pages/api.js', 'dist/index.html', '.astro/types.d.ts']],
    [KIT, ['src/routes/+page.svelte', 'src/routes/menu/+page.svelte', 'src/routes/+layout.svelte', 'src/lib/components/Header.svelte', 'static/x.svg', 'src/app.html'],
      ['vite.config.js', 'src/routes/+layout.js', 'src/routes/+page.js', 'src/routes/+page.server.js', 'src/routes/api/+server.js', 'src/hooks.server.js', 'build/index.html', '.svelte-kit/x.js']],
    [OTHER, ['README.md', 'composer.json', 'routes/web.php', 'resources/views/home.blade.php', '.env.example', 'app/main.py', 'Gemfile', 'config/routes.rb', 'Dockerfile'],
      ['.env', 'config/.env.production', 'vendor/autoload.php', 'node_modules/x.js', 'bin/tool.exe', 'public/photo.png']],
  ];
  for (const [stack, ok, refused] of cases) {
    for (const p of ok) assert.ok((await create(stack, p)).changed, `${stack.id}: ${p}`);
    for (const p of refused) await assert.rejects(create(stack, p), (err) => err instanceof ToolError, `${stack.id}: ${p}`);
  }
  // A framework's own component files are only for its stack.
  await assert.rejects(create(BUILD_STACKS['react-vite'], 'src/components/Home.vue'), /Only text files/);
});

test('the source rules read Vue, Svelte and Astro files: only the stack\'s packages, no script sink, no TypeScript', async () => {
  const dir = temp();
  put(dir, 'src/components/Home.vue', "<script setup>\nimport { ref } from 'vue';\nimport Header from './Header.vue';\n</script>\n<template><h1>Rosa</h1></template>");
  assert.deepEqual(await checkSource(VUE, dir), []);
  put(dir, 'src/components/Bad.vue', "<script setup lang=\"ts\">\nimport axios from 'axios';\nconst n: number = 1;\nfetch('/x');\n</script>");
  const vue = await checkSource(VUE, dir);
  assert.ok(vue.some((p) => /Bad\.vue: write JavaScript/.test(p)));
  assert.ok(vue.some((p) => /"axios" cannot be imported; only vue and the project's own files/.test(p)));
  assert.ok(vue.some((p) => /Bad\.vue: fetch\(\)/.test(p)));

  const astro = temp();
  put(astro, 'src/pages/index.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base><h1>Rosa</h1></Base>\n<script>import '../scripts/menu.js';</script>");
  assert.deepEqual(await checkSource(ASTRO, astro), []);
  put(astro, 'src/pages/menu.astro', "---\nimport { Image } from 'astro:assets';\nimport fs from 'node:fs';\n---\n<h1>Menu</h1>");
  const a = await checkSource(ASTRO, astro);
  assert.ok(a.some((p) => /"astro:assets" cannot be imported; only the project's own files/.test(p)));
  assert.ok(a.some((p) => /"node:fs" cannot be imported/.test(p)));

  const kit = temp();
  put(kit, 'src/routes/+page.svelte', "<script>\nimport { fade } from 'svelte/transition';\nimport Header from '#lib/components/Header.svelte';\nimport { resolve } from '$app/paths';\n</script>\n<h1>Rosa</h1>");
  assert.deepEqual(await checkSource(KIT, kit), []);
  put(kit, 'src/lib/data.js', "import { env } from '$env/dynamic/private';\nexport const x = 1;");
  assert.ok((await checkSource(KIT, kit)).some((p) => /"\$env\/dynamic\/private" cannot be imported/.test(p)));
});

test('Vue + Vite: built, every page drawn into #app, checked, and interactive in the browser', { skip: !vueReady && 'vue-vite toolchain not installed', timeout: 180000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  const written = await writeScaffold(VUE, site, { name: 'Trattoria Rosa' });
  assert.deepEqual(written.sort(), ['.gitignore', 'README.md', 'package-lock.json', 'package.json', 'vite.config.js']);
  const pkg = JSON.parse(readFileSync(path.join(site, 'package.json'), 'utf8'));
  assert.deepEqual([Object.keys(pkg.dependencies), Object.keys(pkg.devDependencies).sort()], [['vue'], ['@vitejs/plugin-vue', 'vite']]);
  assert.equal(JSON.parse(readFileSync(path.join(site, 'package-lock.json'), 'utf8')).packages['node_modules/vue'].version, pkg.dependencies.vue, 'the lockfile pins the toolchain');
  const page = (title, entry) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${DESCRIPTION}"><script type="application/ld+json">{"@type":"Restaurant","name":"Rosa"}</script></head><body><div id="app"></div><script type="module" src="/src/pages/${entry}.js"></script></body></html>\n`;
  put(site, 'index.html', page('Trattoria Rosa', 'home'));
  put(site, 'menu/index.html', page('Menu', 'menu'));
  put(site, 'src/pages/home.js', "import { createApp } from 'vue';\nimport Home from '../components/Home.vue';\nimport '../styles/site.css';\ncreateApp(Home).mount('#app');\n");
  put(site, 'src/pages/menu.js', "import { createApp } from 'vue';\nimport Menu from '../components/Menu.vue';\ncreateApp(Menu).mount('#app');\n");
  put(site, 'src/components/Home.vue', '<script setup>\nimport { ref } from \'vue\';\nconst open = ref(false);\n</script>\n<template><main><h1>Wood-fired pizza</h1><button type="button" @click="open = !open">{{ open ? \'Hide\' : \'Show\' }} hours</button><p v-if="open">Open daily from noon</p><a href="/menu/">See the menu</a></main></template>\n<style scoped>h1 { color: #b33; }</style>\n');
  put(site, 'src/components/Menu.vue', '<template><main><h1>Menu</h1><a href="/">Home</a></main></template>\n');
  put(site, 'src/styles/site.css', 'body { margin: 0; }\n');

  const built = await buildProject({ stack: VUE, dir: site, tmp: path.join(root, 'tmp') });
  assert.equal(built.ok, true, built.problems.join('\n'));
  const html = readFileSync(path.join(site, 'dist/index.html'), 'utf8');
  assert.match(html, /<div id="app"><main[^>]*><h1[^>]*>Wood-fired pizza<\/h1>/, 'the page carries its content');
  const checks = await checkBuiltSite(built.out, { app: VUE.safety });
  assert.equal(checks.ok, true, checks.issues.join('\n'));
  assert.equal(checks.pages, 2);
  const shown = await clickThrough(built.out);
  assert.deepEqual(shown.errors, []);
  assert.ok(!shown.before.includes('Open daily') && shown.after.includes('Open daily from noon'), 'the button works once Vue takes over');
});

test('Astro: built in the sandbox, plain HTML per page, its scripts as files, checked with the Astro rules', { skip: !astroReady && 'astro toolchain or sandbox not available', timeout: 180000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  const written = await writeScaffold(ASTRO, site, { name: 'Trattoria Rosa' });
  assert.deepEqual(written.sort(), ['.gitignore', 'README.md', 'astro.config.mjs', 'package-lock.json', 'package.json']);
  put(site, 'src/layouts/Base.astro', `---\nconst { title } = Astro.props;\nconst data = { '@type': 'Restaurant', name: 'Rosa' };\n---\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title><meta name="description" content="${DESCRIPTION}"><script type="application/ld+json" set:html={JSON.stringify(data)} /></head><body><slot /><script>import '../scripts/hours.js';</script></body></html>\n`);
  put(site, 'src/scripts/hours.js', "const b = document.querySelector('.hours');\nb?.addEventListener('click', () => { const p = document.querySelector('#open'); p.hidden = !p.hidden; });\n");
  put(site, 'src/pages/index.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title=\"Trattoria Rosa\"><main><h1>Wood-fired pizza</h1><button type=\"button\" class=\"hours\">Hours</button><p id=\"open\" hidden>Open daily from noon</p><a href=\"/menu/\">See the menu</a></main></Base>\n");
  put(site, 'src/pages/menu.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title=\"Menu\"><main><h1>Menu</h1><a href=\"/\">Home</a></main></Base>\n");

  const built = await buildProject({ stack: ASTRO, dir: site, tmp: path.join(root, 'tmp') });
  assert.equal(built.ok, true, built.problems.join('\n'));
  assert.ok(existsSync(path.join(site, 'dist/menu/index.html')));
  const html = readFileSync(path.join(site, 'dist/index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/_astro\/[\w.-]+\.js"><\/script>/, 'the script is a file');
  const checks = await checkBuiltSite(built.out, { app: ASTRO.safety });
  assert.equal(checks.ok, true, checks.issues.join('\n'));
  const shown = await clickThrough(built.out);
  assert.ok(!shown.before.includes('Open daily') && shown.after.includes('Open daily from noon'));
  assert.ok(!existsSync(path.join(SERVER_DIR, 'toolchains/astro/node_modules/.astro')), 'nothing was written into the shared toolchain');

  // An inline script is not the site's own file: the checks refuse it.
  put(site, 'src/pages/index.astro', "---\nimport Base from '../layouts/Base.astro';\n---\n<Base title=\"Trattoria Rosa\"><main><h1>Pizza</h1><script is:inline>document.title = 'x';</script></main></Base>\n");
  const again = await buildProject({ stack: ASTRO, dir: site, tmp: path.join(root, 'tmp') });
  assert.equal(again.ok, true, again.problems.join('\n'));
  assert.match((await checkBuiltSite(again.out, { app: ASTRO.safety })).issues.join('\n'), /index\.html: <script> element/);
});

test('SvelteKit: built and prerendered in the sandbox, its start-up script held to its shape, interactive in the browser', { skip: !kitReady && 'sveltekit toolchain or sandbox not available', timeout: 180000 }, async () => {
  const root = temp();
  const site = path.join(root, 'site');
  const written = await writeScaffold(KIT, site, { name: 'Trattoria Rosa' });
  assert.deepEqual(written.sort(), ['.gitignore', 'README.md', 'package-lock.json', 'package.json', 'src/app.html', 'src/routes/+layout.js', 'vite.config.js']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(site, 'package.json'), 'utf8')).imports, { '#lib': './src/lib', '#lib/*': './src/lib/*' });
  put(site, 'src/routes/+layout.svelte', "<script>\nimport '#lib/styles/site.css';\nlet { children } = $props();\n</script>\n{@render children()}\n");
  put(site, 'src/lib/styles/site.css', 'body { margin: 0; }\n');
  put(site, 'src/lib/components/Hours.svelte', '<script>\nlet open = $state(false);\n</script>\n<button type="button" onclick={() => (open = !open)}>Hours</button>{#if open}<p>Open daily from noon</p>{/if}\n');
  put(site, 'src/routes/+page.svelte', `<script>\nimport Hours from '#lib/components/Hours.svelte';\n</script>\n<svelte:head><title>Trattoria Rosa</title><meta name="description" content="${DESCRIPTION}" /></svelte:head>\n<main><h1>Wood-fired pizza</h1><Hours /><a href="/menu/">See the menu</a></main>\n`);
  put(site, 'src/routes/menu/+page.svelte', `<svelte:head><title>Menu</title><meta name="description" content="${DESCRIPTION}" /></svelte:head>\n<main><h1>Menu</h1><a href="/">Home</a></main>\n`);
  put(site, 'static/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n');

  const built = await buildProject({ stack: KIT, dir: site, tmp: path.join(root, 'tmp') });
  assert.equal(built.ok, true, built.problems.join('\n'));
  assert.ok(existsSync(path.join(site, 'build/menu/index.html')), 'every page prerendered');
  assert.ok(!existsSync(path.join(site, 'node_modules')), 'the project\'s own node_modules folder is removed after the build');
  assert.ok(!existsSync(path.join(SERVER_DIR, 'toolchains/sveltekit/node_modules/$app')), 'nothing was written into the shared toolchain');
  const html = readFileSync(path.join(site, 'build/index.html'), 'utf8');
  assert.match(html, /<h1>Wood-fired pizza<\/h1>/);
  const checks = await checkBuiltSite(built.out, { app: KIT.safety });
  assert.equal(checks.ok, true, checks.issues.join('\n'));
  const shown = await clickThrough(built.out);
  assert.deepEqual(shown.errors, []);
  assert.ok(!shown.before.includes('Open daily') && shown.after.includes('Open daily from noon'), 'the page is hydrated');
  // In the app's preview its start-up script is allowed by its hash, so the page comes alive there too.
  const previewed = await clickThrough(built.out, { preview: KIT });
  assert.deepEqual(previewed.errors, []);
  assert.ok(previewed.after.includes('Open daily from noon'), 'hydrated inside the sandboxed preview');

  // The start-up script is allowed only in its own shape: data, another address or more code is refused.
  const boot = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(path.join(site, 'build/menu/index.html'), 'utf8'))[1];
  const allowed = (text) => APP_PROFILES.sveltekit.scriptAllowed({ text });
  assert.equal(allowed(boot), true, 'a nested page\'s own start-up script');
  assert.equal(allowed(boot.replace(/data: \[null(,null)*\]/, 'data: [{ x: 1 }]')), false);
  assert.equal(allowed(boot.replace(/\.\.\/_app/g, 'https://evil.example/_app')), false);
  assert.equal(allowed(`${boot}\nfetch('/x');`), false);
});

test('SvelteKit and Astro: code that runs during the build cannot read the server\'s files, write outside its project or reach the network', { skip: !(kitReady && astroReady) && 'toolchains or sandbox not available', timeout: 300000 }, async () => {
  const secret = path.join(SERVER_DIR, 'package.json');
  const outside = path.join(path.dirname(SERVER_DIR), `sandbox-escape-${process.pid}.txt`);
  const probe = `import { readFileSync, writeFileSync } from 'node:fs';
const attempt = (f) => { try { return 'got ' + String(f()).slice(0, 8); } catch (e) { return 'blocked'; } };
export const read = attempt(() => readFileSync(${JSON.stringify(secret)}, 'utf8'));
export const wrote = attempt(() => { writeFileSync(${JSON.stringify(outside)}, 'x'); return 'yes'; });
export async function net() { try { await fetch('https://example.com', { signal: AbortSignal.timeout(5000) }); return 'got'; } catch { return 'blocked'; } }
`;
  // The source rules would refuse these imports and the fetch; the sandbox must hold even when they are let through.
  const astroRoot = temp();
  const astroSite = path.join(astroRoot, 'site');
  await writeScaffold(ASTRO, astroSite);
  put(astroSite, 'src/data/probe.js', probe);
  put(astroSite, 'src/pages/index.astro', "---\nimport { read, wrote, net } from '../data/probe.js';\nconst reached = await net();\n---\n<html lang=\"en\"><body><p id=\"read\">{read}</p><p id=\"wrote\">{wrote}</p><p id=\"net\">{reached}</p></body></html>\n");
  const kitRoot = temp();
  const kitSite = path.join(kitRoot, 'site');
  await writeScaffold(KIT, kitSite);
  put(kitSite, 'src/lib/probe.js', probe);
  put(kitSite, 'src/routes/+page.svelte', "<script>\nimport { read, wrote } from '#lib/probe.js';\n</script>\n<p id=\"read\">{read}</p><p id=\"wrote\">{wrote}</p>\n");
  for (const [stack, site, root, out] of [[ASTRO, astroSite, astroRoot, 'dist'], [KIT, kitSite, kitRoot, 'build']]) {
    const built = await buildProject({ stack, dir: site, tmp: path.join(root, 'tmp'), source: async () => [] });
    assert.equal(built.ok, true, built.problems.join('\n'));
    const html = readFileSync(path.join(site, out, 'index.html'), 'utf8');
    for (const id of stack === ASTRO ? ['read', 'wrote', 'net'] : ['read', 'wrote']) assert.match(html, new RegExp(`id="${id}">blocked<`), `${stack.id}: ${id}`);
  }
  assert.ok(!existsSync(outside));
});

test('the words of Vue, Svelte and Astro files can be changed after the build, and only where no code is', () => {
  const svelte = '<script>\nconst dishes = ["Margherita", "Diavola"];\nlet open = $state(false);\n</script>\n<h1 class="big">Wood-fired pizza</h1>\n<img alt="Our oven" src="/o.webp" />\n<p>Hello {name}</p>\n<button onclick={() => (open = !open)} aria-label="Open menu">Menu</button>\n{#if open}<nav>Links</nav>{/if}\n';
  const runs = fileRuns('src/routes/+page.svelte', svelte);
  const once = (text) => findText(svelte, runs, text, { whole: true }).length;
  assert.deepEqual(['Wood-fired pizza', 'Margherita', 'Menu', 'Links', 'Hello'].map(once), [1, 1, 1, 1, 0], 'a text holding an expression is never a place to write');
  assert.equal(findText(svelte, runs, 'Our oven', { whole: false }).length, 1);
  // A brace written by the owner must stay text, never become an expression.
  const changed = replaceHits(svelte, findText(svelte, runs, 'Wood-fired pizza', { whole: true }), 'Pizza {from} the <oven>');
  assert.match(changed, /<h1 class="big">Pizza &#123;from&#125; the &lt;oven&gt;<\/h1>/);

  const vue = '<script setup>\nimport { ref } from \'vue\';\n</script>\n<template><main><h1>Menu</h1><button @click="open = !open" :title="label">{{ open ? \'Hide\' : \'Show\' }} hours</button><a href="/">See the menu</a></main></template>\n<style scoped>h1 { color: red; }</style>\n';
  const vr = fileRuns('src/components/Menu.vue', vue);
  assert.deepEqual(['Menu', 'See the menu', 'hours', 'vue', 'red'].map((t) => findText(vue, vr, t, { whole: true }).length), [1, 1, 0, 0, 0]);
  assert.ok(!vr.some((r) => r.name === '@click' || r.name === ':title'), 'bound attributes and events are code');

  const astro = '---\nconst title = "Trattoria Rosa";\n---\n<Base title={title}><main><h1>Menu</h1></main></Base>\n';
  const ar = fileRuns('src/pages/menu.astro', astro);
  assert.deepEqual(['Trattoria Rosa', 'Menu', 'const title'].map((t) => findText(astro, ar, t, { whole: true }).length), [1, 1, 0]);
});

test('another technology is written as source only: no preview, no check, a README required, and the report says so', async () => {
  assert.deepEqual(toolsFor(OTHER).map((t) => t.name), ['str_replace_based_edit_tool', 'finish']);
  assert.deepEqual(toolsFor(VUE).map((t) => t.name), ['str_replace_based_edit_tool', 'preview_site', 'check_site', 'finish']);
  const note = workspaceNote({ stack: OTHER, fonts: { css: 'css/fonts.css', local: ['Inter'], missing: [] }, images: [{ path: 'assets/images/photo-1.webp', url: '/images/photo-1.webp', role: 'photo', width: 800, height: 600, alt: 'Our oven' }] });
  assert.match(note, /nothing is installed, built or run here/);
  assert.match(note, /assets\/css\/fonts\.css already holds/);
  assert.match(note, /assets\/images\/photo-1\.webp/);
  assert.doesNotMatch(note, /preview_site:/);

  const site = temp();
  let seq = 0;
  const use = (name, input) => ({ type: 'tool_use', id: `tu_${++seq}`, name, input });
  const turn = (...content) => ({ stop_reason: 'tool_use', content, usage: { input_tokens: 10, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
  const write = (p, text) => use('str_replace_based_edit_tool', { command: 'create', path: p, file_text: text });
  const report = { summary: 'Built.', requirements: [], placeholders: [], not_done: ['The site was not built or tested on this server.'] };
  const results = [];
  const turns = [
    turn(write('composer.json', '{ "require": { "php": "^8.3", "laravel/framework": "12.0.0" } }'), write('routes/web.php', "<?php\nRoute::view('/', 'home');\n"), use('preview_site', {})),
    (params) => { results.push(params.messages.at(-1).content); return turn(use('finish', report)); },
    (params) => { results.push(params.messages.at(-1).content); return turn(write('README.md', `# Trattoria Rosa\n\nLaravel 12 on PHP 8.3.\n\n${'composer install, then php artisan serve. '.repeat(10)}`)); },
    turn(use('finish', report)),
  ];
  const calls = [];
  const client = { beta: { messages: { stream(params) {
    calls.push(params.tools.map((t) => t.name));
    const next = turns.shift();
    return { finalMessage: async () => (typeof next === 'function' ? next(params) : next) };
  } } } };
  const out = await runAgent({ prompt: { system: [{ type: 'text', text: 'agent' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<project>Laravel</project>' }] }] }, siteDir: site, client, stack: OTHER, preview: async () => assert.fail('nothing is previewed') });
  assert.deepEqual(calls[0], ['str_replace_based_edit_tool', 'finish']);
  assert.match(results[0].at(-1).content, /source only: nothing can be built, previewed or checked here/);
  assert.match(results[1][0].content, /README\.md is missing/, 'a finish without a README is sent back');
  assert.equal(out.checks.ok, true);
  assert.equal(out.checks.sourceOnly, true);
  assert.deepEqual(out.report.notDone, ['The site was not built or tested on this server.']);
  assert.deepEqual(readdirSync(site, { recursive: true }).sort(), ['README.md', 'composer.json', 'routes', 'routes/web.php']);
  assert.deepEqual((await checkSourceProject(site, ['README.md'])).issues, ['The project has no files besides its README.']);
});
