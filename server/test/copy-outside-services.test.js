// Go live, Step 0: an as-is copy that keeps the original's outside services (visitor counting, fonts, a chat widget) is not
// failed for them; only a request to the original site itself fails it (copy/outsideServices.js). The pages below are the
// shape of real copies: panscience.xyz (Google Analytics only), flexibench (analytics, fonts, a chat widget locked to its
// domain), and one that still loads a file from the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asIsSafety, outsideKind, withAsIsSafety } from '../src/copy/outsideServices.js';
import { deployReadiness } from '../src/deploy/readiness.js';

const page = (original, external, domainLocked = []) => ({ path: new URL(original).pathname, original, offline: { external }, domainLocked });

test('outside hosts are sorted into visitor counting, fonts and other services', () => {
  assert.equal(outsideKind('www.googletagmanager.com'), 'analytics');
  assert.equal(outsideKind('region1.google-analytics.com'), 'analytics');
  assert.equal(outsideKind('fonts.googleapis.com'), 'fonts');
  assert.equal(outsideKind('botza.panscience.xyz'), 'service');
  // A look-alike is not the service it imitates.
  assert.equal(outsideKind('evilgoogletagmanager.com'), 'service');
});

test('a copy whose only outside requests are services passes, and lists them per host', () => {
  const s = asIsSafety([
    page('https://www.flexibench.io/', ['https://www.googletagmanager.com/gtag/js?id=G-1', 'https://botza.panscience.xyz/widget/chatbot-widget.js', 'https://botza.panscience.xyz/api/chatbot/w/cfg/1'],
      [{ host: 'botza.panscience.xyz' }]),
    page('https://www.flexibench.io/blog', ['https://www.googletagmanager.com/gtag/js?id=G-1', 'https://fonts.googleapis.com/css2?family=DM+Sans']),
  ]);
  assert.equal(s.safe, true);
  assert.deepEqual(s.original, []);
  assert.deepEqual(s.outside, [
    { host: 'www.googletagmanager.com', kind: 'analytics', pages: 2, domainLocked: false },
    { host: 'botza.panscience.xyz', kind: 'service', pages: 1, domainLocked: true },
    { host: 'fonts.googleapis.com', kind: 'fonts', pages: 1, domainLocked: false },
  ]);
});

test('a request to the original site fails the copy, with or without www', () => {
  const s = asIsSafety([page('https://www.own360.ai/', ['https://own360.ai/_next/static/chunk.js', 'https://www.googletagmanager.com/gtag/js'])]);
  assert.equal(s.safe, false);
  assert.deepEqual(s.original, ['https://own360.ai/_next/static/chunk.js']);
  assert.equal(s.outside.length, 1);
  // Another site under the same name is another server, not the original.
  assert.equal(asIsSafety([page('https://www.panscience.xyz/', ['https://botza.panscience.xyz/widget.js'])]).safe, true);
});

test('a copy made before Step 0 is judged again from its own checks; a report without them is left alone', () => {
  const old = {
    safety: { safe: false, mode: 'as-is' },
    asIs: { safety: { safe: false }, checks: { pages: [page('https://www.panscience.xyz/', ['https://www.googletagmanager.com/gtag/js?id=G-9'])] } },
  };
  const now = withAsIsSafety(old);
  assert.equal(now.safety.safe, true);
  assert.equal(now.asIs.safety.safe, true);
  assert.equal(old.safety.safe, false, 'the stored report is not changed');
  const rebuilt = { safety: { safe: false } };
  assert.equal(withAsIsSafety(rebuilt), rebuilt);
});

const asIsReport = (pages) => withAsIsSafety({
  stack: 'html',
  outputs: { html: { status: 'ready', mode: 'as-is' } },
  safety: { safe: false, mode: 'as-is' },
  asIs: { address: { used: 'https://new.test' }, checks: { pages } },
});
const reaudit = { checklist: { items: [] } };

test('Go live: outside services are a warning to confirm, not a blocker', () => {
  const report = asIsReport([page('https://opticall.io/', ['https://www.googletagmanager.com/gtag/js', 'https://botza.panscience.xyz/w.js'], [{ host: 'botza.panscience.xyz' }])]);
  const r = deployReadiness({ project: { url: 'https://opticall.io/' }, report, stack: 'html', reaudit });
  assert.equal(r.ok, true);
  assert.deepEqual(r.blockers, []);
  const outside = r.warnings.find((w) => w.id === 'outside');
  assert.ok(outside, 'outside services are listed');
  assert.match(outside.text, /www\.googletagmanager\.com \(visitor counting\)/);
  assert.match(outside.text, /botza\.panscience\.xyz answers only your real address/);
});

test('Go live: a copy that asks the original is blocked, and says which file', () => {
  const report = asIsReport([page('https://own360.ai/', ['https://own360.ai/logo.svg'])]);
  const r = deployReadiness({ project: { url: 'https://own360.ai/' }, report, stack: 'html', reaudit });
  assert.equal(r.ok, false);
  assert.deepEqual(r.blockers.map((b) => b.id), ['unsafe']);
  assert.match(r.blockers[0].text, /asks the original site for one file \(for example https:\/\/own360\.ai\/logo\.svg\)/);
  assert.equal(r.warnings.some((w) => w.id === 'outside'), false);
});

test('Go live: a copy with no outside request has no outside warning', () => {
  const r = deployReadiness({ project: {}, report: asIsReport([page('https://a.test/', [])]), stack: 'html', reaudit });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.some((w) => w.id === 'outside'), false);
});
