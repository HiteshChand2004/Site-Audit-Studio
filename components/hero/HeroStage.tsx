'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight, Check, Lock, TriangleAlert } from 'lucide-react';
import SiteMock from '@/components/home/SiteMock';
import { FrameBar } from '@/components/ui';
import { buildHeroTimeline, GAUGE_C, GAUGE_R, SCORE_COPY, SCORE_ORIGINAL, STATUS_TEXT, URL_TEXT } from './timeline';

/*
 * The hero stage: an address bar, the original site and its rebuilt copy as 3D cards, and the step rail.
 * Each card has fixed zones (header bar 34px, page, footer 56px); the issues and the score have their own slots in
 * the footer, so nothing ever sits on top of something else. The loop is seamless and pauses off screen or in a
 * hidden tab. The server renders the last frame (what shows without JavaScript and under prefers-reduced-motion).
 * When motion is allowed, the scene stays hidden for a moment (CSS) until the timeline is built, so the loop
 * starts cleanly at its first frame; a CSS fallback shows it after 2.5 s if scripts never run.
 */

const STEPS = ['Paste', 'Audit', 'Fix', 'Rebuild'];
const ISSUES = ['No description', 'No alt text', 'Unused JS'];

function Score({ score, tone }: { score: number; tone: 'old' | 'new' }) {
  return (
    <div className={`cine__score cine__score--${tone}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r={GAUGE_R} className="cine__score-track" />
        <circle cx="18" cy="18" r={GAUGE_R} className="cine__score-arc" strokeDasharray={GAUGE_C} strokeDashoffset={GAUGE_C * (1 - score / 100)} />
      </svg>
      <span className="cine__score-num">{score}</span>
      <span className="cine__score-label">Lighthouse</span>
    </div>
  );
}

function Card({ kind }: { kind: 'orig' | 'copy' }) {
  const orig = kind === 'orig';
  return (
    <div className={`cine__card cine__card--${kind}`}>
      <div className="frame cine__frame">
        <FrameBar addr={orig ? URL_TEXT : 'preview · localhost'} tag={orig ? 'Original' : 'Rebuilt · Next.js'} tagInk={!orig} />
        <div className="cine__page">
          <SiteMock />
          {orig && (
            <>
              <div className="cine__grid" />
              <div className="cine__beam" />
            </>
          )}
        </div>
        <div className="cine__foot">
          {orig ? (
            <ul className="cine__issues">
              {ISSUES.map((label) => (
                <li key={label} className="cine__issue" data-state="fixed">
                  <TriangleAlert size={12} strokeWidth={2.4} className="cine__issue-warn" />
                  <Check size={12} strokeWidth={3} className="cine__issue-ok" />
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="cine__fixed">
              <Check size={13} strokeWidth={3} /> Fixes applied
            </span>
          )}
          <Score score={orig ? SCORE_ORIGINAL : SCORE_COPY} tone={orig ? 'old' : 'new'} />
          {!orig && <span className="cine__delta">+{SCORE_COPY - SCORE_ORIGINAL}</span>}
        </div>
        {orig && <span className="cine__dim" />}
      </div>
    </div>
  );
}

export default function HeroStage() {
  const root = useRef<HTMLElement>(null);
  const tlRef = useRef<ReturnType<typeof buildHeroTimeline> | null>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const sync = () => {
      const tl = tlRef.current;
      if (!tl) return;
      if (!visibleRef.current || document.hidden) tl.pause();
      else tl.play();
    };
    const build = () => {
      tlRef.current?.revert();
      tlRef.current = buildHeroTimeline(el);
      sync();
    };

    try {
      build();
    } catch (err) {
      // Never leave the stage hidden: fall back to the static last frame.
      console.error(err);
      el.dataset.anim = 'static';
      return;
    }
    el.dataset.anim = 'on';

    // Card poses differ between the phone and desktop layouts.
    const layoutMq = window.matchMedia('(min-width: 720px)');
    layoutMq.addEventListener('change', build);

    // Pause when off-screen or when the tab is hidden.
    const io = new IntersectionObserver(([entry]) => {
      visibleRef.current = entry.isIntersecting;
      sync();
    });
    io.observe(el);
    document.addEventListener('visibilitychange', sync);

    // Subtle pointer parallax on the whole scene (mouse and trackpad only).
    const stage = el.querySelector<HTMLElement>('.cine');
    const fine = window.matchMedia('(pointer: fine)').matches;
    const onMove = (e: PointerEvent) => {
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      stage.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
      stage.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
    };
    const onLeave = () => {
      stage?.style.setProperty('--px', '0');
      stage?.style.setProperty('--py', '0');
    };
    if (fine && stage) {
      stage.addEventListener('pointermove', onMove);
      stage.addEventListener('pointerleave', onLeave);
    }

    return () => {
      layoutMq.removeEventListener('change', build);
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      stage?.removeEventListener('pointermove', onMove);
      stage?.removeEventListener('pointerleave', onLeave);
      tlRef.current?.revert();
      tlRef.current = null;
      el.dataset.anim = 'pending';
    };
  }, []);

  return (
    <figure className="cine-figure" ref={root} data-anim="pending">
      <div className="cine">
        <div className="cine__backdrop" aria-hidden="true" />
        <div className="cine__scene" aria-hidden="true">
          <div className="cine__url">
            <Lock size={15} strokeWidth={2.2} className="cine__lock" />
            <span className="cine__proto">https://</span>
            <span className="cine__typed">{URL_TEXT}</span>
            <span className="cine__caret" />
            <span className="cine__go" data-status="done">
              <Check size={15} strokeWidth={3} className="cine__go-check" />
              <span className="cine__go-label">{STATUS_TEXT.done}</span>
            </span>
          </div>

          <Card kind="orig" />
          <span className="cine__link">
            <ArrowRight size={20} strokeWidth={2.2} />
          </span>
          <Card kind="copy" />
        </div>
      </div>

      <figcaption>
        <p className="visually-hidden">
          Animation: the address makememo.ai is pasted and audited. Three issues are found and fixed, and a rebuilt copy that looks the same slides out, built in
          Next.js, with a Lighthouse score of 98 against 91 for the original.
        </p>
        <div className="cine-rail">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s} data-state={i < STEPS.length - 1 ? 'done' : 'active'}>
                <span className="cine-rail__n" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="cine-rail__label">{s}</span>
                <i className="cine-rail__dot" aria-hidden="true" />
              </li>
            ))}
          </ol>
          <span className="cine-rail__line" aria-hidden="true" />
        </div>
      </figcaption>
    </figure>
  );
}
