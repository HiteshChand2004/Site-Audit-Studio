import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { PageHero, Section } from '@/components/ui';

/** Shared layout for the legal pages: a short hero, a draft notice and readable prose. */
export default function LegalPage({ label, title, updated, children }: { label: string; title: ReactNode; updated: string; children: ReactNode }) {
  return (
    <>
      <PageHero label={label} title={title} lead={`Last updated: ${updated}`} />
      <Section label={label} className="section--flush-top">
        <div className="narrow">
          <p className="draft-note">
            <Info size={16} aria-hidden="true" />
            Draft for review. Text in [brackets] still needs to be completed before launch.
          </p>
          <div className="prose">{children}</div>
        </div>
      </Section>
    </>
  );
}
