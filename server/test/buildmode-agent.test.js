// Build mode's agent (src/buildmode/agent.js) with a fake Claude client: the tool loop writes a site through the text editor,
// every path stays inside the site folder, a finish while the checks fail is answered with the failures until they are fixed,
// and limits end a run. Also the workspace's path rules, the font stylesheet parser and what can be built. No network.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOLS, checkReport, runAgent, workspaceNote } from '../src/buildmode/agent.js';
import { ToolError, resolveInside, runEditor } from '../src/buildmode/workspace.js';
import { parseFontCss, prepareFonts } from '../src/buildmode/fonts.js';
import { checkBuiltSite } from '../src/buildmode/check.js';
import { unsupported } from '../src/buildmode/builds.js';
import { previewContent, previewSite, sitePages } from '../src/buildmode/browser.js';

const dirs = [];
const tempSite = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-build-site-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PAGE = (body, head = '') => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Rosa</title>\n<link rel="stylesheet" href="css/site.css">${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const PROMPT = { system: [{ type: 'text', text: 'You are the build agent.' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<project>new</project>' }] }] };

let seq = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu_${++seq}`, name, input });
const turn = (...content) => ({ stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 100, output_tokens: 50 }, model: 'claude-sonnet-5-5' });
const FINISH = { summary: 'A one-page site.', requirements: [{ id: 'R1', status: 'done', note: 'Book a table in the hero' }], placeholders: ['Opening hours'], not_done: [] };

/** A stand-in Anthropic client answering with scripted turns; records every request and the tool results it got back. */
function fakeClient(turns) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(JSON.parse(JSON.stringify(params)));
          const next = turns.shift();
          return { finalMessage: async () => (typeof next === 'function' ? next(params) : next) };
        },
      },
    },
  };
}
const lastResults = (params) => params.messages.at(-1).content;
/** A stand-in for the browser: records each look, shows no findings and one tiny screenshot. */
const fakePreview = (looks = []) => async (dir, o) => {
  looks.push(o);
  return { pages: ['/'], findings: [], shots: [{ label: '/ on phone (375 px)', data: 'AAAA' }] };
};

test('the agent writes a site through the editor, checks it, and finishes with a report', async () => {
  const site = tempSite();
  const client = fakeClient([
    turn({ type: 'text', text: 'Writing the page.' },
      use('str_replace_based_edit_tool', { command: 'create', path: '/index.html', file_text: PAGE('<main><h1>Rosa</h1><a href="#book">Book a table</a><section id="book"></section></main>', '\n<script src="js/menu.js" defer></script>') }),
      use('str_replace_based_edit_tool', { command: 'create', path: 'css/site.css', file_text: 'body { font-family: Inter, system-ui, sans-serif; }' }),
      use('str_replace_based_edit_tool', { command: 'create', path: 'js/menu.js', file_text: 'document.documentElement.classList.add("js");' })),
    turn(use('str_replace_based_edit_tool', { command: 'str_replace', path: 'css/site.css', old_str: 'body {', new_str: 'body { margin: 0;' }), use('preview_site', {}), use('check_site', {})),
    (params) => {
      assert.match(lastResults(params).at(-1).content, /All checks passed \(1 page\)/);
      return turn(use('finish', FINISH));
    },
  ]);
  const events = [];
  const looks = [];
  const out = await runAgent({ prompt: PROMPT, siteDir: site, client, onEvent: (e) => events.push(e), preview: fakePreview(looks) });
  assert.equal(looks.length, 1);

  assert.equal(out.checks.ok, true);
  assert.deepEqual(out.report, { summary: 'A one-page site.', requirements: [{ id: 'R1', status: 'done', note: 'Book a table in the hero' }], placeholders: ['Opening hours'], notDone: [] });
  assert.equal(out.turns, 3);
  assert.equal(out.usage.output_tokens, 150);
  assert.equal(readFileSync(path.join(site, 'css/site.css'), 'utf8'), 'body { margin: 0; font-family: Inter, system-ui, sans-serif; }');
  assert.ok(events.some((e) => e.type === 'action' && e.text === 'Writing index.html'));
  assert.ok(events.some((e) => e.type === 'file' && e.file === 'js/menu.js'));

  const first = client.calls[0];
  assert.equal(first.model, 'claude-sonnet-5-5');
  assert.equal(first.output_config.effort, 'medium');
  assert.deepEqual(first.tools.map((t) => t.name), ['str_replace_based_edit_tool', 'preview_site', 'check_site', 'finish']);
  const shown = client.calls[2].messages.at(-1).content.find((r) => Array.isArray(r.content));
  assert.ok(shown.content.some((b) => b.type === 'image' && b.source.media_type === 'image/jpeg'), 'the screenshots go back to Claude as images');
  assert.deepEqual(first.system, PROMPT.system, 'the composed system prompt is sent as is');
  assert.match(first.messages[0].content.at(-1).text, /<workspace>[\s\S]*no network/, 'the agent is told what it can and cannot do');
  assert.equal(client.calls[1].messages.at(-2).role, 'assistant', 'each assistant turn goes back unchanged');
});

test('a finish while the checks fail is answered with the failures, and the fix is checked again', async () => {
  const site = tempSite();
  const client = fakeClient([
    turn(use('str_replace_based_edit_tool', { command: 'create', path: 'index.html', file_text: PAGE('<h1 onclick="go()">Rosa</h1><img src="https://cdn.example/photo.jpg" alt="Pasta"><script>track()</script><a href="menu.html">Menu</a>') }), use('preview_site', {})),
    turn(use('finish', FINISH)),
    (params) => {
      const answer = lastResults(params)[0];
      assert.equal(answer.is_error, true);
      assert.match(answer.content, /onclick/);
      assert.match(answer.content, /script/i);
      assert.match(answer.content, /menu\.html/, 'a link to a page that does not exist');
      assert.match(answer.content, /another site/, 'nothing loaded from another origin');
      return turn(use('str_replace_based_edit_tool', { command: 'create', path: 'index.html', file_text: PAGE('<h1>Rosa</h1><img src="img/pasta.svg" alt="Pasta">') }),
        use('str_replace_based_edit_tool', { command: 'create', path: 'img/pasta.svg', file_text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#b5482b"/></svg>' }),
        use('str_replace_based_edit_tool', { command: 'create', path: 'css/site.css', file_text: 'body{}' }), use('preview_site', {}));
    },
    turn(use('finish', FINISH)),
  ]);
  const out = await runAgent({ prompt: PROMPT, siteDir: site, client, preview: fakePreview() });
  assert.equal(out.checks.ok, true);
  assert.equal(out.turns, 4);
});

test('paths stay inside the site folder, only website text files are written, and errors go back to Claude', async () => {
  const site = tempSite();
  for (const bad of ['../outside.html', '/../../etc/passwd', 'a/../../b.html', '..\\x.html', '%2e%2e/x.html', 'C:/x.html']) {
    await assert.rejects(resolveInside(site, bad), ToolError, bad);
  }
  assert.equal((await resolveInside(site, '/site/css/a.css')).rel, 'css/a.css', 'a leading slash or site/ means the root');
  await assert.rejects(runEditor(site, { command: 'create', path: 'run.sh', file_text: 'rm -rf /' }), /Only text files a website needs/);
  await assert.rejects(runEditor(site, { command: 'str_replace', path: 'none.html', old_str: 'a', new_str: 'b' }), /No such file/);
  await runEditor(site, { command: 'create', path: 'a.html', file_text: 'one two one' });
  await assert.rejects(runEditor(site, { command: 'str_replace', path: 'a.html', old_str: 'one', new_str: 'x' }), /appears 2 times/);
  await runEditor(site, { command: 'insert', path: 'a.html', insert_line: 0, insert_text: 'first' });
  assert.equal(readFileSync(path.join(site, 'a.html'), 'utf8'), 'first\none two one');
  assert.match((await runEditor(site, { command: 'view', path: '/' })).text, /a\.html/);
  assert.match((await runEditor(site, { command: 'view', path: 'a.html', view_range: [2, 2] })).text, /^\s+2\tone two one$/);

  const client = fakeClient([
    turn(use('str_replace_based_edit_tool', { command: 'create', path: '../escape.html', file_text: 'x' })),
    (params) => {
      assert.equal(lastResults(params)[0].is_error, true);
      assert.match(lastResults(params)[0].content, /leaves the project folder/);
      return turn(use('str_replace_based_edit_tool', { command: 'create', path: 'index.html', file_text: PAGE('<h1>Rosa</h1>').replace('<link rel="stylesheet" href="css/site.css">', '') }), use('preview_site', {}));
    },
    // a.html is no valid page: the finish is answered with that three times (the fix rounds), then accepted as it is.
    turn(use('finish', FINISH)), turn(use('finish', FINISH)), turn(use('finish', FINISH)), turn(use('finish', FINISH)),
  ]);
  const out = await runAgent({ prompt: PROMPT, siteDir: site, client, preview: fakePreview() });
  assert.equal(out.checks.ok, false, 'the run ends with the checks failing after the fix rounds');
  assert.match(out.checks.issues.join(), /a\.html/);
  assert.equal(out.turns, 6);
  assert.ok(!existsSync(path.join(path.dirname(site), 'escape.html')));
});

test('limits end a run, and a stop signal ends it between steps', async () => {
  const site = tempSite();
  const endless = () => turn(use('str_replace_based_edit_tool', { command: 'view', path: '/' }));
  await assert.rejects(runAgent({ prompt: PROMPT, siteDir: site, client: fakeClient([endless, endless, endless]), limits: { turns: 2 } }), /reached its limit/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(runAgent({ prompt: PROMPT, siteDir: site, client: fakeClient([endless]), signal: stop.signal }), /stopped/);
  const refuse = { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: {} };
  await assert.rejects(runAgent({ prompt: PROMPT, siteDir: site, client: fakeClient([refuse]) }), /declined to build this \(cyber\)/);
});

test('the report, the fonts, the workspace note and what can be built', async () => {
  assert.equal(checkReport({ summary: 1 }), null);
  assert.deepEqual(checkReport({ summary: 's', requirements: [{ id: 'R1', status: 'done', note: 'n' }, { id: 'R2', status: 'maybe' }], placeholders: ['a', 3] }).requirements.map((r) => r.id), ['R1']);
  assert.equal(AGENT_TOOLS.find((t) => t.name === 'finish').eager_input_streaming, true);

  const css = `/* cyrillic */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/v1/cyr.woff2) format('woff2'); unicode-range: U+0400-045F; }\n/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/v1/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }`;
  assert.deepEqual(parseFontCss(css).map((f) => f.subset), ['cyrillic', 'latin']);
  const site = tempSite();
  const fonts = await prepareFonts(['Inter', 'Georgia'], site, {
    fetchCss: async (family) => (family === 'Inter' ? css : null),
    fetchFile: async () => Buffer.from('wOF2'),
  });
  assert.deepEqual(fonts, { local: ['Inter'], missing: ['Georgia'], css: 'css/fonts.css' });
  const fontCss = readFileSync(path.join(site, 'css/fonts.css'), 'utf8');
  assert.match(fontCss, /url\("\.\.\/fonts\/inter-400-latin\.woff2"\)/);
  assert.ok(!fontCss.includes('cyr'), 'only latin and latin-ext faces are kept');
  assert.match(workspaceNote({ fonts }), /css\/fonts\.css already holds the @font-face rules for Inter[\s\S]*Georgia could not be made local/);

  assert.equal(unsupported({ input: { kind: 'scratch' }, stack: 'html' }), null);
  assert.match(unsupported({ input: { kind: 'scratch' }, stack: 'nextjs' }), /Plain HTML/);
  assert.match(unsupported({ input: { kind: 'url', url: 'x' } }), /new sites/);
  const empty = tempSite();
  assert.match((await checkBuiltSite(empty)).issues.join(), /index\.html is missing/);
});

test('the agent must look at its latest version before it finishes', async () => {
  const site = tempSite();
  const looks = [];
  const client = fakeClient([
    turn(use('str_replace_based_edit_tool', { command: 'create', path: 'index.html', file_text: PAGE('<h1>Rosa</h1>') }),
      use('str_replace_based_edit_tool', { command: 'create', path: 'css/site.css', file_text: 'body{}' })),
    turn(use('finish', FINISH)),
    (params) => {
      assert.equal(lastResults(params)[0].is_error, true);
      assert.match(lastResults(params)[0].content, /not looked at your latest version/);
      return turn(use('preview_site', { sizes: ['phone', 'nonsense'] }));
    },
    turn(use('str_replace_based_edit_tool', { command: 'str_replace', path: 'css/site.css', old_str: 'body{}', new_str: 'body{margin:0}' })),
    turn(use('finish', FINISH)),
    (params) => {
      assert.match(lastResults(params)[0].content, /not looked at your latest version/, 'a change after the look needs another look');
      return turn(use('preview_site', {}));
    },
    turn(use('finish', FINISH)),
  ]);
  const out = await runAgent({ prompt: PROMPT, siteDir: site, client, preview: fakePreview(looks) });
  assert.equal(out.checks.ok, true);
  assert.equal(looks.length, 2);
  assert.deepEqual(looks[0].sizes, ['phone'], 'only sizes the browser knows');
});

test('the browser preview: screenshots at three sizes and the findings a screenshot hides', async () => {
  const site = tempSite();
  await runEditor(site, { command: 'create', path: 'index.html', file_text: PAGE('<header><a href="/" class="logo">Rosa</a></header><main><p>Call [Phone]</p><div style="width:700px;height:20px">wide</div><img src="img/missing.png" alt="x"></main>') });
  await runEditor(site, { command: 'create', path: 'css/site.css', file_text: 'body{margin:0;font:16px system-ui}' });
  await runEditor(site, { command: 'create', path: 'menu/index.html', file_text: PAGE('<h1>Menu</h1>') });
  assert.deepEqual(await sitePages(site), ['/', '/menu/']);

  const p = await previewSite(site, { pages: ['/'], axe: false });
  assert.deepEqual(p.pages, ['/']);
  assert.deepEqual([...new Set(p.shots.map((s) => s.label.replace(/,.*$/, '')))], ['/ on desktop (1440 px)', '/ on tablet (768 px)', '/ on phone (375 px)']);
  const all = p.findings.join('\n');
  assert.match(all, /\/ on phone \(375 px\): the page scrolls sideways; these stick out: <div> "wide"/);
  assert.ok(!/on desktop \(1440 px\): the page scrolls sideways/.test(all), 'nothing sticks out at 1440 px');
  assert.match(all, /images that do not load: img\/missing\.png/);
  assert.match(all, /0 h1 headings/);
  assert.match(all, /1 bracketed placeholder\(s\) still visible: \[Phone\]/);
  assert.match(all, /MUST FIX — placeholders in the first screen[^\n]*\[Phone\] in <p>/, 'a placeholder in the first screen must be fixed');
  assert.match(all, /phone \(375 px\): tap targets smaller than 40 px: <a\.logo> "Rosa"/);
  const content = previewContent(p);
  assert.equal(content.filter((b) => b.type === 'image').length, p.shots.length);
});
