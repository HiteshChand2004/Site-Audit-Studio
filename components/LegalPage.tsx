import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { PageHero, Section } from '@/components/ui';

/** Shared layout for the legal pages: a short hero, a draft notice and readable prose. */
export default function LegalPage({ label, line1, line2, updated, children }: { label: string; line1: ReactNode; line2: ReactNode; updated: string; children: ReactNode }) {
  return (
    <>
      <PageHero label={label} line1={line1} line2={line2} lead={`Last updated: ${updated}`} />
      <Section label={label} size="sm">
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
