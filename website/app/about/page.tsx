import { Briefcase, Building2, Code2, Eye, Lock, Megaphone, ScanSearch, UserCheck } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { IconList, PageHero, Section, SectionHead } from '@/components/ui';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { AUDIENCES } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/about', 'About', 'Why Remastly exists and how it behaves: it never changes your live site, works only on sites you own or may use, and shows every result openly.');

const PRINCIPLES = [
  { Icon: Lock, title: 'Your live site is never changed', text: 'We only visit it. The copy is a separate site you preview and download.' },
  { Icon: UserCheck, title: 'Only sites you own or may use', text: 'Confirmed for every site you add. Not for copying other people’s sites.' },
  { Icon: Eye, title: 'Every result, shown openly', text: 'Better, worse and still open, side by side. Nothing that needs a person is faked.' },
  { Icon: ScanSearch, title: 'Numbers you can check', text: 'Pixel differences, Google’s Lighthouse and the same audit on both sites. Every figure names its run and its mode.' },
];

const AUDIENCE_ICONS = [Megaphone, Building2, Briefcase, Code2];

export default function About() {
  return (
    <>
      <PageHero
        label="About"
        line1="Better websites,"
        line2="honestly."
        ghost="About"
        art={
          <HeroArt
            main={
              <div className="hfan">
                <HeroShot src="/shots/botza-copy.webp" w={900} h={563} bar="botza.panscience.ai" priority />
                <HeroShot src="/shots/panscience-copy.webp" w={900} h={563} bar="panscience.xyz" />
                <HeroShot src="/shots/indikaai-mid.webp" w={900} h={563} bar="indikaai.com" />
              </div>
            }
          />
        }
      />

      <Section labelledBy="principles-title" size="sm">
        <div className="split split--flip">
          <div>
            <SectionHead id="principles-title" label="How it behaves" line1="Four promises," line2="kept in the open." />
            <IconList items={PRINCIPLES} columns={1} />
          </div>
          <div data-reveal>
            <HeroArt
              className="about-art"
              main={<HeroShot src="/shots/collateral-original.webp" w={1000} h={625} bar="collateral.panscience.ai, the live site" chip={<span className="hchip">Never changed</span>} />}
              overlay={<HeroShot src="/shots/collateral-copy.webp" w={1000} h={625} bar="The copy, a separate site" chip={<span className="hchip">Exact copy mode</span>} />}
            />
          </div>
        </div>
      </Section>

      <Section labelledBy="who-title" tone="soft" size="sm">
        <SectionHead id="who-title" label="Who it’s for" line1="For the people who" line2="own the site." center />
        <IconList items={AUDIENCES.map((a, i) => ({ Icon: AUDIENCE_ICONS[i], title: a.title, text: a.text }))} layout="cols" columns={4} />
      </Section>

      <CtaBand />
    </>
  );
}
