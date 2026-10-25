// The conversion of a finished as-is page into components (recreate/convert/document.js): the rules that decide what
// becomes JSX, what is kept as the original HTML (and why), how a page is split into sections, how pages share a section,
// and how a form is described in plain words. No browser: the end-to-end proof is convert-next.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { convertDocument, convertSite, formsOf, planAttributes, planSections, rootAttributes, sectionHost, sectionName, whereOf } from '../src/recreate/convert/document.js';

const doc = (body, { head = '<meta charset="utf-8"><title>T</title>', html = ' lang="en"', bodyAttrs = '' } = {}) => `<!doctype html><html${html}><head>${head}</head><body${bodyAttrs}>${body}</body></html>`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('attributes follow the React emitter rules: class, for, style objects, booleans, defaults, custom elements, SVG names', () => {
  assert.deepEqual(planAttributes('div', { class: 'a b', style: 'color: red; --x: 1' }), { props: ['className="a b"', 'style={{"color":"red","--x":"1"}}'] });
  assert.deepEqual(planAttributes('label', { for: 'q', tabindex: '0' }), { props: ['htmlFor="q"', 'tabIndex="0"'] });
  assert.deepEqual(planAttributes('input', { type: 'checkbox', checked: '', value: 'v', disabled: 'disabled' }), { props: ['type="checkbox"', 'defaultChecked', 'defaultValue="v"', 'disabled'] });
  // A custom element keeps its HTML names: React writes its props as the attributes they are named.
  assert.deepEqual(planAttributes('x-card', { for: 'a', tabindex: '0', checked: '' }), { props: ['for="a"', 'tabindex="0"', 'checked=""'] });
  assert.deepEqual(planAttributes('svg', { viewBox: '0 0 8 8', 'stroke-width': '2', 'xlink:href': '#a' }), { props: ['viewBox="0 0 8 8"', 'strokeWidth="2"', 'xlinkHref="#a"'] });
  // An inline style on an <svg> is an object too: React stops the build on a style written as text (found on a builder's site).
  assert.deepEqual(planAttributes('svg', { style: 'width:100%;height:100%;overflow: visible;' }), { props: ['style={{"width":"100%","height":"100%","overflow":"visible"}}'] });
  assert.deepEqual(planAttributes('img', { srcset: 'a 1x', fetchpriority: 'high', crossorigin: '' }), { props: ['srcSet="a 1x"', 'fetchPriority="high"', 'crossOrigin=""'] });
});

test('what React cannot write exactly is a fallback, each with its reason', () => {
  assert.deepEqual(planAttributes('button', { onclick: 'go()' }), { fail: 'an inline event handler, which React cannot write as text', attribute: 'onclick' });
  assert.deepEqual(planAttributes('div', { hidden: 'until-found' }), { fail: 'a value React would drop (hidden="until-found")', attribute: 'hidden' });
  assert.deepEqual(planAttributes('a', { href: ' javascript:void(0)' }), { fail: 'a javascript: address, which React blocks', attribute: 'href' });
  assert.equal(planAttributes('div', { '@click': 'x' }).attribute, '@click');
  assert.equal(planAttributes('div', { key: '1' }).attribute, 'key');
  assert.equal(planAttributes('div', { style: 'color: red; color: blue' }).attribute, 'style', 'a repeated declaration cannot be a style object');
  // hidden="" and hidden="hidden" are the boolean, written as the prop.
  assert.deepEqual(planAttributes('div', { hidden: 'hidden' }), { props: ['hidden'] });
});

test('a page: head as JSX, sections as components, raw fallbacks recorded with where and why, comments kept', () => {
  const html = doc(
    '<!-- a comment -->\n<header class="site-header"><a href="/about.html?x=1#top">About</a><button onclick="m()">Menu</button></header>'
    + '<main><h1 style="color:red">Hi &amp; bye</h1><p>a &lt; b</p><svg viewBox="0 0 1 1"><circle r="1"/></svg>'
    + '<meta name="x" content="y"><textarea>l1\nl2</textarea><select><option value="a">A</option><option value="b" selected>B</option></select></main>'
    + '<script src="/app.js" async></script><footer><p>f</p></footer><script>b()</script>',
    { head: '<meta charset="utf-8">\n  <title>T</title>\n  <link rel="stylesheet" href="/s.css" media="print" onload="this.media=\'all\'">\n<script>if (1 < 2) a()</script>', html: ' lang="en" class="no-js" onload="x()"', bodyAttrs: ' class="b"' },
  );
  const c = convertDocument(html, { page: '/', pageUrl: 'https://example.com/', linkMap: { '/about.html': '/about/' } });
  assert.deepEqual(c.html, { props: { lang: 'en', className: 'no-js' }, raw: { onload: 'x()' } });
  assert.deepEqual(c.body, { props: { className: 'b' }, raw: {} });
  // The head: whitespace between elements left out (no two text nodes side by side), the script's text raw, the link a fallback.
  assert.equal(c.headJsx, `<meta charSet="utf-8" /><title>T</title><RawHtml b64="${b64('<link rel="stylesheet" href="/s.css" media="print" onload="this.media=\'all\'">')}" /><script dangerouslySetInnerHTML={{ __html: "if (1 < 2) a()" }} />`);
  assert.deepEqual(c.sections.map((s) => s.name), ['SiteHeader', 'MainContent', 'SiteFooter']);
  // The comment is kept (a React-rendered site reads its comments back as hydration markers), and is not a fallback.
  assert.equal(c.pageJsx, `<RawHtml comment={" a comment "} />{"\\n"}<SiteHeader /><MainContent /><RawHtml b64="${b64('<script src="/app.js" async=""></script>')}" /><SiteFooter /><script dangerouslySetInnerHTML={{ __html: "b()" }} />`);
  const header = c.sections[0].jsx;
  assert.match(header, /<a href="\/about\/\?x=1#top">About<\/a>/, 'a moved page is linked at its new address, query and fragment kept');
  assert.match(header, /<RawHtml b64="[A-Za-z0-9+/=]+" \/><\/header>$/, 'the button with its handler is kept as original HTML');
  const main = c.sections[1].jsx;
  assert.match(main, /<h1 style=\{\{"color":"red"\}\}>\{"Hi & bye"\}<\/h1><p>\{"a < b"\}<\/p>/, 'entities are text, written as strings');
  assert.match(main, /<svg viewBox="0 0 1 1" dangerouslySetInnerHTML=\{\{ __html: "<circle r=\\"1\\"><\/circle>" \}\} \/>/, 'inline SVG keeps its markup');
  assert.match(main, /<textarea defaultValue=\{"l1\\nl2"\} \/>/);
  assert.match(main, /<select defaultValue="b"><option value="a">A<\/option><option value="b">B<\/option><\/select>/, 'the chosen option is the select\'s default');
  assert.deepEqual(c.fallbacks.map((f) => [f.where, f.tag, f.attribute ?? null, f.reason]), [
    ['head > link', 'link', 'onload', 'an inline event handler, which React cannot write as text'],
    ['body.b > header.site-header > button', 'button', 'onclick', 'an inline event handler, which React cannot write as text'],
    ['body.b > main > meta', 'meta', null, 'an element React 19 moves into the head when it stands in the body'],
    ['body.b > script', 'script', null, 'an async script, which React 19 moves to the head'],
  ]);
  assert.equal(c.stats.raw, 4);
  assert.ok(c.stats.elements > 10);
});

test('the sections are the children of the body, or of the one wrapper that holds the page; names from landmarks, ids, classes', () => {
  const $ = cheerio.load(doc('<div id="app"><div class="page"><header>h</header><section id="hero-area">s</section><div class="cards grid">c</div><div>d</div></div></div><script>x()</script>'));
  const host = sectionHost($('body').get(0));
  assert.equal(host.attribs.class, 'page', 'two wrappers deep: the host is the element with several children');
  const names = host.children.filter((n) => n.type === 'tag').map((el, i) => sectionName(el, i));
  assert.deepEqual(names, ['SiteHeader', 'HeroArea', 'Cards', 'Section4']);
  assert.equal(whereOf(host.children.find((n) => n.name === 'section')), 'body > div#app > div.page > section#hero-area');
});

test('a builder page nested in wrappers is split into its real sections; lists, titled sections and stray tags stay whole', () => {
  // Framer-like: the page sits three boxes deep with generated class names; a <link> and a script stand among the sections.
  const card = (t) => `<div class="framer-card1x"><h3>${t}</h3><p>About ${t}, in a few words.</p></div>`;
  const body = '<div id="main"><div class="framer-QQPsi"><div class="framer-a1b2c3">'
    + '<link rel="stylesheet" href="/late.css">'
    + '<div class="framer-1mrr0jq-container"><nav class="framer-Nv1x"><a href="/">Home</a><a href="/about/">About</a></nav></div>'
    + '<div class="framer-38voy7"><h1>Law, made simple</h1><p>One line under the heading.</p><a href="/start/">Start</a></div>'
    + `<div class="framer-1pgy074"><h2>Our services</h2><div class="framer-grid9z">${card('Search')}${card('Draft')}${card('Review')}</div></div>`
    + '<div class="framer-19ddfgb"><h2><span>U</span><span>nifying </span><span>legal </span><span>work</span></h2><p>Text.</p><img src="/a.png" alt=""></div>'
    + `<div class="framer-cards44">${card('One')}${card('Two')}${card('Three')}</div>`
    + '<div class="framer-empty1"></div><script>window.x = 1</script>'
    + '<div class="framer-1df3djo-container"><footer class="framer-Tx7yw"><p>© Nyaay</p></footer></div>'
    + '</div></div></div>';
  const html = doc(body);
  const $ = cheerio.load(html);
  const parts = planSections($('body').get(0));
  assert.deepEqual(parts.map((p) => p.el.attribs.class), ['framer-Nv1x', 'framer-38voy7', 'framer-1pgy074', 'framer-19ddfgb', 'framer-cards44', 'framer-Tx7yw'],
    'the nav and the footer are found inside their containers; a titled section and a list of cards are not cut up; the link, the script and the empty box are no section');
  const c = convertDocument(html, { page: '/' });
  assert.deepEqual(c.sections.map((s) => s.name), ['SiteNav', 'Hero', 'OurServices', 'UnifyingLegalWork', 'One', 'SiteFooter'],
    'names from landmarks, the main heading, the heading words (a word split into spans read as one), never from generated classes');
  // Only which elements become components changed: every section once, in order, inside the original wrappers.
  assert.match(c.pageJsx, /^<div id="main"><div className="framer-QQPsi"><div className="framer-a1b2c3"><RawHtml b64="[^"]+" \/><div className="framer-1mrr0jq-container"><SiteNav \/><\/div><Hero \/><OurServices \/><UnifyingLegalWork \/><One \/><div className="framer-empty1" \/><script dangerouslySetInnerHTML=\{\{ __html: "window.x = 1" \}\} \/><div className="framer-1df3djo-container"><SiteFooter \/><\/div><\/div><\/div><\/div>$/);
  assert.match(c.sections[2].jsx, /^<div className="framer-1pgy074"><h2>Our services<\/h2><div className="framer-grid9z">(<div className="framer-card1x">.*?<\/div>){3}<\/div><\/div>$/);

  // A plain page keeps its landmarks as the sections, and a small main is not cut into its paragraphs.
  const plain = convertDocument(doc('<header><a href="/">Home</a></header><main><h1>Hi</h1><p>One</p><p>Two</p></main><footer>f</footer>'), { page: '/' });
  assert.deepEqual(plain.sections.map((s) => s.name), ['SiteHeader', 'MainContent', 'SiteFooter']);

  // A large main holding several sections with their own headings is split into them.
  const sec = (h, n) => `<div class="part"><h2>${h}</h2>${'<p>text</p>'.repeat(n)}</div>`;
  const big = convertDocument(doc(`<header><a href="/">Home</a></header><main>${sec('Why us', 6)}${sec('Pricing plans', 6)}${sec('Contact', 6)}</main><footer>f</footer>`), { page: '/' });
  assert.deepEqual(big.sections.map((s) => s.name), ['SiteHeader', 'WhyUs', 'PricingPlans', 'Contact', 'SiteFooter']);
  assert.match(big.pageJsx, /<main><WhyUs \/><PricingPlans \/><Contact \/><\/main>/, 'the main element itself stays where it was');
});

test('a comment with quotes and line breaks is written as a JS string, which JSX reads back exactly', () => {
  const c = convertDocument(doc('<!-- the "appear" effect:\n - one\n - two --><main><h1>Hi</h1></main>'), { page: '/' });
  assert.ok(c.pageJsx.startsWith('<RawHtml comment={" the \\"appear\\" effect:\\n - one\\n - two "} />'), c.pageJsx.slice(0, 120));
});

test('a section identical on several pages is one shared component; a page keeps its own name space', () => {
  const header = '<header class="site-header"><a href="/">Home</a></header>';
  const site = convertSite([
    { page: '/', html: doc(`${header}<main><h1>Home</h1></main><footer>f</footer>`) },
    { page: '/about/', html: doc(`${header}<main><h1>About</h1></main><footer>f</footer>`) },
    { page: '/other/', html: doc('<header class="site-header"><a href="/">Other</a></header><main>o</main>') },
  ]);
  assert.deepEqual(site.shared.map((s) => [s.name, s.pages]), [['SiteHeader', ['/', '/about/']], ['SiteFooter', ['/', '/about/']]]);
  assert.deepEqual(site.pages[0].sections.map((s) => [s.name, s.shared]), [['SiteHeader', true], ['MainContent', false], ['SiteFooter', true]]);
  assert.deepEqual(site.pages[2].sections.map((s) => [s.name, s.shared]), [['SiteHeader', false], ['MainContent', false]], 'a different header is the page\'s own');
  assert.equal(site.stats.components, 2 + 1 + 1 + 2, 'shared ones once, own ones per page');
  assert.equal(site.stats.raw, 0);
});

test('forms in plain words: where the original sent them and whether the copy keeps them working', () => {
  const guarded = cheerio.load(doc('<form id="contact" action="/send" method="post"><input name="email"><input type="hidden" name="t"><button>Go</button></form><script>window.sasFormGuard = 1</script>'));
  const [f] = formsOf(guarded, { page: '/contact/', pageUrl: 'https://example.com/contact.html' });
  assert.equal(f.label, 'contact');
  assert.equal(f.method, 'POST');
  assert.equal(f.target, 'the original site (example.com/send)');
  assert.deepEqual(f.fields, ['email'], 'hidden fields and buttons are not fields a visitor fills');
  assert.equal(f.worksWithoutOriginal, true, 'the copy\'s form guard holds it: nothing goes to the original');
  assert.match(f.note, /keeps working if they are shut down/);

  const open = cheerio.load(doc('<form action="https://forms.service.test/abc"><input type="password" name="p"><input type="file" name="f"></form><form action="mailto:a@b.c"><input name="x"></form><form><select name="s"></select></form>'));
  const forms = formsOf(open, { page: '/', pageUrl: 'https://example.com/' });
  assert.equal(forms[0].target, 'another service (forms.service.test)');
  assert.equal(forms[0].password, true);
  assert.equal(forms[0].file, true);
  assert.equal(forms[0].worksWithoutOriginal, false);
  assert.match(forms[0].note, /stops working until it is connected elsewhere/);
  assert.match(forms[1].target, /mail or phone app/);
  assert.equal(forms[2].target, 'the same page');
});

test('root attributes: what React writes and what the build step writes afterwards', () => {
  assert.deepEqual(rootAttributes({ lang: 'en', class: 'a', 'data-theme': 'dark', onload: 'x()', hidden: '' }), { props: { lang: 'en', className: 'a', 'data-theme': 'dark', hidden: true }, raw: { onload: 'x()' } });
  assert.deepEqual(rootAttributes(undefined), { props: {}, raw: {} });
});
