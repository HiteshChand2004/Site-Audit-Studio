import type { ReactNode } from 'react';
import { ButtonLink, Eyebrow, TwoTone } from '@/components/ui';
import { FOOTER_CTA, HEADS } from '@/lib/content';

/**
 * The closing band of every page: dark, edge to edge, an eyebrow, a two-tone heading and two pill buttons.
 */
export default function CtaBand({
  eyebrow = HEADS.cta.eyebrow,
  line1 = HEADS.cta.l1,
  line2 = HEADS.cta.l2,
  lead,
  actions,
}: {
  eyebrow?: string;
  line1?: ReactNode;
  line2?: ReactNode;
  lead?: string;
  /** Replaces the two buttons (used while sign-up is not open). */
  actions?: ReactNode;
}) {
  return (
    <section className="section section--dark section--sm cta2" aria-labelledby="cta-title">
      <span className="ghost" aria-hidden="true">
        Remastly
      </span>
      <div className="container">
        <div className="cta2__text" data-reveal>
          <Eyebrow>{eyebrow}</Eyebrow>
          <TwoTone id="cta-title" line1={line1} line2={line2} size="xl" />
          {lead && <p className="lead">{lead}</p>}
          <div className="cta2__actions">
            {actions ?? (
              <>
                <ButtonLink href="/#check" size="lg" arrow>
                  {FOOTER_CTA.primary}
                </ButtonLink>
                <ButtonLink href="/pricing" variant="secondary" size="lg">
                  {FOOTER_CTA.secondary}
                </ButtonLink>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
