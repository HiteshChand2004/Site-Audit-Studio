import CtaBand from '@/components/CtaBand';
import { JsonLd, PageHero, Section } from '@/components/ui';
import { FaqPanel } from '@/components/ui/FaqPanel';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { FAQS } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/faq', 'FAQ', 'Answers to common questions about Remastly: what it does, which sites it can be used on, the technologies, how long it takes, what it can’t rebuild and what is in the Full report.');

export default function Faq() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        }}
      />
      <PageHero
        label="FAQ"
        line1="Questions,"
        line2="answered."
        ghost="FAQ"
        art={
          <HeroArt
            main={<HeroShot src="/shots/botza-original.webp" w={900} h={563} bar="Original: botza.panscience.ai" />}
            overlay={<HeroShot src="/shots/botza-copy.webp" w={900} h={563} bar="Copy" chip={<span className="hchip">Standard mode</span>} />}
          />
        }
      />

      <Section label="Frequently asked questions" size="sm">
        <FaqPanel items={FAQS} name="faq-all" />
      </Section>

      <CtaBand />
    </>
  );
}
