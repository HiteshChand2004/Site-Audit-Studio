import { Check } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { Badge, ButtonLink, Card, FaqList, PageHero, Section, SectionHead } from '@/components/ui';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/pricing', 'Pricing', 'Remastly plans for one website (Starter), a company with several websites (Team) and agencies working on client sites (Agency). Prices are coming soon.');

// Prices are not decided yet: every plan says "Coming soon" and leads to the contact page. Never invent a price here.
const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    for: 'For one company website.',
    features: ['Audit, fix, rebuild, compare', 'HTML, React + Vite, Next.js, MERN', 'Every page, or just one', 'Private preview before download', 'Report as PDF, HTML, JSON'],
  },
  {
    id: 'team',
    name: 'Team',
    for: 'For a company with several websites.',
    features: ['Everything in Starter', 'All company sites in one place', 'Each site’s health at a glance', 'See which site needs attention first'],
  },
  {
    id: 'agency',
    name: 'Agency',
    for: 'For agencies working on client sites, with permission.',
    features: ['Everything in Team', 'A report for every client', 'Any stack the client uses', 'A “Needs a person” list', 'Client sites with their permission'],
  },
];

const INCLUDED = [
  'Audit: performance, SEO, accessibility',
  'Best practices and console errors',
  'Broken links and platform detection',
  'Clean copy in four stacks',
  'Side-by-side compare',
  'Report as PDF, HTML and JSON',
  'Readiness for AI answers',
  'Private preview, nothing published',
];

const PRICING_FAQ = [
  { q: 'Which plan should I choose?', a: 'Starter if you look after one website, Team if your company has several, and Agency if you work on client sites with their permission.' },
  { q: 'When will prices be published?', a: 'Prices are being finalised. Contact us and we’ll tell you as soon as they are set, and help you pick the right plan.' },
  { q: 'Do I need a developer?', a: 'No. Paste an address and download the result. A developer helps if you pick React, Next.js or MERN, or for the parts that need a person.' },
  { q: 'Is everything included in every plan?', a: 'Yes. Every plan includes the audit, the copy and the report. Plans differ only in the number of websites.' },
];

export default function Pricing() {
  return (
    <>
      <PageHero
        label="Pricing"
        title={
          <>
            Plans for every <em>size</em>.
          </>
        }
        lead="Every plan: audit, fix, rebuild and report. Pick by number of sites."
      />

      <Section label="Plans" className="section--flush-top">
        <div className="plans">
          {PLANS.map((p, i) => (
            <Card as="article" key={p.id} hover delay={i * 100} className="plan">
              <h2 className="display d3">{p.name}</h2>
              <p className="plan__for">{p.for}</p>
              <p className="plan__price">
                <Badge tone="accent">Price coming soon</Badge>
              </p>
              <ul className="ticks">
                {p.features.map((f) => (
                  <li key={f}>
                    <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                    {f}
                  </li>
                ))}
              </ul>
              <ButtonLink href={`/contact?plan=${p.id}`} variant={i === 1 ? 'primary' : 'secondary'} block arrow>
                Contact us
              </ButtonLink>
            </Card>
          ))}
        </div>
      </Section>

      <Section labelledBy="included-title" tone="tint">
        <SectionHead id="included-title" label="In every plan" title={<>Everything, for <em>each</em> site.</>} center />
        <div className="included" data-reveal>
          <ul className="ticks ticks--cols">
            {INCLUDED.map((f) => (
              <li key={f}>
                <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section labelledBy="pfaq-title">
        <div className="faq-split">
          <SectionHead id="pfaq-title" label="Questions" title={<>About the <em>plans</em>.</>} />
          <div data-reveal>
            <FaqList items={PRICING_FAQ} />
          </div>
        </div>
      </Section>

      <CtaBand title={<>Not sure which <em>fits</em>?</>} lead="Tell us how many websites you look after and we’ll help you choose." />
    </>
  );
}
