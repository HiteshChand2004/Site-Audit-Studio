'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { Button, TextField } from '@/components/ui';
import { APP_URL } from '@/lib/site';

export type AuthMode = 'signin' | 'signup';
type Key = 'name' | 'email' | 'password' | 'confirm';
type Values = Record<Key | 'site', string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME = /^[\p{L} ]+$/u;
const LOADING_MS = 900;

const FIELDS: Record<AuthMode, Key[]> = {
  signin: ['email', 'password'],
  signup: ['name', 'email', 'password', 'confirm'],
};

/** Password rules for sign up. */
const RULES = [
  { id: 'len', label: '8+ characters', test: (p: string) => p.length >= 8 },
  { id: 'letter', label: 'A letter', test: (p: string) => /\p{L}/u.test(p) },
  { id: 'number', label: 'A number', test: (p: string) => /\d/.test(p) },
];


function check(mode: AuthMode, k: Key, v: Values): string {
  const val = v[k];
  switch (k) {
    case 'name': {
      const t = val.trim();
      if (!t) return 'Enter your name';
      if (t.length < 2 || t.length > 50) return 'Use 2–50 characters';
      if (!NAME.test(t)) return 'Use letters and spaces only';
      return '';
    }
    case 'email':
      if (!val.trim()) return 'Enter your email';
      return EMAIL.test(val.trim()) ? '' : 'Enter a valid email';
    case 'password':
      if (!val) return mode === 'signin' ? 'Enter your password' : 'Enter a password';
      if (mode === 'signup' && !RULES.every((r) => r.test(val))) return 'Use 8+ characters with a letter and a number';
      return '';
    case 'confirm':
      if (!val) return 'Re-enter your password';
      return val === v.password ? '' : 'Passwords don’t match';
  }
}

/** Stagger index for the field entrance animation (see .auth-swap). */
const at = (i: number) => ({ ['--i' as string]: i }) as CSSProperties;

/**
 * Email + password form (labels above the fields, example placeholders inside) with friendly validation:
 * - fields validate on blur and on submit; while typing only once a field has shown an error;
 * - errors show inline with a red border and one gentle shake; a green tick appears when a field becomes valid;
 * - submit looks disabled until the required fields are valid; clicking it then points to the first problem;
 * - a valid submit shows a loading shimmer, then posts to NEXT_PUBLIC_APP_URL, or says sign-in opens soon.
 * It never pretends anyone is signed in.
 */
export default function AuthForm({ mode, site = '', onSwitch, idPrefix = 'a' }: { mode: AuthMode; site?: string; onSwitch: (m: AuthMode) => void; idPrefix?: string }) {
  const [values, setValues] = useState<Values>({ name: '', email: '', password: '', confirm: '', site });
  const [shown, setShown] = useState<Partial<Record<Key, boolean>>>({});
  const [blurred, setBlurred] = useState<Partial<Record<Key, boolean>>>({});
  const [shake, setShake] = useState<Partial<Record<Key, number>>>({});
  const [phase, setPhase] = useState<'idle' | 'loading' | 'soon'>('idle');
  const [notice, setNotice] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const live = Boolean(APP_URL);
  const id = (k: string) => `${idPrefix}-${mode}-${k}`;
  const keys = FIELDS[mode];

  useEffect(() => {
    if (notice) noticeRef.current?.focus({ preventScroll: true });
  }, [notice]);

  const errorOf = (k: Key) => check(mode, k, values);
  const allValid = keys.every((k) => !errorOf(k));

  const reveal = (ks: Key[]) => {
    const bad = ks.filter((k) => errorOf(k));
    setShown((s) => ({ ...s, ...Object.fromEntries(ks.map((k) => [k, true])) }));
    setShake((s) => ({ ...s, ...Object.fromEntries(bad.map((k) => [k, (s[k] ?? 0) + 1])) }));
    return bad;
  };

  const set = (k: Key | 'site') => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value;
    setValues((s) => ({ ...s, [k]: v }));
  };

  const onBlur = (k: Key) => () => {
    setBlurred((b) => ({ ...b, [k]: true }));
    if (!shown[k]) reveal([k]);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (phase === 'loading') return;
    const bad = reveal(keys);
    if (bad.length) {
      formRef.current?.querySelector<HTMLElement>(`#${id(bad[0])}`)?.focus();
      return;
    }
    setNotice('');
    setPhase('loading');
    window.setTimeout(() => {
      if (live) {
        formRef.current?.submit(); // native POST to the app; the page navigates away
        return;
      }
      setPhase('soon');
      setNotice(`${mode === 'signin' ? 'Sign-in' : 'Sign-up'} opens soon. Leave your details and we’ll let you know.`);
    }, LOADING_MS);
  };

  const google = () => setNotice('Continue with Google is coming soon.');
  const forgot = () => setNotice('Password reset opens together with sign-in. Need help now? Write to us.');

  /** Error to display: only once the field has been revealed (blur or submit); then it updates live. */
  const err = (k: Key) => (shown[k] ? errorOf(k) || undefined : undefined);
  const ok = (k: Key) => Boolean(values[k]) && !errorOf(k) && Boolean(shown[k] || blurred[k]);

  const pw = values.password;
  let i = 0;

  return (
    <form ref={formRef} className="auth-form" action={live ? `${APP_URL}/${mode}` : undefined} method="post" noValidate onSubmit={onSubmit}>
      <div style={at(i++)}>
        <Button variant="secondary" block className="auth-google" onClick={google}>
          <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Continue with Google
        </Button>
      </div>

      <p className="auth-or" style={at(i++)}>
        <span>or with email</span>
      </p>

      <div className="auth-grid">
        {mode === 'signup' && (
          <div style={at(i++)}>
            <TextField
              id={id('name')}
              name="name"
              label="Your name"
              required
              autoComplete="name"
              placeholder="e.g. Hitesh"
              maxLength={50}
              value={values.name}
              onChange={set('name')}
              onBlur={onBlur('name')}
              error={err('name')}
              valid={ok('name')}
              shake={shake.name}
            />
          </div>
        )}
        <div style={at(i++)}>
          <TextField
            id={id('email')}
            name="email"
            type="email"
            label="Your email"
            required
            autoComplete="email"
            inputMode="email"
            placeholder="e.g. hitesh@example.com"
            value={values.email}
            onChange={set('email')}
            onBlur={onBlur('email')}
            error={err('email')}
            valid={ok('email')}
            shake={shake.email}
          />
        </div>
        <div style={at(i++)}>
          <TextField
            id={id('password')}
            name="password"
            type="password"
            label="Password"
            required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            placeholder="Min. 8 characters"
            value={pw}
            onChange={set('password')}
            onBlur={onBlur('password')}
            error={err('password')}
            valid={ok('password')}
            shake={shake.password}
            aside={
              mode === 'signin' ? (
                live ? (
                  <a className="tf__aside" href={`${APP_URL}/forgot-password`}>
                    Forgot password?
                  </a>
                ) : (
                  <button type="button" className="link-btn tf__aside" onClick={forgot}>
                    Forgot password?
                  </button>
                )
              ) : undefined
            }
          />
        </div>
        {mode === 'signup' && (
          <>
            <div style={at(i++)}>
              <TextField
                id={id('confirm')}
                name="confirm"
                type="password"
                label="Confirm password"
                required
                autoComplete="new-password"
                placeholder="Re-enter your password"
                value={values.confirm}
                onChange={set('confirm')}
                onBlur={onBlur('confirm')}
                error={err('confirm')}
                valid={ok('confirm')}
                shake={shake.confirm}
              />
            </div>
            <div className="auth-grid__full" style={at(i++)}>
              <TextField
                id={id('site')}
                name="site"
                type="url"
                inputMode="url"
                label="Website to rebuild (optional)"
                placeholder="e.g. https://yoursite.com"
                value={values.site}
                onChange={set('site')}
              />
            </div>
          </>
        )}
      </div>

      <div className="auth-foot" style={at(i++)}>
        <div className="auth-foot__meta">
          <p className="auth-req">
            <span aria-hidden="true">*</span> Required fields
          </p>
          {mode === 'signup' && (
            <p className="auth-legal">
              By signing up you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy policy</Link>.
            </p>
          )}
        </div>
        <Button type="submit" arrow={phase !== 'loading'} aria-disabled={!allValid || phase === 'loading' ? true : undefined} aria-busy={phase === 'loading' || undefined} className="auth-submit" data-loading={phase === 'loading' || undefined}>
          {phase === 'loading' ? (
            <>
              <span className="btn-load" aria-hidden="true">
                <i />
              </span>
              <span className="visually-hidden">Working…</span>
            </>
          ) : mode === 'signin' ? (
            'Sign in'
          ) : (
            'Create account'
          )}
        </Button>
      </div>

      {notice && (
        <p ref={noticeRef} tabIndex={-1} className="auth-notice" role="status">
          <Info size={16} aria-hidden="true" />
          <span>
            {notice} <Link href="/contact">Contact us</Link>
          </span>
        </p>
      )}

      <p className="auth-switch" style={at(i++)}>
        {mode === 'signin' ? 'New here?' : 'Have an account?'}{' '}
        <button type="button" className="link-btn link-btn--strong" onClick={() => onSwitch(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </form>
  );
}
