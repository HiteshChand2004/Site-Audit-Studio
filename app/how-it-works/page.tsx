import Link from 'next/link';
import CtaBand from '@/components/CtaBand';
import Journey, { type JourneyStep } from '@/components/how/Journey';
import { AddressMock, AuditMock, CompareMock, CopyMock, StackMock, ZipMock } from '@/components/how/Mocks';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { JsonLd, PageHero, Section, SectionHead } from '@/components/ui';
import { PIPELINE } from '@/lib/content';
import { pageMeta } from '@/lib/meta';
import '@/app/tour.css';

export const metadata = pageMeta(
  '/how-it-works',
  'How it works',
  'The Remastly journey: paste the address, audit, choose a stack, rebuild, compare with the original, then download and deploy.',
);

/* The journey: in which order things happen, each with a drawing of the app at that step. What you get lives on Features. */
const STEPS: JourneyStep[] = [
  { id: 'paste', title: 'Paste the address', text: 'Any site your company owns or may use. Nothing runs until you start it.', screen: 'Add a website', visual: <AddressMock /> },
  { id: 'audit', title: 'Audit', text: 'Every issue found and ranked, in about a minute (six at most).', screen: 'Check', visual: <AuditMock /> },
  { id: 'stack', title: 'Choose the stack', text: 'HTML, React + Vite, Next.js or MERN. Then every page, the homepage, or one page.', screen: 'Copy', visual: <StackMock /> },
  { id: 'copy', title: 'Copy and fix', text: 'Every page kept as it is, problems fixed on the way. Stop any time; it resumes where it stopped.', screen: 'Copy', visual: <CopyMock /> },
  { id: 'measure', title: 'Measure', text: 'Original and copy compared on every page, and the audit run again on the copy.', screen: 'Compare', visual: <CompareMock /> },
  { id: 'download', title: 'Download and deploy', text: 'Take the .zip and the report, and publish the site on your own hosting.', screen: 'Results and download', visual: <ZipMock /> },
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
        line1="Six steps from"
        line2="address to copy."
        ghost="Steps"
        lead="Paste an address at the start, download a .zip at the end. Pick a step below to see that part of the app."
        art={<HeroArt main={<HeroShot src="/tool/h-add.webp" w={960} h={864} trim priority />} overlay={<ZipMock />} />}
      />

      <Section label="The journey" tone="soft" size="sm">
        <Journey steps={STEPS} />
      </Section>

      <Section labelledBy="inside-title" tone="dark" ghost="Inside" size="sm">
        <SectionHead id="inside-title" label="Inside a run" line1="What happens to" line2="each page." center />
        <ol className="runline">
          {PIPELINE.map((s) => (
            <li key={s.key}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section labelledBy="tips-title" size="sm">
        <SectionHead id="tips-title" label="Good to know" line1="Small habits" line2="for better results." />
        <dl className="tips">
          {TIPS.map(([title, text]) => (
            <div key={title}>
              <dt>{title}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <p className="tips__more muted">
          What you get at each step: <Link href="/features" className="link">Features</Link>.
        </p>
      </Section>

      <CtaBand />
    </>
  );
}
