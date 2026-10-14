// The rules behind continuous script motion, without a browser: what a recording of an element is named
// (capture/loops.js analyzeSeries) and what the copy rebuilds from it (ir/motion.js scriptLoop, emit/motionCss.js).
// Each case is a motion the pipeline used to lose: a particle moved by left / top on both axes, a pulse (scale), a rocking
// rotation, a colour cycle (filter: hue-rotate), an SVG text moved through its x attribute, a pseudo-element loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeries, PATH_POINTS, periodPath } from '../src/recreate/capture/loops.js';
import { scriptLoop } from '../src/recreate/ir/motion.js';
import { motionCss } from '../src/recreate/emit/motionCss.js';

// One sample: [t, transform, opacity, rotate, translate, scale, left, top, filter, svgX, svgY] (capture/loops.js read()).
const sample = (t, o = {}) => [t, o.transform ?? 'none', String(o.opacity ?? 1), o.rotate ?? 'none', o.translate ?? 'none', o.scale ?? 'none',
  o.left ?? 'auto', o.top ?? 'auto', o.filter ?? 'none', o.svgX ?? '', o.svgY ?? ''];
const series = (ms, fn, step = 33) => Array.from({ length: Math.floor(ms / step) }, (_, i) => sample(i * step, fn(i * step / 1000)));

test('a particle moved by left / top on both axes: an oscillation with its path over one period', () => {
  const s = series(4000, (t) => ({ left: `${110 + 80 * Math.sin(t * Math.PI)}px`, top: `${40 + 25 * Math.cos(t * Math.PI)}px` }));
  const a = analyzeSeries(s);
  assert.equal(a.pattern, 'oscillate');
  assert.ok(Math.abs(a.periodMs - 2000) < 250, `period ${a.periodMs}`);
  assert.equal(a.path?.length, PATH_POINTS);
  const xs = a.path.map((p) => p[0]);
  const ys = a.path.map((p) => p[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 120 && Math.max(...ys) - Math.min(...ys) > 35, JSON.stringify(a.path));
  const built = scriptLoop({ pattern: a.pattern, params: a });
  assert.equal(built.timing.iterations, 'infinite');
  assert.equal(built.keyframes.length, PATH_POINTS + 1, 'the path, closed back to its start');
  assert.match(built.keyframes[0].props.translate, /^-?[\d.]+px -?[\d.]+px$/);
});

test('one axis only stays a plain back-and-forth; a recording shorter than a period gives no path', () => {
  const a = analyzeSeries(series(4000, (t) => ({ translate: `${60 * Math.sin(t * Math.PI)}px` })));
  assert.equal(a.pattern, 'oscillate');
  assert.equal(a.path, undefined);
  assert.equal(periodPath([{ t: 0, x: 0, y: 0 }, { t: 500, x: 1, y: 1 }], 2000), null);
});

test('a pulse (scale) and a rocking motion (rotation) are rebuilt between the values the recording saw', () => {
  const pulse = analyzeSeries(series(4000, (t) => ({ scale: String(1 + 0.35 * Math.sin(t * Math.PI)) })));
  assert.equal(pulse.channel, 'scale');
  assert.equal(pulse.pattern, 'oscillate');
  const p = scriptLoop({ pattern: 'oscillate', params: pulse });
  assert.equal(p.timing.direction, 'alternate');
  assert.ok(Number(p.keyframes[0].props.scale) < 0.7 && Number(p.keyframes[1].props.scale) > 1.3, JSON.stringify(p.keyframes));
  // A computed transform is always a matrix (what getComputedStyle returns for a rotate() the script wrote).
  const matrixOf = (deg) => {
    const r = (deg * Math.PI) / 180;
    return `matrix(${Math.cos(r)}, ${Math.sin(r)}, ${-Math.sin(r)}, ${Math.cos(r)}, 0, 0)`;
  };
  const rock = analyzeSeries(series(4000, (t) => ({ transform: matrixOf(25 * Math.sin(t * Math.PI * 1.25)) })));
  assert.equal(rock.channel, 'rot');
  const r = scriptLoop({ pattern: 'oscillate', params: rock });
  assert.match(r.keyframes[0].props.rotate, /^-2[0-9.]*deg$/);
});

test('a colour cycle turned by script (hue-rotate) goes round at the measured speed', () => {
  const a = analyzeSeries(series(3000, (t) => ({ filter: `hue-rotate(${Math.round((t * 120) % 360)}deg)` })));
  assert.equal(a.channel, 'hue');
  const built = scriptLoop({ pattern: a.pattern, params: a });
  assert.equal(built.keyframes[1].props.filter, 'hue-rotate(360deg)');
  assert.ok(Math.abs(built.timing.duration - 3000) < 400, `one turn in ${built.timing.duration} ms (120 deg/s)`);
});

test('an SVG text moved through its x attribute is a movement like any other', () => {
  const a = analyzeSeries(series(4000, (t) => ({ svgX: String(130 + 90 * Math.sin(t * Math.PI * 0.9)) })));
  assert.equal(a.pattern, 'oscillate');
  assert.equal(a.channel, 'x');
  assert.ok(a.amplitude > 80);
});

test('a pseudo-element loop runs on that pseudo-element in the copy, inside reduced-motion', () => {
  const css = motionCss({
    hover: [], focus: [], reveal: [], delays: [], widgets: [],
    loops: [{ token: 'l1', name: 'm-l1', pseudo: '::after', keyframes: [{ offset: 0, props: { opacity: '1' } }, { offset: 100, props: { opacity: '0.1' } }], timing: { duration: 700, delay: 0, iterations: 'infinite', direction: 'alternate', fill: 'auto', easing: 'linear' } }],
  });
  assert.match(css, /\[data-motion~="l1"\]::after \{\s*animation: m-l1 700ms linear infinite alternate;/);
  assert.match(css, /prefers-reduced-motion: no-preference/);
});
