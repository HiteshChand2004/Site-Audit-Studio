import gsap from 'gsap';

/*
 * The hero story as one seamless GSAP loop of about 12 seconds. The step rail under the stage follows it:
 *   1 Paste     0.4 s  the address bar sits centred in the stage, slightly larger; "makememo.ai" is typed
 *   2 Audit     2.2 s  the bar glides up to the top while the original rises into the space below it;
 *                      a light sweep scans it, three issues appear in its footer, its Lighthouse score appears
 *   3 Fix       5.4 s  the issues turn green one by one
 *   4 Rebuild   7.0 s  the original turns aside, the rebuilt copy slides out, its score counts to 98
 *              11.6 s  the cards fade and the bar glides back to the centre: the end
 *                      state is the start state, so the loop never jumps
 * Every card has fixed zones (header bar, page, footer) so nothing overlaps; where the cards overlap in 3D (phones),
 * the back card is dimmed (--dim on the original card, read here). Card poses come from CSS custom properties
 * (--x, --y, --z, --rx, --ry, --s; --iy and --is for the centred intro). Numbers are from a real example run.
 */

export const URL_TEXT = 'makememo.ai';
export const SCORE_ORIGINAL = 91;
export const SCORE_COPY = 98;
export const GAUGE_R = 15; // small score ring in the card footer (viewBox 36)
export const GAUGE_C = 2 * Math.PI * GAUGE_R;

export type Status = 'idle' | 'audit' | 'fix' | 'done';
export const STATUS_TEXT: Record<Status, string> = { idle: 'Audit', audit: 'Auditing', fix: 'Fixing', done: 'Rebuilt' };

/** Playback speed of the whole loop (1 = the timings below). */
const SPEED = 1.4;

const T = { type: 0.4, press: 1.9, appear: 2.2, scan: 3.2, fix: 5.4, split: 7.0, score: 8.2, hold: 10.2, out: 11.6, end: 12.4 };
const ISSUE_AT = [3.55, 4.05, 4.55]; // when the beam passes each issue
const FIX_AT = [5.6, 6.0, 6.4];

/** Changes a text node in place, so React keeps the node it rendered. */
const setText = (el: Element, s: string) => {
  const n = el.firstChild;
  if (n && n.nodeType === 3) n.nodeValue = s;
  else el.textContent = s;
};

export function buildHeroTimeline(root: HTMLElement) {
  const q = (s: string) => {
    const n = root.querySelector<HTMLElement>(s);
    if (!n) throw new Error(`Hero stage: missing ${s}`);
    return n;
  };
  const qa = (s: string) => Array.from(root.querySelectorAll<HTMLElement>(s));

  const orig = q('.cine__card--orig');
  const copy = q('.cine__card--copy');
  const url = q('.cine__url');
  const typed = q('.cine__typed');
  const go = q('.cine__go');
  const goLabel = q('.cine__go-label');
  const beam = q('.cine__beam');
  const grid = q('.cine__grid');
  const page = q('.cine__card--orig .cine__page');
  const link = q('.cine__link');
  const dim = q('.cine__dim');
  const blks = qa('.cine__card--orig .blk');
  const issues = qa('.cine__issue');
  const scoreO = q('.cine__card--orig .cine__score');
  const scoreC = q('.cine__card--copy .cine__score');
  const copyFoot = qa('.cine__card--copy .cine__foot > *');
  const steps = qa('.cine-rail li');

  const setStatus = (s: Status) => {
    go.dataset.status = s;
    setText(goLabel, STATUS_TEXT[s]);
  };
  const setStep = (n: number) => steps.forEach((li, i) => (li.dataset.state = i < n ? 'done' : i === n ? 'active' : 'todo'));
  const setIssue = (i: number, state: 'issue' | 'fixed') => {
    issues[i].dataset.state = state;
  };
  // Text, scores and issue states changed by callbacks are not reverted when the loop wraps, so reset them here.
  const resetLoop = () => {
    setText(typed, '');
    issues.forEach((_, i) => setIssue(i, 'issue'));
    for (const s of [scoreO, scoreC]) {
      setText(s.querySelector('.cine__score-num') as HTMLElement, '0');
      (s.querySelector('.cine__score-arc') as SVGCircleElement).style.strokeDashoffset = String(GAUGE_C);
    }
  };

  const counter = (score: HTMLElement, target: number, duration: number) => {
    const num = score.querySelector('.cine__score-num') as HTMLElement;
    const arc = score.querySelector('.cine__score-arc') as SVGCircleElement;
    const o = { v: 0 };
    return gsap.fromTo(
      o,
      { v: 0 },
      {
        v: target,
        duration,
        ease: 'power2.out',
        onUpdate: () => {
          setText(num, String(Math.round(o.v)));
          arc.style.strokeDashoffset = String(GAUGE_C * (1 - o.v / 100));
        },
      },
    );
  };

  const read = (n: HTMLElement, name: string) => parseFloat(getComputedStyle(n).getPropertyValue(name)) || 0;
  const pose = (n: HTMLElement) => ({
    x: read(n, '--x'),
    y: read(n, '--y'),
    z: read(n, '--z'),
    rotationY: read(n, '--ry'),
    rotationX: read(n, '--rx'),
    scale: read(n, '--s') || 1,
  });
  const O = pose(orig);
  const C = pose(copy);
  const intro = { x: 0, y: read(orig, '--iy'), z: 0, rotationY: 0, rotationX: 0, scale: read(orig, '--is') || 1 };
  const dimTo = read(orig, '--dim'); // 1 where the cards overlap (phones), 0 where they sit apart
  const typing = { n: 0 };
  // Step 1 composition: the address bar sits centred in the stage, slightly larger; it glides up when the audit starts.
  const scene = url.parentElement as HTMLElement;
  const urlCenterY = scene.offsetHeight / 2 - (url.offsetTop + url.offsetHeight / 2);
  const URL_ZOOM = 1.12;

  const tl = gsap.timeline({ repeat: -1, paused: true, defaults: { ease: 'power3.out' } });

  // Start state (identical to the end state, so the loop is seamless).
  tl.set(url, { xPercent: -50, y: urlCenterY, scale: URL_ZOOM }, 0)
    .set(typed, { opacity: 1 }, 0)
    .set(orig, { ...intro, y: intro.y + 60, z: -220, opacity: 0 }, 0)
    .set(copy, { ...intro, z: -160, opacity: 0 }, 0)
    .set([scoreO, scoreC, link], { opacity: 0 }, 0)
    .set(copyFoot, { opacity: 0, y: 6 }, 0)
    .set(issues, { opacity: 0, y: 6 }, 0)
    .set(dim, { opacity: 0 }, 0)
    .call(resetLoop, [], 0.01)
    .call(setStatus, ['idle'], 0.01)
    .call(setStep, [0], 0.01);

  // 1. Paste: type the address, press Audit.
  tl.fromTo(
    typing,
    { n: 0 },
    {
      n: URL_TEXT.length,
      duration: 1.3,
      ease: 'none',
      onUpdate: () => setText(typed, URL_TEXT.slice(0, Math.round(typing.n))),
    },
    T.type,
  )
    .to(go, { scale: 0.92, duration: 0.12, ease: 'power1.in' }, T.press)
    .to(go, { scale: 1, duration: 0.4, ease: 'power2.out' }, T.press + 0.12)
    .call(setStatus, ['audit'], T.press + 0.15);

  // 2. Audit: the bar glides up, the original rises into the space below, a light sweep scans it.
  tl.call(setStep, [1], T.appear)
    .to(url, { y: 0, scale: 1, duration: 0.5, ease: 'power3.inOut' }, T.appear - 0.1)
    .to(orig, { ...intro, opacity: 1, duration: 0.9 }, T.appear + 0.05)
    .fromTo(beam, { y: 0, opacity: 1 }, { y: () => page.offsetHeight + 120, duration: 1.8, ease: 'power1.inOut' }, T.scan)
    .to(beam, { opacity: 0, duration: 0.3 }, T.scan + 1.6)
    .fromTo(grid, { clipPath: 'inset(0% 0% 100% 0%)', opacity: 1 }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.8, ease: 'power1.inOut' }, T.scan)
    .to(grid, { opacity: 0, duration: 0.6 }, T.fix)
    .fromTo(blks, { '--hl': 0 }, { '--hl': 1, duration: 0.25, stagger: 0.2, ease: 'none' }, T.scan + 0.15)
    .to(blks, { '--hl': 0, duration: 0.6, stagger: 0.05 }, T.fix - 0.2)
    .to(scoreO, { opacity: 1, duration: 0.4 }, T.scan + 1.35)
    .add(counter(scoreO, SCORE_ORIGINAL, 1.0), T.scan + 1.4);
  issues.forEach((el, i) => tl.to(el, { opacity: 1, y: 0, duration: 0.45 }, ISSUE_AT[i]));

  // 3. Fix: each issue turns green.
  tl.call(setStep, [2], T.fix)
    .call(setStatus, ['fix'], T.fix);
  issues.forEach((_, i) => tl.call(setIssue, [i, 'fixed'], FIX_AT[i]));

  // 4. Rebuild: the original turns aside (and dims where the copy sits in front), the copy slides out.
  tl.call(setStep, [3], T.split)
    .to(orig, { ...O, duration: 1.3, ease: 'power3.inOut' }, T.split)
    .to(dim, { opacity: dimTo, duration: 0.8, ease: 'power2.inOut' }, T.split + 0.4)
    .to(copy, { ...C, opacity: 1, duration: 1.4, ease: 'power3.inOut' }, T.split + 0.1)
    .to(link, { opacity: 1, duration: 0.5 }, T.split + 0.9)
    .call(setStatus, ['done'], T.split + 1.0)
    .to(copyFoot, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1 }, T.score - 0.2)
    .to(scoreC, { opacity: 1, duration: 0.4 }, T.score)
    .add(counter(scoreC, SCORE_COPY, 1.6), T.score + 0.05);

  // Hold with a slow drift, then return to the start state: cards fade, the bar glides home.
  tl.to([orig, copy], { y: '-=8', duration: 0.7, ease: 'sine.inOut', yoyo: true, repeat: 1 }, T.hold)
    .to([orig, copy, link], { opacity: 0, duration: 0.6, ease: 'power2.in' }, T.out)
    .to(typed, { opacity: 0, duration: 0.4 }, T.out)
    .call(setStatus, ['idle'], T.out + 0.5)
    .call(setStep, [0], T.out + 0.3)
    .to(url, { y: urlCenterY, scale: URL_ZOOM, duration: 0.6, ease: 'power3.inOut' }, T.out + 0.2)
    .to({}, { duration: 0.01 }, T.end);

  // Play the whole loop a little faster than the timings above (about 8.9 s instead of 12.4 s).
  tl.timeScale(SPEED);
  return tl;
}
