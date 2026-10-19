import Link from 'next/link';
import CtaBand from '@/components/CtaBand';
import { FaqList, JsonLd, PageHero, Section } from '@/components/ui';
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
        title={
          <>
            Questions, <em>answered</em>.
          </>
        }
        lead="Including the ones about what Remastly can’t do."
      />

      <Section label="Frequently asked questions" className="section--flush-top">
        <div className="narrow" data-reveal>
          <FaqList items={FAQS} openFirst />
          <p className="more center muted">
            Didn’t find your answer?{' '}
            <Link href="/contact" className="link">
              Ask us directly
            </Link>
            .
          </p>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
