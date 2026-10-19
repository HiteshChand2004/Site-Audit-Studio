'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { Button, Field } from '@/components/ui';
import { CONTACT_EMAIL } from '@/lib/site';

const PLANS = ['starter', 'team', 'agency'];

/** Opens the visitor's email app with the message filled in (there is no form backend). */
export default function ContactForm() {
  const [plan, setPlan] = useState('');

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('plan');
    if (p && PLANS.includes(p)) setPlan(p);
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const subject = `Remastly${plan ? ` (${plan[0].toUpperCase()}${plan.slice(1)} plan)` : ''}: ${f.get('name')}`;
    const lines = [`Name: ${f.get('name')}`, `Email: ${f.get('email')}`];
    if (f.get('website')) lines.push(`Website: ${f.get('website')}`);
    if (plan) lines.push(`Plan: ${plan}`);
    const body = [...lines, '', String(f.get('message') ?? '')].join('\n');
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field id="c-name" name="name" label="Your name" autoComplete="name" required />
      <Field id="c-email" name="email" type="email" label="Work email" autoComplete="email" required />
      <Field id="c-site" name="website" type="url" inputMode="url" label="Website (optional)" placeholder="https://yoursite.com" />
      <Field id="c-plan" as="select" name="plan" label="Plan you’re interested in" value={plan} onChange={(e) => setPlan(e.currentTarget.value)}>
        <option value="">Not sure yet</option>
        <option value="starter">Starter</option>
        <option value="team">Team</option>
        <option value="agency">Agency</option>
      </Field>
      <Field id="c-msg" as="textarea" name="message" label="Message" required />
      <Button type="submit" block>
        <Mail size={17} aria-hidden="true" /> Send by email
      </Button>
      <p className="form__note">This opens your email app with the message filled in, addressed to {CONTACT_EMAIL}.</p>
    </form>
  );
}
