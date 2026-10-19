'use client';

import { useEffect, useRef } from 'react';
import { Layers, MousePointer2, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui';
import { EXAMPLE_RUN } from '@/lib/content';

/*
 * The one example run whose numbers the site quotes, in an open layout: a large Lighthouse pair (original → copy)
 * with a thin bar between them, and three compact stats. Numbers count up once when it scrolls into view (the server
 * renders the final values; reduced motion keeps them). The site switcher (Phase 6) will plug in here.
 */

const FROM = EXAMPLE_RUN.lighthouseOriginal;
const TO = 98;

const STATS = [
  { Icon: Layers, label: 'Visual difference', value: '<1%' },
  { Icon: MousePointer2, label: 'Hovers kept', value: EXAMPLE_RUN.hovers },
  { Icon: Terminal, label: 'Console errors', value: String(EXAMPLE_RUN.consoleErrors) },
];

export default function ExampleRun() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el?.classList.add('is-counted');
      return;
    }
    const nums = Array.from(el.querySelectorAll<HTMLElement>('[data-count]'));
    const set = (n: HTMLElement, v: number) => {
      const t = n.firstChild;
      if (t) t.nodeValue = String(v);
    };
    nums.forEach((n) => set(n, 0));

    let frame = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        el.classList.add('is-counted');
        const start = performance.now();
        const dur = 1400;
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          nums.forEach((n) => set(n, Math.round(Number(n.dataset.count) * eased)));
          if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={root} className="xrun" data-reveal>
      <Badge tone="accent">Example run · {EXAMPLE_RUN.site}</Badge>
      <div className="xrun__grid">
        <div className="xrun__pair">
          <p className="label">Lighthouse</p>
          <div className="xrun__nums">
            <span className="xrun__num">
              <span className="display xrun__big xrun__big--old" data-count={FROM}>
                {FROM}
              </span>
              <span className="xrun__cap">Original</span>
            </span>
            <span className="xrun__bar" aria-hidden="true">
              <i />
            </span>
            <span className="xrun__num">
              <span className="display xrun__big">
                <span data-count={TO}>{TO}</span>
                <small>–99</small>
              </span>
              <span className="xrun__cap">Copy</span>
            </span>
          </div>
        </div>
        <ul className="xrun__stats">
          {STATS.map(({ Icon, label, value }) => (
            <li key={label}>
              <span className="xrun__ico" aria-hidden="true">
                <Icon size={18} />
              </span>
              <strong className="display">{value}</strong>
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="xrun__foot">Results vary by site.</p>
    </div>
  );
}
