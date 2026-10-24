import { Check } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { ButtonLink, Card, PageHero, Section, SectionHead } from '@/components/ui';
import { FaqPanel } from '@/components/ui/FaqPanel';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { StackMock } from '@/components/how/Mocks';
import { pricing } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/pricing', 'Pricing', 'Remastly has three plans, Free, Basic and Pro. Every plan includes the full audit, fix, rebuild and report; they differ in how many sites, copies and pages you get.');

const { plans, terms, included, faq, signupOpen, soonLabel } = pricing;
const { billing } = terms;
// Only the policies that have been written down; with none, nothing is shown.
const termsText = [terms.payment, terms.cancellation, terms.downgrade, terms.atLimit].filter(Boolean).join(' ');

export default function Pricing() {
  return (
    <>
      <PageHero
        label="Pricing"
        line1="Same tool,"
        line2="pick your size."
        ghost="Pricing"
        lead="Every plan audits, fixes, rebuilds and reports. The plans differ only in how much you can run."
        art={
          <HeroArt
            main={<HeroShot src="/shots/collateral-features.webp" w={900} h={563} bar="collateral.panscience.ai/features, the copy" chip={<span className="hchip">Exact copy mode</span>} priority />}
            overlay={
              <div className="hpanel">
                <StackMock />
              </div>
            }
          />
        }
      />

      <Section label="Plans" size="sm">
        <div className="plans">
          {plans.map((p, i) => (
            <Card as="article" key={p.id} hover delay={i * 100} className="plan">
              <h2 className="display d3">{p.name}</h2>
              <p className="plan__for">{p.for}</p>
              <p className="plan__price">
                {p.price ? (
                  <>
                    <strong className="display plan__amount">{p.price}</strong> <span className="plan__per">{pricing.period}</span>
                  </>
                ) : (
                  <span className="display plan__soon">Coming soon</span>
                )}
              </p>
              {billing[p.id] && (
                <p className="plan__billing">
                  {billing[p.id]![0]}
                  <br />
                  {billing[p.id]![1]}
                </p>
              )}
              {signupOpen ? (
                <ButtonLink href={p.cta.href} variant={p.id === 'free' ? 'primary' : 'secondary'} block arrow>
                  {p.cta.label}
                </ButtonLink>
              ) : (
                <p className="plan__soonbtn">{soonLabel}</p>
              )}
              <ul className="plan__list">
                {p.items.map((it) => (
                  <li key={it.limit}>
                    <strong>{it.limit}</strong>
                    <span>{it.note}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
        {termsText && (
          <p className="plan__terms" data-reveal>
            {termsText}
          </p>
        )}
      </Section>

      <Section labelledBy="included-title" tone="dark" ghost="Included" size="sm">
        <SectionHead id="included-title" label="In every plan" line1="Everything," line2="for each site." center />
        <div className="included" data-reveal>
          <ul className="ticks ticks--cols">
            {included.map((f) => (
              <li key={f}>
                <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section labelledBy="pfaq-title" tone="soft" size="sm">
        <SectionHead id="pfaq-title" label="Questions" line1="About" line2="the plans." />
        <FaqPanel items={faq} name="plan-faq" />
      </Section>

      <CtaBand
        line1={signupOpen ? 'Not sure' : 'Pick a plan'}
        line2={signupOpen ? 'which one fits?' : 'when sign-up opens.'}
        lead={signupOpen ? 'Tell us how many websites you look after and we’ll help you choose.' : undefined}
        actions={signupOpen ? undefined : <p className="plan__soonbtn plan__soonbtn--lg">{soonLabel}</p>}
      />
    </>
  );
}
