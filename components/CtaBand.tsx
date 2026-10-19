import type { ReactNode } from 'react';
import { ButtonLink, Section } from '@/components/ui';

/** Closing call to action of the inner pages. */
export default function CtaBand({
  title = (
    <>
      Paste your <em>address</em>.
    </>
  ),
  lead = 'We’ll do the rest.',
}: {
  title?: ReactNode;
  lead?: string;
}) {
  return (
    <Section labelledBy="cta-title" size="sm">
      <div className="cta-final" data-reveal="scale">
        <h2 id="cta-title" className="display d2">
          {title}
        </h2>
        <p className="lead">{lead}</p>
        <div className="cta-final__actions">
          <ButtonLink href="/auth?mode=signup" size="lg" arrow>
            Get started
          </ButtonLink>
          <ButtonLink href="/contact" variant="secondary" size="lg">
            Talk to us
          </ButtonLink>
        </div>
      </div>
    </Section>
  );
}
