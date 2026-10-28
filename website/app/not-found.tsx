import { ButtonLink, PageHero } from '@/components/ui';

export const metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <PageHero label="404" line1="Page" line2="not found." ghost="404" lead="It may have moved. Start again from the home page.">
      <div className="cta2__actions">
        <ButtonLink href="/" arrow>
          Go to the home page
        </ButtonLink>
        <ButtonLink href="/contact" variant="secondary">
          Contact us
        </ButtonLink>
      </div>
    </PageHero>
  );
}
