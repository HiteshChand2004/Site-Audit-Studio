import Link from 'next/link';
import LegalPage from '@/components/LegalPage';
import { CONTACT_EMAIL } from '@/lib/site';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/terms', 'Terms', 'The terms for using Remastly.');

export default function Terms() {
  return (
    <LegalPage
      label="Legal"
      title={
        <>
          Terms of <em>use</em>.
        </>
      }
      updated="[DATE]"
    >
      <h2>Agreement</h2>
      <p>These terms apply when you use Remastly, provided by [COMPANY LEGAL NAME]. By creating an account you agree to them.</p>

      <h2>Websites you add</h2>
      <p>
        Only add websites that your company owns, or that you have permission to check and rebuild. You confirm this each time you add a website. Remastly is not for copying other
        people’s sites.
      </p>

      <h2>What Remastly does</h2>
      <ul>
        <li>It visits the websites you add as a visitor would, and never changes the original website.</li>
        <li>It builds a separate copy that you preview privately and download.</li>
        <li>
          Some parts cannot be rebuilt automatically, such as logins, shops and form backends. These are listed as “Needs a person”. See the{' '}
          <Link href="/features#limitations">limitations</Link>.
        </li>
        <li>Results vary by site. Each run lists what got better, what still needs work and what got worse.</li>
      </ul>

      <h2>Your content</h2>
      <p>The websites, copies and reports remain yours, or your client’s. [LICENCE NEEDED TO PROVIDE THE SERVICE.]</p>

      <h2>Acceptable use</h2>
      <p>Do not use Remastly to get around bot protection, access areas you are not allowed to, or break the law. [FURTHER RULES.]</p>

      <h2>Plans and payment</h2>
      <p>
        [PLAN, BILLING AND CANCELLATION TERMS.] Current plans are on the <Link href="/pricing">pricing page</Link>.
      </p>

      <h2>Liability</h2>
      <p>[WARRANTY DISCLAIMER AND LIMITATION OF LIABILITY.]</p>

      <h2>Changes and contact</h2>
      <p>
        When these terms change, we update the date at the top of this page. Questions: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. [GOVERNING LAW.]
      </p>
    </LegalPage>
  );
}
