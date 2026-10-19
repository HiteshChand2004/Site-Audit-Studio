import { ButtonLink } from '@/components/ui';

export const metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <section className="phero not-found">
      <div className="phero__glow" aria-hidden="true" />
      <div className="container phero__inner">
        <p className="label">404</p>
        <h1 className="display d1 phero__title">
          Page not <em>found</em>.
        </h1>
        <p className="lead phero__lead">It may have moved. Start again from the home page.</p>
        <div className="cta-final__actions">
          <ButtonLink href="/" arrow>
            Go to the home page
          </ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Contact us
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
