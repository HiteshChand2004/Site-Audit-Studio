import { Check, FileDown, FileJson, FileText, RefreshCw } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import AuditReport, { AUDIT_CHECKS } from '@/components/mockups/AuditReport';
import { ReportPagesMock } from '@/components/mockups/ProductMocks';
import { IconList, PageHero, Section, SectionHead } from '@/components/ui';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  '/report',
  'Audit report',
  'The Remastly audit report: performance, SEO, accessibility, best practices, broken links and console errors for your site, every issue marked fixed in your copy or flagged for you, and a before/after report as PDF, HTML or JSON.',
);

const INSIDE = [
  {
    label: 'The audit',
    title: 'What’s wrong',
    points: ['Six categories, one status each', 'Every issue, ranked by severity', 'Why each one matters', 'Broken links and the platform behind the site'],
  },
  {
    label: 'The fix',
    title: 'What we did',
    points: ['Fixed in your copy', 'Flagged for you', 'Same checks, run on the copy', 'Anything that got worse, listed too'],
  },
  {
    label: 'Before / after',
    title: 'What changed',
    points: ['Scores, original vs copy', 'Phone and computer', 'Speed against Google’s targets', 'Match score per page'],
  },
];

const FORMATS = [
  { Icon: FileDown, title: 'PDF', text: 'Email it or print it.' },
  { Icon: FileText, title: 'HTML', text: 'One file, opens anywhere.' },
  { Icon: FileJson, title: 'JSON', text: 'Every check and value.' },
  { Icon: RefreshCw, title: 'Regenerate', text: 'After any new run.' },
];

export default function ReportPage() {
  return (
    <>
      <PageHero
        label="Audit report"
        line1="Your audit,"
        line2="in one report."
        ghost="Report"
        art={
          <HeroArt
            main={<HeroShot src="/tool/f-needs.webp" w={1400} h={409} bar="Audit report" zoom={1.6} height={230} priority />}
            overlay={<HeroShot src="/tool/f-overview.webp" w={1400} h={250} zoom={1.9} height={118} />}
          />
        }
      />

      <Section labelledBy="audit-title" size="sm">
        <div className="split split--viz">
          <div>
            <SectionHead id="audit-title" label="The audit" line1="Ranked," line2="then resolved." />
            <div className="cat-strip" data-reveal>
              {AUDIT_CHECKS.map(({ Icon, name }) => (
                <span key={name} className="kf__chip">
                  <Icon size={15} aria-hidden="true" /> {name}
                </span>
              ))}
            </div>
          </div>
          <div data-reveal="scale">
            <AuditReport />
          </div>
        </div>
      </Section>

      <Section labelledBy="inside-title" tone="dark" ghost="Inside" size="sm">
        <SectionHead id="inside-title" label="What’s inside" line1="Found. Fixed." line2="Flagged." center />
        <div className="ocols ocols--3" data-reveal>
          {INSIDE.map((b) => (
            <div key={b.title}>
              <p className="label">{b.label}</p>
              <h3 className="display d3 card-title">{b.title}</h3>
              <ul className="ticks">
                {b.points.map((p) => (
                  <li key={p}>
                    <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section labelledBy="share-title" size="sm">
        <div className="split split--viz split--flip">
          <div>
            <SectionHead id="share-title" label="Share it" line1="Two pages," line2="any format." />
            <IconList items={FORMATS} columns={2} className="formats" />
          </div>
          <div data-reveal="scale">
            <ReportPagesMock />
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
