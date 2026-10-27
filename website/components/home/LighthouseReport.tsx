'use client';

import { useState } from 'react';
import type { ShowRun } from '@/lib/content';

/*
 * The Lighthouse scores as one round dial, like the report in Chrome DevTools: the ring is split into four parts
 * (Performance, Accessibility, Best Practices, SEO), each part filled to its score in the Lighthouse bands
 * (0–49 red, 50–89 orange, 90–100 green). Hover, focus or tap a part and the centre shows that category's score. One dial
 * for the original, one for the copy, Mobile / Desktop tabs on top. The scores come from the run it is given: when the
 * run changes the parts re-fill to the new figures. `onHold` tells the carousel above that the visitor is pointing at a
 * ring (hover, touch or focus), so the run does not change underneath them; away from the rings it keeps going. Every value is read from lib/content.ts (showRuns); nothing is typed in here.
 */

const CATS = [
  { key: 'performance', label: 'Performance' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'bestPractices', label: 'Best Practices' },
  { key: 'seo', label: 'SEO' },
] as const;
type Key = (typeof CATS)[number]['key'];

const band = (n: number) => (n >= 90 ? 'good' : n >= 50 ? 'mid' : 'bad');
const R = 54;
const CIRC = 2 * Math.PI * R;
const GAP = 7; // length of the gap between parts, in stroke units
const SEG = CIRC / 4 - GAP;

function Dial({ title, tone, scores, delay, onHold }: { title: string; tone: 'original' | 'copy'; scores: Record<Key, number>; delay: number; onHold?: (held: boolean) => void }) {
  const [active, setActive] = useState<Key>('performance');
  const cat = CATS.find((c) => c.key === active)!;
  const value = scores[active];
  const on = (k: Key) => ({ onMouseEnter: () => setActive(k), onFocus: () => setActive(k), onClick: () => setActive(k) });

  return (
    <section className="dial" data-tone={tone} data-band={band(value)} aria-label={title}>
      <h4 className="lh__title">{title}</h4>
      <div className="dial__ring" onPointerEnter={() => onHold?.(true)} onPointerLeave={() => onHold?.(false)} onPointerDown={() => onHold?.(true)} onFocus={() => onHold?.(true)} onBlur={() => onHold?.(false)}>
        <svg viewBox="0 0 128 128" aria-hidden="true">
          {CATS.map((c, i) => {
            const v = scores[c.key];
            const rot = -90 + i * 90 + (GAP / CIRC) * 180;
            const len = (SEG * v) / 100;
            return (
              <g key={c.key} transform={`rotate(${rot} 64 64)`} data-band={band(v)} data-on={active === c.key || undefined} className="dial__part" style={{ ['--len' as string]: len, ['--d' as string]: `${delay + i * 140}ms` }}>
                <circle cx="64" cy="64" r={R} className="dial__track" strokeDasharray={`${SEG} ${CIRC}`} />
                <circle cx="64" cy="64" r={R} className="dial__fill" style={{ strokeDasharray: `${len} ${CIRC}` }} />
                <circle cx="64" cy="64" r={R} className="dial__hit" strokeDasharray={`${SEG} ${CIRC}`} tabIndex={0} role="button" aria-label={`${c.label} ${v}`} {...on(c.key)} />
              </g>
            );
          })}
        </svg>
        <div className="dial__centre" aria-live="polite">
          <strong key={`${active}-${value}`}>{value}</strong>
          <span>{cat.label}</span>
        </div>
      </div>
    </section>
  );
}

export default function LighthouseReport({ run, onHold }: { run: ShowRun; onHold?: (held: boolean) => void }) {
  const [device, setDevice] = useState<'mobile' | 'desktop'>('mobile');
  const scores = run.lighthouse[device];

  return (
    <div className="lh">
      <div className="lh__head">
        <div>
          <h3 className="lh__name">Lighthouse report</h3>
          <p className="lh__sub">Original and copy, same device and settings</p>
        </div>
        <div className="lh__tabs" role="tablist" aria-label="Device">
          {(['mobile', 'desktop'] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={device === d} className="lh__tab" onClick={() => setDevice(d)}>
              {d === 'mobile' ? 'Mobile' : 'Desktop'}
            </button>
          ))}
        </div>
      </div>
      <div className="lh__body" role="tabpanel">
        <Dial key={`o-${device}`} title="Original" tone="original" scores={scores.original} delay={0} onHold={onHold} />
        <Dial key={`c-${device}`} title="Copy" tone="copy" scores={scores.copy} delay={500} onHold={onHold} />
      </div>
      <p className="lh__hint">Hover or tap a part of the ring to see its score.</p>
      <ul className="lh__scale" aria-label="Score scale">
        <li data-band="bad">
          <i aria-hidden="true" /> 0–49
        </li>
        <li data-band="mid">
          <i aria-hidden="true" /> 50–89
        </li>
        <li data-band="good">
          <i aria-hidden="true" /> 90–100
        </li>
      </ul>
    </div>
  );
}
