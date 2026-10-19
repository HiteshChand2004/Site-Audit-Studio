import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import HeroStage from '@/components/hero/HeroStage';
import AuditStory from '@/components/home/AuditStory';
import CompareWipe from '@/components/home/CompareWipe';
import ExampleRun from '@/components/home/ExampleRun';
import StackTabs from '@/components/home/StackTabs';
import { Button, ButtonLink, FaqList, JsonLd, Section, SectionHead } from '@/components/ui';
import { DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';

const QUICK_FAQ = [
  { q: 'Does it change my live site?', a: 'Never. You get a separate copy to preview and download.' },
  { q: 'What does the audit check?', a: 'Performance, SEO, accessibility, best practices, broken links and console errors.' },
  { q: 'Does it fix everything?', a: 'No. Anything it can’t fix is flagged for you.' },
  { q: 'Which sites can I use?', a: 'Sites your company owns, or may use.' },
  { q: 'How long does it take?', a: 'An audit takes a minute or two; a copy can take several minutes per page.' },
  { q: 'Can I choose the pages?', a: 'Yes: every page, the homepage only, or just one page.' },
];

export default function Home() {
  return (
    <div className="home">
      <JsonLd data={{ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: SITE_NAME, url: SITE_URL, applicationCategory: 'BusinessApplication', description: DESCRIPTION }} />

      {/* Hero: the one 3D moment of the site */}
      <section className="xhero" aria-labelledby="hero-title">
        <div className="xhero__glow" aria-hidden="true" />
        <div className="container xhero__inner">
          <h1 id="hero-title" className="display d1 xhero__title">
            Paste a link. Get a <em>better</em> site.
          </h1>
          <p className="lead xhero__lead">We audit it, fix what we find, and rebuild it in your stack. Your live site is never touched.</p>
          <div className="xhero__ctas">
            <ButtonLink href="/auth?mode=signup" arrow>
              Get started
            </ButtonLink>
            <ButtonLink href="#audit" variant="secondary">
              See the audit
            </ButtonLink>
          </div>
          <HeroStage />
        </div>
      </section>

      {/* Audit → Fix → Rebuild: a scroll-driven story */}
      <Section id="audit" labelledBy="audit-title" className="section--story">
        <AuditStory head={<SectionHead id="audit-title" label="Audit → Fix → Rebuild" title={<>First, an honest <em>audit</em>.</>} lead="Six checks, every issue ranked. Then fixed in your copy, or flagged for you." center />} />
      </Section>

      {/* Before / after: one compact wipe card */}
      <Section labelledBy="compare-title" tone="tint">
        <SectionHead id="compare-title" label="Before / after" title={<>Same look. Fewer <em>problems</em>.</>} lead="Same layout, same content, fewer problems underneath. Watch it wipe, then drag." center />
        <CompareWipe />
      </Section>

      {/* Four stacks */}
      <Section labelledBy="stacks-title">
        <SectionHead id="stacks-title" label="Four stacks" title={<>Your stack. Your <em>call</em>.</>} lead="The same site, in the code your team already uses. One .zip, ready to host." center />
        <StackTabs />
      </Section>

      {/* Example run (real numbers only) */}
      <Section labelledBy="run-title" tone="tint">
        <SectionHead id="run-title" label="Example run" title={<>Real run. Real <em>numbers</em>.</>} lead="One real site, audited and rebuilt. Nothing rounded up." center />
        <ExampleRun />
      </Section>

      {/* FAQ */}
      <Section labelledBy="faq-title">
        <div className="faq-split">
          <SectionHead id="faq-title" label="FAQ" title={<>Quick <em>answers</em>.</>}>
            <p className="more">
              <Link href="/faq" className="link-arrow">
                All questions <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </p>
          </SectionHead>
          <div data-reveal>
            <FaqList items={QUICK_FAQ} />
          </div>
        </div>
      </Section>

      {/* Final call to action */}
      <Section labelledBy="cta-title" size="sm">
        <div className="cta-final" data-reveal="scale">
          <h2 id="cta-title" className="display d2">
            Paste your <em>address</em>.
          </h2>
          <p className="lead">We’ll do the rest: audit, fix, rebuild and report.</p>
          <form className="cta-form" action="/auth" method="get">
            <input type="hidden" name="mode" value="signup" />
            <label htmlFor="cta-url" className="visually-hidden">
              Your website address
            </label>
            <input id="cta-url" name="site" type="url" inputMode="url" autoComplete="url" placeholder="https://yoursite.com" required />
            <Button type="submit" arrow>
              Start
            </Button>
          </form>
          <p className="cta-final__note">For sites your company owns or may use.</p>
        </div>
      </Section>
    </div>
  );
}
