import Link from 'next/link';
import { Check, Mail } from 'lucide-react';
import ContactForm from '@/components/ContactForm';
import { PageHero, Section } from '@/components/ui';
import { CONTACT_EMAIL } from '@/lib/site';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/contact', 'Contact', 'Contact the Remastly team about plans, a demo or a website you want to check and rebuild.');

const HELPFUL = ['The website you want to rebuild, and that it’s yours (or you may use it)', 'How many websites you look after', 'The technology your team uses, if any', 'Which pages matter most to you', 'When you’d like the new site live'];

export default function Contact() {
  return (
    <>
      <PageHero
        label="Contact"
        title={
          <>
            Talk to <em>us</em>.
          </>
        }
        lead="Questions about plans, a demo, or a website you want to rebuild? We’ll get back to you."
      />

      <Section label="Contact details and form" className="section--flush-top">
        <div className="contact">
          <div className="contact__side" data-reveal>
            <div className="contact__mail">
              <span className="olist__ico" aria-hidden="true">
                <Mail size={20} />
              </span>
              <h2 className="h3">Email</h2>
              <a href={`mailto:${CONTACT_EMAIL}`} className="link contact__email">
                {CONTACT_EMAIL}
              </a>
            </div>
            <h2 className="h3 contact__h2">Helpful to include</h2>
            <ul className="ticks">
              {HELPFUL.map((h) => (
                <li key={h}>
                  <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                  {h}
                </li>
              ))}
            </ul>
            <p className="more muted">
              Quick answers are in the{' '}
              <Link href="/faq" className="link">
                FAQ
              </Link>
              .
            </p>
          </div>
          <div data-reveal style={{ ['--d' as string]: '100ms' }}>
            <ContactForm />
          </div>
        </div>
      </Section>
    </>
  );
}
