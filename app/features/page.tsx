import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Eye, Globe, Hand, Scale, ServerCog, ShieldAlert, Timer, UserCheck } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { AuditMock, CompareMock, FixMock, KeptMock, PreviewMock, ReportMock, StackMock, ZipMock } from '@/components/how/Mocks';
import { ButtonLink, Eyebrow, IconList, Section, SectionHead, TwoTone } from '@/components/ui';
import { ToolShot } from '@/components/ui/ToolShot';
import { LIMITS, TOUR } from '@/lib/content';
import { pageMeta } from '@/lib/meta';
import '@/app/tour.css';

export const metadata = pageMeta(
  '/features',
  'Features',
  'What you get with Remastly: an audit of performance, SEO, accessibility, best practices, broken links and console errors; common problems fixed; four stacks; a side-by-side compare view; a download; and a shareable report.',
);

const LIMIT_ICONS = [UserCheck, Hand, Eye, Scale, ShieldAlert, Timer, ServerCog, Globe];

/* What you get, by capability, each with a small drawing of that part of the app. All cards are the same size; the ninth
   cell is the call to action. The journey lives on How it works. */
const CAPABILITIES: { id: string; title: string; text: string; visual: ReactNode }[] = [
  { id: 'audit', title: 'Every issue found and ranked', text: 'Speed, SEO, accessibility, best practices, broken links and console errors, in plain words.', visual: <AuditMock rows={4} /> },
  { id: 'fidelity', title: 'Kept as it is, then measured', text: 'The page is carried over, not re-drawn, then compared with the original.', visual: <KeptMock /> },
  { id: 'fixed', title: 'Common problems fixed', text: 'Safe fixes are made on the way. Anything else stays on the list, with the reason.', visual: <FixMock /> },
  { id: 'stacks', title: 'Four stacks to choose from', text: TOUR.stacksCard, visual: <StackMock /> },
  { id: 'compare', title: 'Original and copy, side by side', text: 'Every page on computer, tablet and phone, scrolling together.', visual: <CompareMock /> },
  { id: 'report', title: 'A report you can share', text: 'What was fixed and what is still open, as PDF, HTML or JSON.', visual: <ReportMock /> },
  { id: 'download', title: 'The whole project in one .zip', text: 'Every page and asset, plus DEPLOY.md with the steps to publish it.', visual: <ZipMock /> },
  { id: 'preview', title: 'A private preview first', text: 'Look through the copy before you download it. Nothing is published.', visual: <PreviewMock /> },
];

export default function Features() {
  return (
    <>
      <section className="fx-hero" aria-labelledby="fx-title">
        <span className="ghost" aria-hidden="true">
          Features
        </span>
        <div className="container fx-hero__grid">
          <div className="fx-hero__text">
            <Eyebrow>What you get</Eyebrow>
            <TwoTone as="h1" id="fx-title" line1="Everything in" line2="one measured run." className="fx-hero__title" />
            <p className="lead fx-hero__lead">Audit, fix, copy, compare and download. Everything Remastly does for a site you add happens in one run.</p>
            <div className="fx-hero__ctas">
              <ButtonLink href="/#check" arrow>
                Check my site
              </ButtonLink>
              <ButtonLink href="/how-it-works" variant="secondary">
                How it works
              </ButtonLink>
            </div>
          </div>
          <div className="fx-hero__art">
            <span className="fx-hero__glow" aria-hidden="true" />
            <ToolShot src="/tool/f-glance.webp" w={1000} h={933} alt="The audit summary in the app: five round scores, speed 62, found on Google 100, easy for everyone 100, safe and modern 100, ready for AI answers 93." className="fx-hero__shot" maxWidth={440} priority />
            <ToolShot src="/tool/f-speed.webp" w={1000} h={443} alt="Speed in everyday words in the app: main content shows in 3.2 seconds, ready to use in 4.2 seconds, page freezes for 1.2 seconds, page weight 673 KB." className="fx-hero__shot2" maxWidth={340} priority />
          </div>
        </div>
      </section>

      <Section labelledBy="caps-title" tone="soft" size="sm">
        <SectionHead id="caps-title" label="Capabilities" line1="Eight things," line2="in every run." center />
        <ul className="fx-bento">
          {CAPABILITIES.map(({ id, title, text, visual }) => (
            <li key={id} id={id} className="fx-card">
              <div className="fx-card__vis" aria-hidden="true">
                {visual}
              </div>
              <div className="fx-card__body">
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </li>
          ))}
          <li className="fx-card fx-card--cta">
            <div className="fx-card__body">
              <h3>Try it on your own site</h3>
              <p>{TOUR.tryIt}</p>
              <ButtonLink href="/#check" arrow>
                Check my site
              </ButtonLink>
            </div>
          </li>
        </ul>
        <p className="fx-more">
          <Link href="/report" className="link-arrow">
            See what is inside the report <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </p>
      </Section>

      <Section id="limitations" labelledBy="limitations-title" tone="dark" ghost="Limits" size="sm">
        <SectionHead id="limitations-title" label="Honest limits" line1="Good to know" line2="before you start." center />
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
