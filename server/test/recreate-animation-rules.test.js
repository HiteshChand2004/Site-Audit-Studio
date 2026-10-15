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

test('motion with no pattern keeps its recorded trace, played forward and back (approximate)', async () => {
  const { analyzeSeries: analyze, TRACE_POINTS } = await import('../src/recreate/capture/loops.js');
  // Back a little, then away: it turns once, so no period can be read - the shape of a wander or of a slow loop seen in part.
  const a = analyze(series(2200, (t) => ({ translate: `${40 * t * t - 30 * t}px 0px` })));
  assert.equal(a.pattern, 'move');
  assert.equal(a.trace.points.length, TRACE_POINTS);
  const built = scriptLoop({ pattern: 'move', params: a });
  assert.equal(built.approximate, 'recorded-path');
  assert.equal(built.timing.direction, 'alternate', 'forward and back, so it never jumps');
  assert.match(built.keyframes[0].props.translate, /^0px 0px$/);
});

test('a script motion named after an axis it barely moves on (its scale breathes) keeps moving as its trace, at any speed', () => {
  // y creeps 0.3 px/s while the scale goes 1 → 1.06 → 1: the analysis may call it a slow drift, the copy must still move.
  const a = analyzeSeries(series(4000, (t) => ({ translate: `0px ${0.3 * t}px`, scale: String(1 + 0.06 * Math.sin(t * Math.PI / 2)) })));
  const built = scriptLoop({ pattern: a.pattern, params: a });
  assert.ok(built, `${a.pattern} was left standing still`);
  assert.ok(built.keyframes.some((k) => k.props.scale && k.props.scale !== '1'), JSON.stringify(built.keyframes.slice(0, 3)));
  // The shape nyaayai's capture had: called a drift on y at 0-0.3 px/s, the motion in its trace (y + scale). Whatever the
  // pattern is called, a slow one with a trace is rebuilt from it.
  const trace = { channels: ['y', 'scale'], durationMs: 19925, points: Array.from({ length: 16 }, (_, i) => [i * 1328, 0, i * 0.4, 0, 1 + 0.04 * Math.sin(i), 1]) };
  for (const pattern of ['drift', 'ramp', 'spin']) {
    const r = scriptLoop({ pattern, params: { channel: 'y', rate: pattern === 'drift' ? 0.3 : 0, trace } });
    assert.equal(r?.approximate, 'recorded-path', pattern);
    assert.ok(r.keyframes.some((k) => k.props.scale !== '1'), pattern);
  }
  // And with nothing recorded there is still nothing to invent.
  assert.equal(scriptLoop({ pattern: 'drift', params: { channel: 'y', rate: 0, wrap: { distance: 28 } } }), null);
});

test('a two-axis movement recorded for less than one period is played as recorded, never flattened to one axis', () => {
  // x swings with a 1.8 s period, y wanders slowly: 1.7 s recorded - two turns on x are seen, a whole period is not.
  const a = analyzeSeries(series(1700, (t) => ({ translate: `${60 * Math.sin((2 * Math.PI * t) / 1.8)}px ${25 * t}px` })));
  assert.equal(a.pattern, 'oscillate');
  assert.equal(a.path, undefined, 'no whole period, no path');
  assert.ok(a.trace?.points?.length >= 4, JSON.stringify(a));
  const built = scriptLoop({ pattern: a.pattern, params: a });
  assert.equal(built.approximate, 'recorded-path');
  assert.ok(built.keyframes.some((k) => !/ 0px$/.test(k.props.translate)), 'the y movement is kept');
});

test('motion made of jumps (a counter rolling in steps) and a one-step change keep their trace and are rebuilt from it', () => {
  // Still most of the time, then a 20 px jump up every second, back down after three: median step 0, a "wrap" seen.
  const roller = analyzeSeries(series(4000, (t) => ({ translate: `0px ${-20 * (Math.floor(t) % 3)}px` })));
  assert.ok(roller?.trace?.points?.length >= 4, JSON.stringify(roller));
  assert.ok(scriptLoop({ pattern: roller.pattern, params: roller }), `${roller.pattern} at ${roller.rate} px/s stood still`);
  // An SVG part whose opacity steps from 0.2 to 1 and back now and then.
  const stepper = analyzeSeries(series(4000, (t) => ({ opacity: Math.floor(t * 2) % 4 === 3 ? 0.2 : 1 })));
  assert.ok(stepper?.trace, JSON.stringify(stepper));
  assert.ok(scriptLoop({ pattern: stepper.pattern, params: stepper }), stepper.pattern);
});

test('a slow loop seen going one way only (a drift with no wrap and no repeat) keeps moving as its trace', () => {
  const a = analyzeSeries(series(2200, (t) => ({ translate: `${25 * t}px 0px` })));
  assert.equal(a.pattern, 'drift');
  assert.ok(!a.wrap, 'no wrap was seen');
  assert.ok(a.trace?.points?.length >= 4, 'the recording keeps its trace');
  const built = scriptLoop({ pattern: 'drift', params: a });
  assert.ok(built, 'rebuilt, not skipped as script-driven');
  assert.equal(built.approximate, 'recorded-path');
  assert.equal(built.timing.direction, 'alternate');
});

test('scroll-linked samples: channels relative to the top, and a reading that is not reversible is no effect of the scroll', async () => {
  const { analyzeScrollSamples, channelsOf } = await import('../src/recreate/capture/scrolllinked.js');
  assert.deepEqual(channelsOf('matrix(1, 0, 0, 1, 0, 120)|0.5|none|none|none|none'), { x: 0, y: 120, rot: 0, scale: 1, opacity: 0.5, filter: null });
  const reading = (y) => `matrix(1, 0, 0, 1, 0, ${y})|1|none|none|none|none`;
  const out = analyzeScrollSamples({ max: 2000, ys: [0, 1000, 2000], elements: [{ path: 'body>div:1', tag: 'div', rect: [0, 0, 10, 10], values: [reading(0), reading(250), reading(500)] }] });
  assert.deepEqual(out[0].channels, ['y']);
  assert.deepEqual(out[0].samples.map((s) => [s.at, s.y]), [[0, 0], [0.5, 250], [1, 500]]);
});

test('a scroll-linked loop is paused and scrubbed by --sas-sp; a canvas shows its frame and plays its recording only with motion allowed', () => {
  const css = motionCss({
    hover: [], focus: [], reveal: [], delays: [], widgets: [],
    loops: [{ token: 'l1', name: 'm-l1', scrub: true, keyframes: [{ offset: 0, props: { translate: '0px 0px' } }, { offset: 100, props: { translate: '0px 500px' } }], timing: { duration: 1000, delay: 0, iterations: 1, direction: 'normal', fill: 'both', easing: 'linear' } }],
    canvas: [{ token: 'c1', still: 'images/canvas-index-aaaa.webp', loop: 'images/canvas-loop-index-bbbb.webp' }],
  }, { from: 'index.html' });
  assert.match(css, /\[data-motion~="l1"\] \{\s*animation: m-l1 1000ms linear both paused;\s*animation-delay: calc\(var\(--sas-sp, 0\) \* -1000ms\);/);
  const [before, after] = css.split('prefers-reduced-motion: no-preference) {\n  [data-motion~="c1"]');
  assert.match(before, /\[data-motion~="c1"\] \{[^}]*canvas-index-aaaa\.webp/, 'the frame, always');
  assert.ok(after && /canvas-loop-index-bbbb\.webp/.test(after), 'the recording, only where motion is allowed');
});
