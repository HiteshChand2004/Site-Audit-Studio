import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { ArrowRight, Check, Clock, Eye, Globe, Hand, Scale, ServerCog, ShieldAlert, Timer, UserCheck } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { AuditMini, CompareMini, FixedMini, KeptMini, ReportMini, StacksMini } from '@/components/features/FeatureVisuals';
import { Badge, IconList, PageHero, Section, SectionHead } from '@/components/ui';
import { LIMITS } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  '/features',
  'Features',
  'What you get with Remastly: an audit of performance, SEO, accessibility, best practices, broken links and console errors; animations, hovers and clicks kept; common problems fixed; four stacks; a side-by-side compare view; and a shareable report.',
);

const LIMIT_ICONS = [UserCheck, Hand, Eye, Scale, ShieldAlert, Timer, ServerCog, Globe];

type Capability = { id: string; label: string; title: ReactNode; lead: string; points: string[]; Viz: ComponentType; extra?: ReactNode };

/* What you get, by capability. The journey (in which order) lives on How it works. */
const CAPABILITIES: Capability[] = [
  {
    id: 'audit',
    label: 'Audit',
    title: (
      <>
        An honest <em>audit</em>.
      </>
    ),
    lead: 'Every issue found and ranked before anything is rebuilt.',
    points: ['Performance, phone and computer', 'SEO and accessibility', 'Best practices and console errors', 'Broken links, AI answers, platform', 'Ranked: Important, Worth fixing, Minor', 'Plain words, with why it matters'],
    Viz: AuditMini,
  },
  {
    id: 'kept',
    label: 'Kept as-is',
    title: (
      <>
        Everything that moves, <em>kept</em>.
      </>
    ),
    lead: 'Rebuilt as real behaviour, not a flat picture.',
    points: ['Animations play as before', 'Hovers react the same', 'Menus and toggles respond', 'Images, fonts and videos saved with the copy'],
    Viz: KeptMini,
  },
  {
    id: 'fixed',
    label: 'Fixed for you',
    title: (
      <>
        Quietly <em>fixed</em>.
      </>
    ),
    lead: 'Common problems solved in the copy, then checked again.',
    points: ['Alt text and heading order', 'Titles, descriptions, link previews', 'Site map and robots.txt', 'Lighter pages, unused code removed', 'What it can’t fix: flagged for you'],
    Viz: FixedMini,
  },
  {
    id: 'stacks',
    label: 'Four stacks',
    title: (
      <>
        Your stack, your <em>call</em>.
      </>
    ),
    lead: 'The same site, in the code your team uses.',
    points: ['Plain HTML: simplest, fastest', 'React + Vite or Next.js', 'MERN: forms that store messages', 'Download as one .zip'],
    Viz: StacksMini,
  },
  {
    id: 'compare',
    label: 'Compare view',
    title: (
      <>
        Side by <em>side</em>.
      </>
    ),
    lead: 'Original and copy, page by page, at every screen size.',
    points: ['Computer, tablet and phone', 'Both scroll together', 'A match score for every page', 'Pages below 80 flagged first', 'Private preview: nothing is published'],
    Viz: CompareMini,
    extra: (
      <p className="soon">
        <Badge tone="accent">
          <Clock size={13} aria-hidden="true" /> Coming soon
        </Badge>
        <span>
          <strong>Exact copy</strong>: matched at every screen size.
        </span>
      </p>
    ),
  },
  {
    id: 'report',
    label: 'Report',
    title: (
      <>
        A report you can <em>share</em>.
      </>
    ),
    lead: 'The audit and the before/after, in one file.',
    points: ['PDF, HTML or JSON', 'Fixed and flagged, side by side', 'Speed against Google’s targets', 'Regenerate after any run'],
    Viz: ReportMini,
    extra: (
      <p className="more">
        <Link href="/report" className="link-arrow">
          Inside the report <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </p>
    ),
  },
];

export default function Features() {
  return (
    <>
      <PageHero
        label="Features"
        title={
          <>
            Everything you <em>get</em>.
          </>
        }
        lead="Six capabilities, one tool. Audit a site, keep what works, fix what doesn’t, and take it home in your stack."
      />

      {CAPABILITIES.map(({ id, label, title, lead, points, Viz, extra }, i) => (
        <Section key={id} id={id} labelledBy={`${id}-title`} tone={i % 2 ? 'tint' : 'plain'} className={i === 0 ? 'section--flush-top' : ''}>
          <div className={`split split--viz${i % 2 ? ' split--flip' : ''}`}>
            <div>
              <SectionHead id={`${id}-title`} label={label} title={title} lead={lead} />
              <ul className="ticks" data-reveal>
                {points.map((p) => (
                  <li key={p}>
                    <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                    {p}
                  </li>
                ))}
              </ul>
              {extra}
            </div>
            <div data-reveal="scale">
              <Viz />
            </div>
          </div>
        </Section>
      ))}

      <Section id="limitations" labelledBy="limitations-title">
        <SectionHead id="limitations-title" label="Honest limits" title={<>Good to know <em>first</em>.</>} center />
        <IconList items={LIMITS.map((l, i) => ({ Icon: LIMIT_ICONS[i], title: l.title, text: l.text }))} columns={2} />
        <p className="more center" data-reveal>
          <Link href="/how-it-works" className="link-arrow">
            See the journey, step by step <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </p>
      </Section>

      <CtaBand />
    </>
  );
}
