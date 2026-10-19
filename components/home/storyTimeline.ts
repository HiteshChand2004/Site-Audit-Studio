import gsap from 'gsap';

/*
 * Timeline of the Audit → Fix → Rebuild story (transform and opacity only), in seconds. One visual changes with the
 * active stage; the rail's progress line follows the playhead.
 *   Audit    0–4    a scan line sweeps the wireframe, four category rings fill, issues appear in a column beside it
 *   Fix      4–6.5  each issue's status turns: green "Fixed in your copy", or amber "Flagged for you"
 *   Rebuild  6.5–10 the wireframe becomes the clean copy; the issue column gives way to the stack chips and the score
 * Desktop scrubs it with the scroll; phones play it once.
 */

export const STAGE_AT = [0, 4, 6.5];

const setText = (el: Element, s: string) => {
  const n = el.firstChild;
  if (n && n.nodeType === 3) n.nodeValue = s;
  else el.textContent = s;
};

export function buildStoryTimeline(el: HTMLElement, scoreFrom: number, scoreTo: number) {
  const q = (s: string) => Array.from(el.querySelectorAll<HTMLElement>(s));
  const rail = el.querySelector<HTMLElement>('.srail');
  const steps = q('.srail__step');
  const num = el.querySelector('.story__num') as HTMLElement;
  const setStage = (n: number) => steps.forEach((li, i) => (li.dataset.state = i < n ? 'done' : i === n ? 'active' : 'todo'));

  const tl = gsap.timeline({ defaults: { ease: 'power2.out' }, paused: true });
  const score = { v: scoreFrom };

  // Start state.
  tl.set(q('.ring__half i'), { rotation: 0 }, 0)
    .set(q('.story__ring-status'), { opacity: 0 }, 0)
    .set(q('.story__issue'), { opacity: 0, y: 8 }, 0)
    .set(q('.story__istat-in'), { opacity: 1 }, 0)
    .set(q('.story__istat-out'), { opacity: 0 }, 0)
    .set(q('.story__issues'), { opacity: 1 }, 0)
    .set(q('.story__rebuilt'), { opacity: 0 }, 0)
    .set(q('.story__stack'), { opacity: 0, y: 6 }, 0)
    .set(q('.story__score'), { opacity: 0 }, 0)
    .set(q('.story__wire, .story__tag--orig'), { opacity: 1 }, 0)
    .set(q('.story__clean, .story__tag--copy'), { opacity: 0 }, 0)
    .set(q('.story__clean .blk'), { opacity: 0, y: 12 }, 0)
    .set(q('.story__bar i'), { scaleX: scoreFrom / 100 }, 0);

  // 1. Audit: scan line, rings fill one by one, issues appear in the column as the line passes.
  tl.fromTo(q('.story__scan'), { yPercent: -100, opacity: 1 }, { yPercent: 1000, duration: 2.8, ease: 'none' }, 0.2).to(q('.story__scan'), { opacity: 0, duration: 0.3 }, 3.0);
  q('.story__rings .ring').forEach((ring, i) => {
    const at = 0.4 + i * 0.7;
    const [r, l] = Array.from(ring.querySelectorAll<HTMLElement>('i'));
    tl.to(r, { rotation: 180, duration: 0.35, ease: 'none' }, at)
      .to(l, { rotation: 180, duration: 0.35, ease: 'none' }, at + 0.35)
      .to(ring.parentElement!.querySelector('.story__ring-status'), { opacity: 1, duration: 0.3 }, at + 0.75);
  });
  q('.story__issue').forEach((row, i) => tl.to(row, { opacity: 1, y: 0, duration: 0.45 }, 0.9 + i * 0.6));

  // 2. Fix: each status turns, one by one.
  q('.story__issue').forEach((row, i) => {
    const at = 4.2 + i * 0.5;
    tl.to(row.querySelector('.story__istat-in'), { opacity: 0, duration: 0.3 }, at).to(row.querySelector('.story__istat-out'), { opacity: 1, duration: 0.3 }, at);
  });

  // 3. Rebuild: wireframe → clean copy; the issue column gives way to the stacks and the score.
  tl.to(q('.story__issues'), { opacity: 0, duration: 0.35 }, 6.6)
    .to(q('.story__rebuilt'), { opacity: 1, duration: 0.3 }, 6.9)
    .to(q('.story__wire'), { opacity: 0, duration: 0.6 }, 6.6)
    .to(q('.story__clean'), { opacity: 1, duration: 0.4 }, 6.6)
    .to(q('.story__clean .blk'), { opacity: 1, y: 0, duration: 0.6, stagger: 0.12 }, 6.7)
    .to(q('.story__tag--orig'), { opacity: 0, duration: 0.3 }, 6.8)
    .to(q('.story__tag--copy'), { opacity: 1, duration: 0.3 }, 6.8)
    .to(q('.story__stack'), { opacity: 1, y: 0, duration: 0.4, stagger: 0.08 }, 7.0)
    .call(() => setText(num, String(scoreFrom)), [], 7.5)
    .to(q('.story__score'), { opacity: 1, duration: 0.4 }, 7.6)
    .to(score, { v: scoreTo, duration: 1.4, ease: 'power1.out', onUpdate: () => setText(num, String(Math.round(score.v))) }, 7.9)
    .to(q('.story__bar i'), { scaleX: scoreTo / 100, duration: 1.4, ease: 'power1.out' }, 7.9)
    .to({}, { duration: 0.7 }, 9.3);

  // The rail follows the playhead: active stage + progress line (--p, used as scaleY / scaleX in CSS).
  const stageOf = (t: number) => (t >= STAGE_AT[2] ? 2 : t >= STAGE_AT[1] ? 1 : 0);
  let stage = -1;
  tl.eventCallback('onUpdate', () => {
    rail?.style.setProperty('--p', tl.progress().toFixed(4));
    const s = stageOf(tl.time());
    if (s !== stage) setStage((stage = s));
  });
  // A paused timeline at 0 has not rendered its start state yet; run to the end and back so it has.
  tl.progress(1).progress(0);
  return tl;
}
