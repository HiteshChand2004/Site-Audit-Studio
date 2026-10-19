import Link from 'next/link';
import LegalPage from '@/components/LegalPage';
import { CONTACT_EMAIL } from '@/lib/site';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/privacy', 'Privacy', 'How Remastly handles personal data on this website and in the product.');

export default function Privacy() {
  return (
    <LegalPage
      label="Legal"
      title={
        <>
          Privacy <em>policy</em>.
        </>
      }
      updated="[DATE]"
    >
      <h2>Who we are</h2>
      <p>
        Remastly is provided by [COMPANY LEGAL NAME], [REGISTERED ADDRESS]. For anything about your data, write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>This website</h2>
      <p>This marketing website does not use analytics or advertising cookies, and it does not ask you to create an account to read it.</p>
      <ul>
        <li>
          The <Link href="/contact">contact form</Link> opens your own email app. We receive only what you choose to send.
        </li>
        <li>The sign-in and sign-up forms send your details to the Remastly app, when it is available. They are not stored by this website.</li>
        <li>Our hosting provider may keep standard server logs, such as IP addresses and request times: [HOSTING PROVIDER, RETENTION PERIOD].</li>
      </ul>

      <h2>The Remastly product</h2>
      <p>When you use Remastly, we process:</p>
      <ul>
        <li>Your account details, such as your name and email address.</li>
        <li>The addresses of the websites you add, and what Remastly finds when it visits them: pages, images, files and check results.</li>
        <li>[OTHER DATA, E.G. BILLING DETAILS, IF APPLICABLE]</li>
      </ul>
      <p>Remastly only visits the websites you add, as a visitor would. It never changes the original website.</p>

      <h2>Why we use it</h2>
      <p>To provide the service you asked for: checking websites, building the copy, comparing the two and producing the report. [LEGAL BASIS, E.G. CONTRACT AND LEGITIMATE INTEREST.]</p>

      <h2>How long we keep it</h2>
      <p>[RETENTION PERIODS FOR ACCOUNTS, WEBSITE DATA AND REPORTS.]</p>

      <h2>Who we share it with</h2>
      <p>We do not sell personal data. We use these service providers: [LIST OF PROCESSORS, E.G. HOSTING, EMAIL].</p>

      <h2>Your rights</h2>
      <p>
        You can ask to see, correct, export or delete your personal data, or object to how it is used, by writing to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. [SUPERVISORY
        AUTHORITY, IF APPLICABLE.]
      </p>

      <h2>Changes</h2>
      <p>When this policy changes, we update the date at the top of this page.</p>
    </LegalPage>
  );
}
