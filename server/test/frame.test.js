import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFrame, sourceMatches } from '../src/audit/frame.js';

const SITE = 'https://example.com/';
const frame = (headers, opts = {}) => computeFrame(headers, { url: SITE, appOrigin: 'http://localhost:5173', ...opts });
const csp = (value) => frame({ 'content-security-policy': value });

test('X-Frame-Options', () => {
  assert.equal(frame({ 'x-frame-options': 'DENY' }).frameable, false);
  assert.equal(frame({ 'x-frame-options': 'sameorigin' }).frameable, false);
  // Repeated headers arrive joined with a comma.
  assert.equal(frame({ 'x-frame-options': 'SAMEORIGIN, DENY' }).reason, 'X-Frame-Options: SAMEORIGIN, DENY');
  // SAMEORIGIN only blocks other origins.
  assert.equal(computeFrame({ 'x-frame-options': 'SAMEORIGIN' }, { url: 'http://localhost:5173/', appOrigin: 'http://localhost:5173' }).frameable, true);

  const allowFrom = frame({ 'x-frame-options': 'ALLOW-FROM https://partner.com' });
  assert.equal(allowFrom.frameable, true);
  assert.equal(allowFrom.confidence, 'uncertain');
  assert.match(allowFrom.notes[0], /ALLOW-FROM/);
});

test('CSP frame-ancestors', () => {
  assert.equal(csp("frame-ancestors 'none'").frameable, false);
  assert.equal(csp("default-src 'self'; frame-ancestors 'self'").frameable, false);
  assert.equal(csp('frame-ancestors *').frameable, true);
  assert.equal(csp('frame-ancestors http:').frameable, true);
  assert.equal(csp('frame-ancestors https:').frameable, false);
  assert.equal(csp('frame-ancestors http://localhost:5173').frameable, true);
  assert.equal(csp('frame-ancestors http://localhost:*').frameable, true);
  assert.equal(csp('frame-ancestors http://localhost').frameable, false, 'no port means the default port 80');
  assert.equal(csp('frame-ancestors localhost:5173').frameable, false, 'scheme-less takes the https scheme of the site');
  assert.equal(
    computeFrame({ 'content-security-policy': 'frame-ancestors localhost:5173' }, { url: 'http://example.com/', appOrigin: 'http://localhost:5173' }).frameable,
    true,
  );
  assert.equal(csp('frame-ancestors https://*.example.com').frameable, false);
  // The first frame-ancestors directive of a policy counts.
  assert.equal(csp("frame-ancestors *; frame-ancestors 'none'").frameable, true);
  // Directive names are case-insensitive; other directives are ignored.
  assert.equal(csp("script-src 'self'; FRAME-ANCESTORS 'none'").frameable, false);
  assert.equal(csp("default-src 'none'").frameable, true);
});

test('several CSP policies must all allow framing', () => {
  assert.equal(csp("frame-ancestors *, frame-ancestors 'self'").frameable, false);
  assert.equal(csp("frame-ancestors *, default-src 'self'").frameable, true);
});

test('CSP frame-ancestors overrides X-Frame-Options', () => {
  assert.equal(frame({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' }).frameable, true);
  assert.equal(frame({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'" }).frameable, false);
});

test('Report-Only policies never block', () => {
  assert.equal(frame({ 'content-security-policy-report-only': "frame-ancestors 'none'" }).frameable, true);
});

test('frame-busting script lowers confidence', () => {
  const html = '<script>if (top !== self) top.location = self.location;</script>';
  const result = frame({}, { html });
  assert.equal(result.frameable, true);
  assert.equal(result.confidence, 'uncertain');
  assert.equal(frame({}, { html: '<script>console.log(1)</script>' }).confidence, 'high');
});

test('sourceMatches: wildcard hosts', () => {
  const ancestor = new URL('https://app.example.com');
  const self = new URL('https://example.com');
  assert.equal(sourceMatches('*.example.com', ancestor, self), true);
  assert.equal(sourceMatches('*.example.com', new URL('https://example.com'), self), false);
  assert.equal(sourceMatches('*.example.com', new URL('https://evilexample.com'), self), false);
});
