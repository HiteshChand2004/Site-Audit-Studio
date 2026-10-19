import Link from 'next/link';
import { Lightbulb } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import ClockJourney, { type ClockStep } from '@/components/journey/ClockJourney';
import { IconList, JsonLd, PageHero, Section, SectionHead } from '@/components/ui';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  '/how-it-works',
  'How it works',
  'The Remastly journey: paste the address, audit, choose a stack, rebuild, compare with the original, then download and deploy.',
);

/* The journey: in which order things happen. What you get from each part lives on Features. */
const STEPS: ClockStep[] = [
  { title: 'Paste URL', text: 'Any site your company owns or may use. Nothing runs until you start it.' },
  { title: 'Audit', text: 'Every issue found and ranked, in a minute or two (up to six on slow sites).' },
  { title: 'Choose stack', text: 'HTML, React + Vite, Next.js or MERN. Then pick every page, the homepage, or one page.' },
  { title: 'Rebuild', text: 'Every page rebuilt, problems fixed on the way. Stop any time; it resumes where it stopped.' },
  { title: 'Compare', text: 'Original and copy side by side, with a match score for every page, before anything goes live.' },
  { title: 'Download / deploy', text: 'Take the .zip and the report, and publish the site on your own hosting.' },
];

const TIPS = [
  ['Re-audit if the site changed', 'You’re warned when the last audit is over a week old.'],
  ['Start with Plain HTML', 'Simplest and fastest for most sites.'],
  ['Check low match scores first', 'Pages under 80 deserve a look.'],
  ['Keep a laptop plugged in', 'Big sites can take a while; the computer is kept awake.'],
  ['Hand on the “Needs a person” list', 'Logins, shops and forms go to whoever finishes the site.'],
  ['Rebuild from the last visit', 'Try a change without opening the site again.'],
];

export default function HowItWorks() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: 'How to audit and rebuild a website with Remastly',
          step: STEPS.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.title, text: s.text })),
        }}
      />
      <PageHero
        label="How it works"
        title={
          <>
            Six steps. <em>Zero</em> code.
          </>
        }
        lead="From an address to a better site, in order. You paste and choose; Remastly does the rest."
      />

      <Section label="The journey" className="section--flush-top">
        <ClockJourney steps={STEPS} />
      </Section>

      <Section labelledBy="tips-title" tone="tint">
        <SectionHead id="tips-title" label="Good to know" title={<>Tips for the <em>best</em> result.</>} center />
        <IconList items={TIPS.map(([title, text]) => ({ Icon: Lightbulb, title, text }))} layout="cols" columns={3} />
        <p className="more center muted" data-reveal>
          What you get at each step: <Link href="/features" className="link">Features</Link>.
        </p>
      </Section>

      <CtaBand />
    </>
  );
}
