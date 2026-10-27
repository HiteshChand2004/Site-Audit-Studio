'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Info, Send } from 'lucide-react';
import { Button, Field } from '@/components/ui';
import { CONTACT_PENDING, pricing } from '@/lib/content';
import { CONTACT_EMAIL } from '@/lib/site';

const PLANS: string[] = pricing.plans.map((p) => p.id);

/*
 * The contact form, laid out on the page (no card). There is no form backend: with a contact address set
 * (NEXT_PUBLIC_CONTACT_EMAIL) it opens the visitor's email app with the message filled in; without one it checks the
 * fields and then says plainly that nothing was sent.
 */
export default function ContactForm() {
  const [plan, setPlan] = useState('');
  const [notSent, setNotSent] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('plan');
    if (p && PLANS.includes(p)) setPlan(p);
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!CONTACT_EMAIL) {
      setNotSent(true);
      return;
    }
    const f = new FormData(e.currentTarget);
    const subject = `Remastly${plan ? ` (${plan[0].toUpperCase()}${plan.slice(1)} plan)` : ''}: ${f.get('name')}`;
    const lines = [`Name: ${f.get('name')}`, `Email: ${f.get('email')}`];
    if (f.get('website')) lines.push(`Website: ${f.get('website')}`);
    if (plan) lines.push(`Plan: ${plan}`);
    const body = [...lines, '', String(f.get('message') ?? '')].join('\n');
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <form className="ct-form" onSubmit={submit}>
      <div className="ct-form__row">
        <Field id="c-name" name="name" label="Your name" autoComplete="name" placeholder="e.g. Hitesh" required />
        <Field id="c-email" name="email" type="email" label="Work email" autoComplete="email" placeholder="you@company.com" required />
      </div>
      <div className="ct-form__row">
        <Field id="c-site" name="website" type="url" inputMode="url" label="Website (optional)" placeholder="https://yoursite.com" />
        <Field id="c-plan" as="select" name="plan" label="Plan you’re interested in" value={plan} onChange={(e) => setPlan(e.currentTarget.value)}>
          <option value="">Not sure yet</option>
          {pricing.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Field>
      </div>
      <Field id="c-msg" as="textarea" name="message" label="Message" placeholder="Tell us about your site and what you’d like to do with it." rows={5} required />
      <div className="ct-form__foot">
        <Button type="submit">
          <Send size={16} aria-hidden="true" /> {CONTACT_EMAIL ? 'Send by email' : 'Send message'}
        </Button>
        {CONTACT_EMAIL && <p className="ct-form__note">Opens your email app with the message filled in, addressed to {CONTACT_EMAIL}.</p>}
      </div>
      {notSent && (
        <p className="ct-form__notice" role="status">
          <Info size={16} aria-hidden="true" />
          {CONTACT_PENDING.form}
        </p>
      )}
    </form>
  );
}
