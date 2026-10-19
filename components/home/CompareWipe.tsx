'use client';

import { useEffect, useRef } from 'react';
import { Accessibility, Check, Gauge, MousePointer2, MousePointerClick, MoveHorizontal, Search, Sparkles, TriangleAlert } from 'lucide-react';
import SiteMock from './SiteMock';
import { FrameBar } from '@/components/ui';
import { EXAMPLE_RUN } from '@/lib/content';

/*
 * Compact before/after card. The original is on the left of the wipe line, the copy on the right. When the card
 * comes into view the line sweeps once across (issue markers turn into ticks as it passes, the example score ticks
 * up), settles in the middle, and the Kept / Fixed chips come in. After that it can be dragged, or moved with the
 * arrow keys (a native range input). The wipe is transform-only: a clipping box and its counter-shifted content.
 * The server renders the settled state, which is also the static frame under prefers-reduced-motion.
 */

/* Fixable issues only, on the block they belong to (percent of the page area). */
const MARKS = [
  { top: '4%', left: '32%', issue: 'No description', fix: 'Description added' },
  { top: '30%', left: '58%', issue: 'No alt text', fix: 'Alt text added' },
  { top: '46%', left: '4%', issue: 'Headings out of order', fix: 'Headings fixed' },
  { top: '78%', left: '30%', issue: 'Unused JS', fix: 'Unused JS removed' },
];

const KEPT = [
  { Icon: Sparkles, label: 'Animations' },
  { Icon: MousePointer2, label: 'Hovers' },
  { Icon: MousePointerClick, label: 'Clicks' },
];
const FIXED = [
  { Icon: Accessibility, label: 'Accessibility' },
  { Icon: Search, label: 'SEO' },
  { Icon: Gauge, label: 'Speed' },
];

const SCORE_FROM = EXAMPLE_RUN.lighthouseOriginal;
const SCORE_TO = 98;
const REST = 50;

export default function CompareWipe() {
  const root = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const num = useRef<HTMLSpanElement>(null);

  const setPos = (p: number) => {
    root.current?.style.setProperty('--pos', String(p));
    if (range.current) {
      range.current.value = String(Math.round(p));
      range.current.setAttribute('aria-valuetext', `${Math.round(p)}% original, ${100 - Math.round(p)}% copy`);
    }
  };

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    let kill: (() => void) | undefined;
    const chips = Array.from(el.querySelectorAll<HTMLElement>('.wipe__chip'));
    const setNum = (v: number) => {
      const n = num.current?.firstChild;
      if (n) n.nodeValue = String(v);
    };

    // Lazy-init near the viewport: put the card in its start state, then sweep once it is half in view.
    const near = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting) return;
        near.disconnect();
        const { default: gsap } = await import('gsap');
        if (cancelled) return;
        setPos(100);
        setNum(SCORE_FROM);
        gsap.set(chips, { opacity: 0, y: 10 });

        const seen = new IntersectionObserver(
          ([e]) => {
            if (!e.isIntersecting) return;
            seen.disconnect();
            const p = { v: 100 };
            const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });
            tl.to(p, {
              v: 0,
              duration: 1.8,
              onUpdate: () => {
                setPos(p.v);
                setNum(Math.round(SCORE_FROM + ((SCORE_TO - SCORE_FROM) * (100 - p.v)) / 100));
              },
            })
              .to(p, { v: REST, duration: 0.9, onUpdate: () => setPos(p.v) })
              .to(chips, { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, ease: 'power3.out' }, '-=0.4');
            // Any interaction ends the sweep at once.
            const stop = () => {
              tl.progress(1).kill();
              setNum(SCORE_TO);
            };
            range.current?.addEventListener('pointerdown', stop, { once: true });
            range.current?.addEventListener('keydown', stop, { once: true });
            kill = () => tl.kill();
          },
          { threshold: 0.5 },
        );
        seen.observe(el);
        const prev = kill;
        kill = () => {
          prev?.();
          seen.disconnect();
        };
      },
      { rootMargin: '300px 0px' },
    );
    near.observe(el);

    return () => {
      cancelled = true;
      near.disconnect();
      kill?.();
    };
  }, []);

  const layer = (kind: 'orig' | 'copy') => (
    <div className={`wipe__layer wipe__layer--${kind}`}>
      <SiteMock />
      {MARKS.map((m) => (
        <span key={m.issue} className={`wipe__mark wipe__mark--${kind}`} style={{ top: m.top, left: m.left }}>
          {kind === 'orig' ? <TriangleAlert size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={3} />}
          <span>{kind === 'orig' ? m.issue : m.fix}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="card wipe" ref={root} style={{ ['--pos' as string]: REST }}>
      <div className="wipe__view">
        <FrameBar addr="yoursite.com" />
        <div className="wipe__stage">
          <div aria-hidden="true">
            {layer('copy')}
            <div className="wipe__clip">
              <div className="wipe__counter">{layer('orig')}</div>
            </div>
            <span className="wipe__tag wipe__tag--orig">Before</span>
            <span className="wipe__tag wipe__tag--copy">After</span>
            <div className="wipe__handle">
              <span className="wipe__line" />
              <span className="wipe__knob">
                <MoveHorizontal size={16} />
              </span>
            </div>
          </div>
          <input
            ref={range}
            className="wipe__range"
            type="range"
            min={0}
            max={100}
            step={1}
            defaultValue={REST}
            onInput={(e) => setPos(Number(e.currentTarget.value))}
            aria-label="Compare before and after"
            aria-valuetext={`${REST}% original, ${100 - REST}% copy`}
          />
        </div>
      </div>

      <div className="wipe__side">
        <div className="wipe__score">
          <span className="label">Lighthouse</span>
          <span className="wipe__nums">
            <span className="wipe__from">{SCORE_FROM}</span>
            <span aria-hidden="true">→</span>
            <span ref={num} className="wipe__to display">
              {SCORE_TO}
            </span>
          </span>
          <span className="wipe__note">
            Example run · {EXAMPLE_RUN.site} · visual difference {EXAMPLE_RUN.visualDiff}
          </span>
        </div>
        <div className="wipe__group">
          <span className="label">Kept</span>
          <div className="wipe__chips">
            {KEPT.map(({ Icon, label }) => (
              <span key={label} className="wipe__chip">
                <Icon size={14} aria-hidden="true" /> {label}
              </span>
            ))}
          </div>
        </div>
        <div className="wipe__group">
          <span className="label">Fixed</span>
          <div className="wipe__chips wipe__chips--fixed">
            {FIXED.map(({ Icon, label }) => (
              <span key={label} className="wipe__chip">
                <Icon size={14} aria-hidden="true" /> {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
