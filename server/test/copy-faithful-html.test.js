// copy/faithfulHtml.js: a page the fixes changed is written back as its own bytes with only the fixes' changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { loadFaithful, faithfulHtml } from '../src/copy/faithfulHtml.js';

const PAGE = [
  '<!doctype html>\r\n<html lang=en>\r\n<head>\r\n  <meta charset=utf-8>\r\n  <title>Old</title>\r\n',
  "  <script src='js/a.js' defer></script>\r\n  <style>p{color:red}\r\n</style>\r\n</head>\r\n",
  '<body>\r\n<p class=x>a &copy; b<br/>c</p>\r\n<ul><li>one<li>two</ul>\r\n',
  '<img src=a.png><svg><circle r="1"/></svg>\r\n<video src=v.mp4 muted></video>\r\n</body>\r\n</html>\r\n',
].join('');

test('no change: the very same bytes', () => {
  const $ = loadFaithful(PAGE);
  assert.deepEqual(faithfulHtml($, PAGE), { html: PAGE, faithful: true });
});

test('only the bytes of the fixes change; the document is the one cheerio would write', () => {
  const $ = loadFaithful(PAGE);
  $('img').attr('alt', 'A "b" & c');
  $('title').text('New < title');
  $('head').append('<meta name="description" content="d">');
  $('html').attr('lang', 'en-GB');
  const r = faithfulHtml($, PAGE);
  assert.equal(r.faithful, true);
  const want = PAGE
    .replace('<html lang=en>', '<html lang="en-GB">')
    .replace('<title>Old</title>', '<title>New &lt; title</title>')
    .replace('</style>\r\n</head>', '</style>\r\n<meta name="description" content="d"></head>')
    .replace('<img src=a.png>', '<img src=a.png alt="A &quot;b&quot; &amp; c">');
  assert.equal(r.html, want);
  assert.equal(cheerio.load(r.html).html(), $.html());
  // Untouched: bare attributes, the doctype, CRLF, entities, self-closed SVG, optional end tags.
  for (const s of ["src='js/a.js' defer>", '<!doctype html>\r\n', '&copy;', '<br/>', '<circle r="1"/>', '<li>one<li>two', 'muted>']) assert.ok(r.html.includes(s), s);
});

test('an attribute removed takes its white space; an element removed leaves its neighbours as they were', () => {
  const $ = loadFaithful('<p class=a   id=b>x</p>\n<i>gone</i>\n<b>kept</b>');
  $('p').removeAttr('id');
  $('i').remove();
  assert.equal(faithfulHtml($, '<p class=a   id=b>x</p>\n<i>gone</i>\n<b>kept</b>').html, '<p class=a>x</p>\n\n<b>kept</b>');
});

test('what cannot be placed with certainty is written whole by cheerio, and says why', () => {
  const s = '<p>x</p>';
  const $ = loadFaithful(s);
  $('head').append('<meta name="d" content="x">');
  const r = faithfulHtml($, s);
  assert.equal(r.faithful, false);
  assert.match(r.why, /cannot be placed/);
  assert.equal(r.html, $.html());
});
