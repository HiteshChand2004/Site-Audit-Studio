'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import '@/app/tour.css';

export type JourneyStep = { id: string; title: string; text: string; screen: string; visual: ReactNode };

const STEP_MS = 5000;

/*
 * "How it works" as a stepper: the six steps on the left, and on the right a window of the app showing that step.
 * The steps loop on their own (a bar fills on the active one) while the stepper is on screen. Picking a step jumps to it
 * and the loop carries on from there. Under reduced motion nothing plays. Without JavaScript the first step shows, and
 * every step's words are still listed.
 */
export default function Journey({ steps }: { steps: JourneyStep[] }) {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setAuto(false);
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const playing = auto && inView;

  useEffect(() => {
    if (!playing) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % steps.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, active, steps.length]);

  const pick = (i: number) => setActive(i);

  return (
    <div ref={root} className="hw-stepper" style={{ ['--step-ms' as string]: `${STEP_MS}ms` }}>
      <ol className="hw-steps" role="tablist" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.id} role="presentation">
            <button
              type="button"
              role="tab"
              id={`tab-${s.id}`}
              aria-selected={active === i}
              aria-controls="hw-panel"
              className="hw-step"
              data-done={i < active || undefined}
              onClick={() => pick(i)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  pick((i + 1) % steps.length);
                  (e.currentTarget.parentElement?.parentElement?.children[(i + 1) % steps.length]?.querySelector('button') as HTMLButtonElement | null)?.focus();
                }
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const j = (i - 1 + steps.length) % steps.length;
                  pick(j);
                  (e.currentTarget.parentElement?.parentElement?.children[j]?.querySelector('button') as HTMLButtonElement | null)?.focus();
                }
              }}
              tabIndex={active === i ? 0 : -1}
            >
              <span className="hw-step__num">{i + 1}</span>
              <span className="hw-step__words">
                <span className="hw-step__title">{s.title}</span>
                <span className="hw-step__text">{s.text}</span>
              </span>
              {active === i && playing && <span className="hw-step__bar" key={`bar-${active}`} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ol>

      <div className="hw-window" id="hw-panel" role="tabpanel" aria-labelledby={`tab-${steps[active].id}`}>
        <div className="hw-window__bar" aria-hidden="true">
          <span className="hw-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="hw-window__title">{steps[active].screen}</span>
          <span className="hw-window__count">
            Step {active + 1} of {steps.length}
          </span>
        </div>
        <div className="hw-window__body">
          {steps.map((s, i) => (
            <div key={s.id} className="hw-scene" data-on={active === i || undefined} aria-hidden={active !== i}>
              {s.visual}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
