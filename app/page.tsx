import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { WhatItDoes, WhyGrid } from '@/components/home/Bands';
import ExampleRun from '@/components/home/ExampleRun';
import HeroMedia from '@/components/home/HeroMedia';
import LogoStrip from '@/components/home/LogoStrip';
import Platforms from '@/components/home/Platforms';
import StackCards from '@/components/home/StackCards';
import UrlCheck from '@/components/home/UrlCheck';
import { ButtonLink, JsonLd, Section, SectionHead } from '@/components/ui';
import { FaqPanel } from '@/components/ui/FaqPanel';
import { HEADS, HOME_FAQ, PLATFORMS, STACK_CARDS, POSITIONING, pricing, urlCheck } from '@/lib/content';
import { DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';

export default function Home() {
  return (
    <div className="home">
      <JsonLd data={{ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: SITE_NAME, url: SITE_URL, applicationCategory: 'BusinessApplication', description: DESCRIPTION }} />

      {/* 1. Hero (the media slot keeps its fixed 16:9 box) */}
      <section className="xhero section--plain" aria-labelledby="hero-title">
        <div className="xhero__glow" aria-hidden="true" />
        <span className="ghost" aria-hidden="true">
          Rebuild
        </span>
        <div className="container xhero__grid">
          <div className="xhero__text">
            <p className="eyebrow">
              <span aria-hidden="true">//</span>
              {POSITIONING.eyebrow}
            </p>
            <h1 id="hero-title" className="tt xhero__title">
              <span>{POSITIONING.title[0]}</span>
              <span className="tt__2">{POSITIONING.title[1]}</span>
            </h1>
            <p className="lead xhero__lead">{POSITIONING.lead}</p>
            <div className="xhero__ctas">
              <ButtonLink href="#check" arrow>
                {POSITIONING.ctas.primary}
              </ButtonLink>
              <ButtonLink href="#run" variant="secondary">
                {POSITIONING.ctas.secondary}
              </ButtonLink>
            </div>
          </div>
          <HeroMedia />
        </div>
      </section>

      {/* 2. The address check */}
      <Section id="check" labelledBy="check-title" tone="soft" size="sm" ghost="Check">
        <SectionHead id="check-title" label={HEADS.check.eyebrow} line1={HEADS.check.l1} line2={HEADS.check.l2} lead={urlCheck.lead} center />
        <UrlCheck />
      </Section>

      {/* 3. The own-sites strip: what the logos are, and the logos */}
      <LogoStrip />

      {/* 5. Example run */}
      <Section id="run" labelledBy="run-title" tone="soft" ghost="Numbers">
        <SectionHead id="run-title" label={HEADS.example.eyebrow} line1={HEADS.example.l1} line2={HEADS.example.l2} center />
        <ExampleRun />
      </Section>

      {/* 7. What it does */}
      <Section labelledBy="what-title" size="sm">
        <SectionHead id="what-title" label={HEADS.what.eyebrow} line1={HEADS.what.l1} line2={HEADS.what.l2} center />
        <WhatItDoes />
      </Section>

      {/* 9. Why it is different */}
      <Section labelledBy="why-title" tone="dark" ghost="Different">
        <SectionHead id="why-title" label={HEADS.why.eyebrow} line1={HEADS.why.l1} line2={HEADS.why.l2} />
        <WhyGrid />
      </Section>

      {/* 10. Input platforms */}
      <Section labelledBy="platforms-title" size="sm">
        <SectionHead id="platforms-title" label={HEADS.platforms.eyebrow} line1={HEADS.platforms.l1} line2={HEADS.platforms.l2} lead={PLATFORMS.lead} center />
        <Platforms />
      </Section>

      {/* 11. Output stacks */}
      <Section labelledBy="stacks-title" tone="soft" size="sm">
        <SectionHead id="stacks-title" label={HEADS.stacks.eyebrow} line1={HEADS.stacks.l1} line2={HEADS.stacks.l2} lead={STACK_CARDS.lead} center />
        <StackCards />
      </Section>

      {/* Pricing teaser */}
      <Section labelledBy="price-title" size="sm">
        <SectionHead
          id="price-title"
          label="Pricing"
          line1="Same engine,"
          line2="pick your size."
          center
          action={undefined}
        />
        <div className="pteaser" data-stagger>
          {pricing.plans.map((p) => (
            <article key={p.id} className="card pteaser__plan">
              <h3 className="display d3">{p.name}</h3>
              <p className="pteaser__price">
                <strong>{p.price}</strong> <span>{pricing.period}</span>
              </p>
              <ul>
                {p.items.slice(0, 3).map((it) => (
                  <li key={it.limit}>
                    <Check size={15} aria-hidden="true" /> {it.limit}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className="more pteaser__more">
          <Link href="/pricing" className="link-arrow">
            Compare the plans <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </p>
      </Section>

      {/* 12. FAQ */}
      <Section labelledBy="faq-title" tone="tint" size="sm" ghost="Questions">
        <SectionHead id="faq-title" label={HEADS.faq.eyebrow} line1={HEADS.faq.l1} line2={HEADS.faq.l2} />
        <FaqPanel items={HOME_FAQ} name="home-faq" />
      </Section>

      {/* 13. Footer CTA band */}
      <CtaBand />
    </div>
  );
}
