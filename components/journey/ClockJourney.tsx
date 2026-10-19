'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Check, FileCode2, Folder, Lock, TriangleAlert } from 'lucide-react';

/*
 * How it works, as a dial. Six steps sit around it like hour markers; a hand and a progress arc sweep around as
 * you scroll (desktop: the section sticks, CSS), each marker lights up when the hand reaches it, the centre shows
 * the active step's own small visual and the panel beside the dial shows its number, title and line.
 * Phones: a compact dial sticks at the top and advances as each step's block scrolls into view (no pinning).
 * Reduced motion / no JavaScript: a static, complete dial with all steps listed.
 * Everything moves with transforms and opacity; the arc fill uses two rotating half-rings (no stroke animation).
 */

export type ClockStep = { title: string; text: string };

const MAX_ANGLE = 345; // the hand stops just short of a full turn, past the last marker (300°)

/* ---------- Six small visuals, one per step (never used elsewhere) ---------- */
function TypedUrl() {
  return (
    <div className="cz cz--url">
      <span className="cz__url">
        <Lock size={12} />
        <span className="cz__typed">yoursite.com</span>
        <i className="cz__caret" />
        <b>Audit</b>
      </span>
    </div>
  );
}

function ScanChips() {
  return (
    <div className="cz cz--scan">
      <div className="cz__sheet">
        <i />
        <i />
        <i />
        <i />
        <span className="cz__beam" />
      </div>
      <span className="cz__chip cz__chip--bad">
        <TriangleAlert size={11} /> No alt text
      </span>
      <span className="cz__chip cz__chip--warn">
        <TriangleAlert size={11} /> Broken link
      </span>
    </div>
  );
}

function StackPick() {
  return (
    <div className="cz cz--pick">
      <span className="cz__pickpill" />
      <span>HTML</span>
      <span>React + Vite</span>
      <span>Next.js</span>
      <span>MERN</span>
    </div>
  );
}

function Assemble() {
  return (
    <div className="cz cz--build">
      <i className="cz__b cz__b--nav" />
      <i className="cz__b cz__b--hero" />
      <i className="cz__b cz__b--art" />
      <i className="cz__b cz__b--c1" />
      <i className="cz__b cz__b--c2" />
      <i className="cz__b cz__b--c3" />
    </div>
  );
}

function Split() {
  return (
    <div className="cz cz--split">
      <div className="cz__half cz__half--before">
        <i />
        <i />
        <i />
      </div>
      <div className="cz__half cz__half--after">
        <i />
        <i />
        <i />
      </div>
      <span className="cz__divider" />
      <span className="cz__tag cz__tag--l">Before</span>
      <span className="cz__tag cz__tag--r">After</span>
    </div>
  );
}

function Deploy() {
  return (
    <div className="cz cz--deploy">
      <ul className="cz__tree">
        <li>
          <Folder size={12} /> yoursite/
        </li>
        <li className="cz__in">
          <FileCode2 size={12} /> index.html
        </li>
        <li className="cz__in">
          <Folder size={12} /> assets/
        </li>
      </ul>
      <span className="cz__live">
        <Check size={12} strokeWidth={3} /> Deployed
      </span>
    </div>
  );
}

const VIZ: Array<() => ReactNode> = [TypedUrl, ScanChips, StackPick, Assemble, Split, Deploy];

export default function ClockJourney({ steps, head }: { steps: ClockStep[]; head?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = window.matchMedia('(min-width: 960px)');
    const marks = Array.from(el.querySelectorAll<HTMLElement>('.clk__mark'));
    const blocks = Array.from(el.querySelectorAll<HTMLElement>('.clk__item'));
    const n = steps.length;
    const step = 360 / n;

    let target = 0;
    let angle = 0;
    let frame = 0;
    let active = -1;

    const render = (a: number) => {
      el.style.setProperty('--a', `${a.toFixed(2)}deg`);
      el.style.setProperty('--ar', `${Math.min(a, 180).toFixed(2)}deg`);
      el.style.setProperty('--al', `${Math.max(0, a - 180).toFixed(2)}deg`);
      const idx = Math.min(n - 1, Math.floor(a / step + 0.001));
      marks.forEach((m, i) => {
        if (i <= idx) m.dataset.lit = '';
        else delete m.dataset.lit;
      });
      if (idx !== active) {
        active = idx;
        el.dataset.step = String(idx);
      }
    };

    // Ease the hand toward the target angle: smooth on wheel steps, no overshoot.
    const tick = () => {
      frame = 0;
      angle += (target - angle) * 0.16;
      if (Math.abs(target - angle) < 0.05) angle = target;
      render(angle);
      if (angle !== target) frame = requestAnimationFrame(tick);
    };
    const go = (a: number, instant = false) => {
      target = a;
      if (instant) {
        angle = a;
        render(a);
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };

    if (reduced.matches) {
      el.dataset.mode = 'static';
      render(MAX_ANGLE);
      return;
    }

    let io: IntersectionObserver | undefined;
    const onScroll = (instant?: unknown) => {
      if (!desktop.matches) return;
      const r = el.getBoundingClientRect();
      const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 64;
      const total = r.height - (window.innerHeight - headerH);
      const p = total > 0 ? Math.min(1, Math.max(0, (headerH - r.top) / total)) : 0;
      go(p * MAX_ANGLE, instant === true);
    };

    const setup = () => {
      io?.disconnect();
      if (desktop.matches) {
        el.dataset.mode = 'pin';
        onScroll(true);
      } else {
        // Phones: the dial advances as each step's block comes into view.
        el.dataset.mode = 'list';
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const i = blocks.indexOf(e.target as HTMLElement);
              if (i >= 0) go(i * step + step / 2);
            }
          },
          { rootMargin: '-45% 0px -45% 0px' },
        );
        blocks.forEach((b) => io!.observe(b));
        go(0, true);
      }
    };

    setup();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    desktop.addEventListener('change', setup);
    return () => {
      cancelAnimationFrame(frame);
      io?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      desktop.removeEventListener('change', setup);
    };
  }, [steps.length]);

  return (
    <div ref={root} className="clk" data-step={steps.length - 1} data-mode="static" style={{ ['--a' as string]: `${MAX_ANGLE}deg`, ['--ar' as string]: '180deg', ['--al' as string]: `${MAX_ANGLE - 180}deg` }}>
      <div className="clk__sticky">
        {head}
        <div className="clk__stage">
          <div className="clk__dial" aria-hidden="true">
            <svg className="clk__ticks" viewBox="0 0 400 400">
              {Array.from({ length: 60 }, (_, i) => {
                const major = i % 10 === 0;
                return <line key={i} x1="200" y1={major ? 10 : 14} x2="200" y2={major ? 26 : 21} transform={`rotate(${i * 6} 200 200)`} className={major ? 'clk__tick clk__tick--major' : 'clk__tick'} />;
              })}
            </svg>
            <div className="clk__track" />
            <div className="clk__arc">
              <span className="clk__half clk__half--r">
                <i />
              </span>
              <span className="clk__half clk__half--l">
                <i />
              </span>
            </div>
            <div className="clk__glow" />
            <div className="clk__hand">
              <i />
            </div>
            <span className="clk__pivot" />
            {steps.map((s, i) => {
              const rad = (i * (360 / steps.length) * Math.PI) / 180;
              return (
                <span key={s.title} className="clk__mark" data-lit="" style={{ ['--mx' as string]: Math.sin(rad).toFixed(4), ['--my' as string]: (-Math.cos(rad)).toFixed(4) }}>
                  <i className="clk__dot" />
                  <span className="clk__label">{s.title}</span>
                </span>
              );
            })}
            <div className="clk__center">
              {steps.map((s, i) => {
                const Viz = VIZ[i];
                return (
                  <div key={s.title} className="clk__viz" data-i={i} data-loop>
                    {Viz && <Viz />}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="clk__panel" aria-hidden="true">
            {steps.map((s, i) => (
              <div key={s.title} className="clk__copy" data-i={i}>
                <span className="clk__num">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="display clk__title">{s.title}</h3>
                <p className="clk__line">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Phones and reduced motion: every step as its own block. Screen readers always use this list. */}
      <ol className="clk__list">
        {steps.map((s, i) => {
          const Viz = VIZ[i];
          return (
            <li key={s.title} className="clk__item">
              <span className="clk__inum" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h2 className="clk__ititle">
                  <span className="visually-hidden">Step {i + 1}: </span>
                  {s.title}
                </h2>
                <p className="clk__iline">{s.text}</p>
              </div>
              <div className="clk__iviz" data-loop aria-hidden="true">
                {Viz && <Viz />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
