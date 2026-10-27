import Link from 'next/link';
import { Check, Mail, MessageSquare } from 'lucide-react';
import ContactForm from '@/components/ContactForm';
import { PageHero, Section } from '@/components/ui';
import { HeroArt, HeroShot } from '@/components/ui/HeroArt';
import { CONTACT_EMAIL } from '@/lib/site';
import { pageMeta } from '@/lib/meta';
import '@/app/contact.css';

export const metadata = pageMeta('/contact', 'Contact', 'Contact the Remastly team about plans, a demo or a website you want to check and rebuild.');

const HELPFUL = ['The website you want to rebuild, and that it’s yours (or you may use it)', 'How many websites you look after', 'The technology your team uses, if any', 'Which pages matter most to you'];

export default function Contact() {
  return (
    <>
      <PageHero
        label="Contact"
        line1="Talk to us"
        line2="about your site."
        ghost="Contact"
        lead="Questions about plans, a demo, or a website you want to rebuild? Send us a message."
        art={
          <HeroArt
            main={<HeroShot src="/shots/panscience-copy.webp" w={900} h={563} bar="panscience.xyz" priority />}
            overlay={
              <div className="ct-note">
                <span className="ct-note__ico" aria-hidden="true">
                  <MessageSquare size={18} />
                </span>
                <span>
                  <b>New message</b>
                  <small>Website: https://yoursite.com</small>
                  <small>Plan: Not sure yet</small>
                </span>
              </div>
            }
          />
        }
      />

      <Section label="Contact form" size="sm">
        <div className="ct">
          <aside className="ct__side">
            {CONTACT_EMAIL && (
              <div className="ct__block">
                <span className="ct__ico" aria-hidden="true">
                  <Mail size={20} />
                </span>
                <h2>Email</h2>
                <a href={`mailto:${CONTACT_EMAIL}`} className="link">
                  {CONTACT_EMAIL}
                </a>
              </div>
            )}
            <div className="ct__block">
              <h2>Helpful to include</h2>
              <ul className="ticks">
                {HELPFUL.map((h) => (
                  <li key={h}>
                    <Check size={16} strokeWidth={2.6} aria-hidden="true" />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
            <p className="ct__faq">
              Quick answers are in the{' '}
              <Link href="/faq" className="link">
                FAQ
              </Link>
              .
            </p>
          </aside>
          <div className="ct__main">
            <h2 className="ct__title">Send a message</h2>
            <ContactForm />
          </div>
        </div>
      </Section>
    </>
  );
}
