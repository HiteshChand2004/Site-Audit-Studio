// Step 6 (a): the address pass at download (copy/addressPass.js). A finished as-is copy made without an address gets the new
// site's address in the head tags and site files that name one, with the same code as the full fix stage (fixAsIs.js
// applyAddress / addressFiles), on a fresh folder; everything else stays byte for byte the same, and a wrong write is undone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { addressPass } from '../src/copy/addressPass.js';
import { fixAsIsCopy } from '../src/copy/fixAsIs.js';
import { ADDRESS_FIELDS, HEAD_META_FIELDS, fixGroup, fixOf } from '../src/copy/fixRegistry.js';

const SITE = 'https://www.acme-old.dev/';
const NEW = 'https://www.acme-new.dev';
const PAGES = [
  { path: '/', outPath: 'index.html', url: SITE },
  { path: '/about', outPath: 'about.html', url: `${SITE}about` },
  { path: '/contact', outPath: 'contact.html', url: `${SITE}contact` },
];
const page = (head, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

async function finishedCopy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-addr-'));
  const copy = path.join(dir, 'copy');
  await mkdir(path.join(copy, 'img'), { recursive: true });
  await writeFile(path.join(copy, 'index.html'), page(
    `<title>Acme tools for builders</title><link rel="canonical" href="${SITE}"><meta property="og:url" content="${SITE}">`
      + `<meta property="og:image" content="${SITE}img/hero.png"><meta name="twitter:image" content="${SITE}img/not-copied.png">`
      + `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","url":"https:\\/\\/www.acme-old.dev\\/"}</script>`,
    '<h1>Acme</h1><p>We make tools.</p><a href="about.html">About</a>'));
  await writeFile(path.join(copy, 'about.html'), page('<title>About Acme and its people</title><meta property="og:image" content="img/hero.png">',
    '<h1>About</h1><p>Our story.</p>'));
  await writeFile(path.join(copy, 'contact.html'), page('<title>Contact Acme today</title><meta name="robots" content="noindex">',
    '<h1>Contact</h1><form><input name="e"></form>'));
  await writeFile(path.join(copy, 'img', 'hero.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await writeFile(path.join(copy, 'styles.css'), 'body{color:#111}');
  await writeFile(path.join(copy, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
  await writeFile(path.join(copy, 'robots.txt'), `User-agent: *\nDisallow: /private\nSitemap: ${SITE}sitemap.xml\n`);
  await writeFile(path.join(copy, 'llms.txt'), `# Acme\n\n- [About](${SITE}about): who we are\n- [Partner](https://partner.dev/x)\n`);
  return { dir, copy, out: path.join(dir, 'out') };
}

async function hashes(dir) {
  const out = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath ?? e.path, e.name);
    out[path.relative(dir, f).split(path.sep).join('/')] = createHash('sha256').update(await readFile(f)).digest('hex');
  }
  return out;
}

const bodyOf = (html) => cheerio.load(html)('body').html();

test('the address is written into the head tags and site files that name one; nothing else changes, the finished copy is untouched', async () => {
  const { dir, copy, out } = await finishedCopy();
  try {
    const before = await hashes(copy);
    const r = await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: `${NEW}/` });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.origin, NEW);
    assert.deepEqual(await hashes(copy), before, 'the finished copy is never changed');

    const $home = cheerio.load(await readFile(path.join(out, 'index.html'), 'utf8'));
    assert.equal($home('link[rel="canonical"]').attr('href'), `${NEW}/`);
    assert.equal($home('meta[property="og:url"]').attr('content'), `${NEW}/`);
    assert.equal($home('meta[property="og:image"]').attr('content'), `${NEW}/img/hero.png`, 'a picture the copy holds moves');
    assert.equal($home('meta[name="twitter:image"]').attr('content'), `${SITE}img/not-copied.png`, 'a picture the copy does not hold is left');
    assert.match($home('script[type="application/ld+json"]').text(), /acme-old\.dev/, 'the original\'s JSON-LD is kept as written');
    const $about = cheerio.load(await readFile(path.join(out, 'about.html'), 'utf8'));
    assert.equal($about('link[rel="canonical"]').attr('href'), `${NEW}/about`, 'a missing canonical is added');
    assert.equal($about('meta[property="og:url"]').attr('content'), `${NEW}/about`);
    assert.equal($about('meta[property="og:image"]').attr('content'), 'img/hero.png', 'a relative picture is left');

    // Every page's body, and every file that is not a page or a site file, is byte for byte the same.
    for (const p of PAGES) {
      assert.equal(bodyOf(await readFile(path.join(out, p.outPath), 'utf8')), bodyOf(await readFile(path.join(copy, p.outPath), 'utf8')), p.outPath);
    }
    const after = await hashes(out);
    for (const f of ['img/hero.png', 'styles.css', '_headers']) assert.equal(after[f], before[f], f);
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'sitemap.xml'].sort(), 'only sitemap.xml is new');

    // Site files.
    const sitemap = await readFile(path.join(out, 'sitemap.xml'), 'utf8');
    assert.deepEqual([...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]), [`${NEW}/`, `${NEW}/about`], 'noindex page left out');
    const robots = await readFile(path.join(out, 'robots.txt'), 'utf8');
    assert.match(robots, /Disallow: \/private/, 'the original\'s rules are kept');
    assert.match(robots, new RegExp(`Sitemap: ${NEW}/sitemap.xml`));
    assert.doesNotMatch(robots, /acme-old/);
    const llms = await readFile(path.join(out, 'llms.txt'), 'utf8');
    assert.match(llms, new RegExp(`\\(${NEW}/about\\)`));
    assert.match(llms, /partner\.dev\/x/, 'other sites are left');
    assert.deepEqual(r.files.written.sort(), ['llms.txt', 'robots.txt', 'sitemap.xml']);

    // The fixes are counted as the registry says, and what is left is listed for the owner (reason c), never made up.
    assert.equal(r.counts.address, 3); // home canonical, og:url, og:image moved; (twitter:image left)
    assert.equal(r.counts.head, 4); // about + contact: canonical and og:url added
    const open = r.open.map((o) => `${o.page} ${o.field}`).sort();
    assert.deepEqual(open, ['/ json-ld', '/ twitter:image', '/about og:image', '/contact og:image']);
    assert.ok(r.open.every((o) => o.reason === 'c' && o.kind === 'address'));
    assert.match(r.open.find((o) => o.field === 'json-ld').detail, /still names the original site's address/);
    assert.match(r.open.find((o) => o.page === '/contact').detail, /no large picture and the site no logo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a change outside the address tags is caught and undone: the folder is the finished copy again', async () => {
  const { dir, copy, out } = await finishedCopy();
  try {
    const before = await hashes(copy);
    const planted = async (d) => {
      const f = path.join(d, 'about.html');
      await writeFile(f, (await readFile(f, 'utf8')).replace('Our story.', 'Our story!'));
    };
    const r = await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW, hooks: { afterWrite: planted } });
    assert.equal(r.ok, false);
    assert.match(r.why, /about\.html changed outside its address tags/);
    assert.deepEqual(await hashes(out), before, 'undone: the folder is exactly the finished copy');
    assert.equal(r.counts.address, 0);

    // Another file changed, or a file that is not a site file appearing, is caught the same way.
    const css = await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW,
      hooks: { afterWrite: (d) => writeFile(path.join(d, 'styles.css'), 'body{color:red}') } });
    assert.equal(css.ok, false);
    assert.match(css.why, /styles\.css changed/);
    const extra = await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW,
      hooks: { afterWrite: (d) => writeFile(path.join(d, 'extra.js'), '1') } });
    assert.equal(extra.ok, false);
    assert.match(extra.why, /extra\.js appeared/);
    // A sitemap entry that is not a page of the copy on the new site.
    const bad = await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW,
      hooks: { afterWrite: (d) => writeFile(path.join(d, 'sitemap.xml'), `<urlset><url><loc>${SITE}about</loc></url></urlset>`) } });
    assert.equal(bad.ok, false);
    assert.match(bad.why, /sitemap\.xml lists/);
    assert.deepEqual(await hashes(out), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the full fix stage and the address pass write the same address tags (one shared function)', async () => {
  const { dir, copy, out } = await finishedCopy();
  const full = path.join(dir, 'full');
  try {
    await addressPass({ fromDir: copy, dir: out, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW });
    await mkdir(full);
    await import('node:fs/promises').then((fs) => fs.cp(copy, full, { recursive: true }));
    const fixed = await fixAsIsCopy({ dir: full, pages: PAGES, siteUrl: SITE, newSiteUrl: NEW });
    const tags = ($) => ({
      canonical: $('link[rel="canonical"]').attr('href'), ogUrl: $('meta[property="og:url"]').attr('content'),
      ogImage: $('meta[property="og:image"]').attr('content'), twitter: $('meta[name="twitter:image"]').attr('content'),
    });
    for (const p of PAGES) {
      assert.deepEqual(tags(cheerio.load(await readFile(path.join(full, p.outPath), 'utf8'))), tags(cheerio.load(await readFile(path.join(out, p.outPath), 'utf8'))), p.outPath);
    }
    assert.equal(await readFile(path.join(full, 'sitemap.xml'), 'utf8'), await readFile(path.join(out, 'sitemap.xml'), 'utf8'));
    assert.equal(await readFile(path.join(full, 'robots.txt'), 'utf8'), await readFile(path.join(out, 'robots.txt'), 'utf8'));
    assert.ok(fixed.open.some((o) => o.field === 'json-ld' && o.reason === 'c'), 'the full stage lists the JSON-LD note too');
    // Without an address the full stage writes and lists none of it.
    const none = path.join(dir, 'none');
    await import('node:fs/promises').then((fs) => fs.cp(copy, none, { recursive: true }));
    const plain = await fixAsIsCopy({ dir: none, pages: PAGES, siteUrl: SITE, newSiteUrl: null });
    assert.equal(plain.open.filter((o) => o.kind === 'address').length, 0);
    assert.equal(cheerio.load(await readFile(path.join(none, 'about.html'), 'utf8'))('link[rel="canonical"]').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registry: address fixes need an address, and a moved picture is a head tag that is never painted', () => {
  assert.equal(fixOf('address').needs, 'address');
  for (const f of ADDRESS_FIELDS) assert.ok(HEAD_META_FIELDS.has(f), f);
  assert.equal(fixGroup({ kind: 'address', field: 'og:image' }), 'head:meta');
  assert.equal(fixGroup({ kind: 'address', field: 'twitter:image' }), 'head:meta');
});

test('a missing og:image is the original\'s own picture: a large image the page shows, else its logo on a card', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-addr-og-'));
  const copy = path.join(dir, 'copy');
  const out = path.join(dir, 'out');
  const logo = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 20h10"></path><path d="M12 20V6"></path></svg>';
  const pages = [
    { path: '/', outPath: 'index.html', url: SITE },
    { path: '/team', outPath: 'team.html', url: `${SITE}team` },
  ];
  try {
    await mkdir(path.join(copy, 'img'), { recursive: true });
    const photo = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } }).png().toBuffer();
    await writeFile(path.join(copy, 'img', 'tiny.png'), await photo(40, 40));
    await writeFile(path.join(copy, 'img', 'team.png'), await photo(800, 400));
    const header = `<header><a href="/" aria-label="Acme, home">${logo}</a><a href="#how">How</a></header>`;
    await writeFile(path.join(copy, 'index.html'), page('<title>Acme tools for builders</title><meta name="theme-color" content="#16a34a">',
      `${header}<h1>Acme</h1><img src="img/tiny.png" alt="">`));
    await writeFile(path.join(copy, 'team.html'), page('<title>The Acme team</title>', `${header}<img src="/img/tiny.png" alt=""><img src="img/team.png" alt="The team">`));

    const r = await addressPass({ fromDir: copy, dir: out, pages, siteUrl: SITE, newSiteUrl: NEW });
    assert.equal(r.ok, true, r.why);
    const og = (p) => r.pages.find((x) => x.path === p).fixes.find((f) => f.field === 'og:image');
    // The team page shows a large picture: that very file, nothing made.
    assert.equal(og('/team').value, `${NEW}/img/team.png`);
    assert.equal(og('/team').file, undefined);
    assert.equal(og('/team').review, true);
    // The homepage shows only a small one: the logo of its link to the homepage, on a 1200 × 630 card, in the theme colour.
    const card = og('/');
    assert.match(card.value, new RegExp(`^${NEW}/images/og-image-[0-9a-f]{10}\\.png$`));
    assert.match(card.source, /logo \(in its link to the homepage\)/);
    assert.equal(card.review, true);
    const { data, info } = await sharp(path.join(out, card.file)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [1200, 630]);
    const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    assert.deepEqual(at(5, 5), [255, 255, 255], 'a white card');
    let green = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] === 0x16 && data[i + 1] === 0xa3 && data[i + 2] === 0x4a) green++;
    assert.ok(green > 1000, 'the logo is drawn in the page\'s theme colour');
    assert.equal(cheerio.load(await readFile(path.join(out, 'index.html'), 'utf8'))('meta[property="og:image"]').attr('content'), card.value);
    assert.equal(r.open.filter((o) => o.field === 'og:image').length, 0);
    // The finished copy is untouched: the card is made in the addressed folder only.
    assert.deepEqual((await readdir(copy)).sort(), ['img', 'index.html', 'team.html']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
