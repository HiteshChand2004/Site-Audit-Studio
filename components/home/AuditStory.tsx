'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Accessibility, Check, Flag, Gauge, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import SiteMock from './SiteMock';
import { FrameBar } from '@/components/ui';
import { EXAMPLE_RUN } from '@/lib/content';

/*
 * Audit → Fix → Rebuild, as one clear composition: the three-stage rail on the left (its progress line follows the
 * story) and ONE visual on the right that changes with the active stage, with four score rings in a row under it.
 * The GSAP timeline is in storyTimeline.ts. Desktop: the section sticks (CSS) and the scroll scrubs the story.
 * Phones: the rail becomes a horizontal 3-step indicator and the story plays once when seen, no pinning.
 * The server renders the last frame: what shows without JavaScript and under prefers-reduced-motion.
 * Rings show that a check finished plus a status word (an illustration); the only numbers are the example run's.
 */

const STAGES = [
  { title: 'Audit', line: 'Six checks, every issue ranked by how much it matters.' },
  { title: 'Fix', line: 'Fixed in your copy, or flagged for a person.' },
  { title: 'Rebuild', line: 'A clean copy in HTML, React, Next.js or MERN.' },
];

const RINGS = [
  { Icon: Gauge, name: 'Performance', status: 'Needs work', tone: 'warn' },
  { Icon: Search, name: 'SEO', status: 'Needs work', tone: 'warn' },
  { Icon: Accessibility, name: 'Accessibility', status: 'Issues', tone: 'bad' },
  { Icon: ShieldCheck, name: 'Best practices', status: 'Good', tone: 'ok' },
] as const;

/* Broken links and console errors are always flagged for you, never "fixed". */
const ISSUES = [
  { label: 'No alt text', fixed: true },
  { label: 'No page description', fixed: true },
  { label: 'Broken link', fixed: false },
  { label: 'Console error', fixed: false },
];

const STACKS = ['HTML', 'React', 'Next.js', 'MERN'];
const SCORE_FROM = EXAMPLE_RUN.lighthouseOriginal;
const SCORE_TO = 98;

function Ring({ Icon, tone }: { Icon: (typeof RINGS)[number]['Icon']; tone: string }) {
  return (
    <span className="ring" data-tone={tone} aria-hidden="true">
      <span className="ring__half ring__half--r">
        <i />
      </span>
      <span className="ring__half ring__half--l">
        <i />
      </span>
      <Icon size={16} className="ring__icon" />
    </span>
  );
}

export default function AuditStory({ head }: { head: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let revert: (() => void) | undefined;
    let cancelled = false;

    // Lazy-init: load GSAP, ScrollTrigger and the timeline only when the section is near the viewport.
    const io = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const [{ default: gsap }, { ScrollTrigger }, { buildStoryTimeline }] = await Promise.all([import('gsap'), import('gsap/ScrollTrigger'), import('./storyTimeline')]);
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);
        const build = () => buildStoryTimeline(el, SCORE_FROM, SCORE_TO);

        const mm = gsap.matchMedia();
        // Desktop: the section sticks (CSS) and the scroll scrubs the story.
        mm.add('(min-width: 960px)', () => {
          const tl = build();
          const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 64;
          ScrollTrigger.create({ trigger: el, start: `top top+=${headerH}`, end: 'bottom bottom', scrub: 0.6, animation: tl });
        });
        // Phones and tablets: no pinning; the story plays once when it is well in view.
        mm.add('(max-width: 959px)', () => {
          const tl = build();
          ScrollTrigger.create({ trigger: el, start: 'top 65%', once: true, onEnter: () => void tl.timeScale(1.3).play() });
        });
        revert = () => mm.revert();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);

    return () => {
      cancelled = true;
      io.disconnect();
      revert?.();
    };
  }, []);

  return (
    <div className="story" ref={root}>
      <div className="story__sticky">
        {head}
        <div className="story__layout">
          <ol className="srail" style={{ ['--p' as string]: 1 }}>
            <span className="srail__track" aria-hidden="true">
              <i className="srail__fill" />
            </span>
            {STAGES.map((s, i) => (
              <li key={s.title} className="srail__step" data-state={i === 2 ? 'active' : 'done'}>
                <span className="srail__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="srail__text">
                  <strong>{s.title}</strong>
                  <span>{s.line}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="story__visual" aria-hidden="true">
            <div className="frame story__frame">
              <div className="story__tags">
                <span className="story__tag story__tag--orig">
                  <FrameBar addr="yoursite.com" tag="Audit" />
                </span>
                <span className="story__tag story__tag--copy">
                  <FrameBar addr="yoursite.com · copy" tag="Rebuilt" tagInk />
                </span>
              </div>
              <div className="story__body">
                <div className="story__page">
                  <div className="story__wire">
                    <SiteMock wire />
                  </div>
                  <div className="story__clean">
                    <SiteMock />
                  </div>
                  <div className="story__scan" />
                </div>
                <div className="story__side">
                  <ul className="story__issues">
                    {ISSUES.map((it) => (
                      <li key={it.label} className="story__issue">
                        <span className="story__iname">{it.label}</span>
                        <span className="story__istat">
                          <span className="story__istat-in" data-tone={it.fixed ? 'bad' : 'warn'}>
                            <TriangleAlert size={11} strokeWidth={2.6} /> Issue found
                          </span>
                          <span className="story__istat-out" data-tone={it.fixed ? 'ok' : 'warn'}>
                            {it.fixed ? <Check size={11} strokeWidth={3} /> : <Flag size={11} />}
                            {it.fixed ? 'Fixed in your copy' : 'Flagged for you'}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="story__rebuilt">
                    <ul className="story__stacks">
                      {STACKS.map((s) => (
                        <li key={s} className="story__stack" data-active={s === 'Next.js' || undefined}>
                          {s}
                        </li>
                      ))}
                    </ul>
                    <div className="story__score">
                      <span className="label">Lighthouse</span>
                      <span className="story__nums">
                        <span className="story__num display">{SCORE_TO}</span>
                        <span className="story__from">from {SCORE_FROM}</span>
                      </span>
                      <span className="story__bar">
                        <i />
                      </span>
                      <span className="story__note">Example run · {EXAMPLE_RUN.site}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <ul className="story__rings">
              {RINGS.map((r) => (
                <li key={r.name}>
                  <Ring Icon={r.Icon} tone={r.tone} />
                  <span className="story__ring-name">{r.name}</span>
                  <span className="story__ring-status" data-tone={r.tone}>
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="visually-hidden">
          The audit checks performance, SEO, accessibility, best practices, broken links and console errors. Missing alt text and page descriptions are
          fixed in your copy; broken links and console errors are flagged for you. The copy is rebuilt in your stack. In the example run on {EXAMPLE_RUN.site},
          Lighthouse went from {SCORE_FROM} to {EXAMPLE_RUN.lighthouseCopy}.
        </p>
      </div>
    </div>
  );
}
