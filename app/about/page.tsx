import { Briefcase, Building2, Code2, Eye, Lock, Megaphone, ScanSearch, UserCheck } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { IconList, PageHero, Section, SectionHead } from '@/components/ui';
import { AUDIENCES } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/about', 'About', 'Why Remastly exists and how it behaves: it never changes your live site, works only on sites you own or may use, and shows every result openly.');

const PRINCIPLES = [
  { Icon: Lock, title: 'Your live site is never changed', text: 'We only visit it. The copy is a separate site you preview and download.' },
  { Icon: UserCheck, title: 'Only sites you own or may use', text: 'Confirmed for every site you add. Not for copying other people’s sites.' },
  { Icon: Eye, title: 'Every result, shown openly', text: 'Better, worse and still open, side by side. Nothing that needs a person is faked.' },
  { Icon: ScanSearch, title: 'Numbers you can check', text: 'Google’s Lighthouse and the same audit on both sites. Examples are labelled as examples.' },
];

const AUDIENCE_ICONS = [Megaphone, Building2, Briefcase, Code2];

export default function About() {
  return (
    <>
      <PageHero
        label="About"
        title={
          <>
            Better websites, <em>honestly</em>.
          </>
        }
        lead="We audit websites, rebuild them better, and show exactly what changed."
      />

      <Section labelledBy="principles-title" className="section--flush-top">
        <SectionHead id="principles-title" label="How it behaves" title={<>Four <em>promises</em>.</>} center />
        <IconList items={PRINCIPLES} columns={2} />
      </Section>

      <Section labelledBy="who-title" tone="tint">
        <SectionHead id="who-title" label="Who it’s for" title={<>For the people who <em>own</em> the site.</>} center />
        <IconList items={AUDIENCES.map((a, i) => ({ Icon: AUDIENCE_ICONS[i], title: a.title, text: a.text }))} layout="cols" columns={4} />
      </Section>

      <CtaBand />
    </>
  );
}
