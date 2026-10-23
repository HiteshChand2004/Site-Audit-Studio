'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { Button, TextField } from '@/components/ui';
import { AUTH_NOT_OPEN } from '@/lib/content';
import { APP_URL } from '@/lib/site';

export type AuthMode = 'signin' | 'signup';
type Key = 'name' | 'email' | 'password' | 'confirm';
type Values = Record<Key | 'site', string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME = /^[\p{L} ]+$/u;
const LOADING_MS = 900;
/** The tool's API on this same origin (the local proxy and a hosted deployment both serve it at /api). */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '/api').replace(/\/$/, '');

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
 * - a valid submit shows a loading shimmer and sends the form with fetch to the tool's API (NEXT_PUBLIC_API_BASE, default /api, on
 *   this same origin: the session cookie it sets is the tool's session); when NEXT_PUBLIC_APP_URL is not set it says sign-in is
 *   not open and sends nothing; the name is stored with the account, the website to rebuild fills in the tool's first form;
 * - the server's own error is shown as it is: under its field when it names one (email, password), else as a notice;
 * - signed in: the browser goes to the tool (?next= when the tool sent the visitor here, else NEXT_PUBLIC_APP_URL);
 * - an account that still has to confirm its email address is told so (the code step is not required yet; this is where it goes).
 * It never pretends anyone is signed in.
 */
export default function AuthForm({ mode, site = '', onSwitch, idPrefix = 'a' }: { mode: AuthMode; site?: string; onSwitch: (m: AuthMode) => void; idPrefix?: string }) {
  const [values, setValues] = useState<Values>({ name: '', email: '', password: '', confirm: '', site });
  const [shown, setShown] = useState<Partial<Record<Key, boolean>>>({});
  const [blurred, setBlurred] = useState<Partial<Record<Key, boolean>>>({});
  const [shake, setShake] = useState<Partial<Record<Key, number>>>({});
  const [phase, setPhase] = useState<'idle' | 'loading' | 'verify'>('idle');
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'info' | 'error'>('info');
  const [serverErr, setServerErr] = useState<Partial<Record<Key, string>>>({});
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
    if (k !== 'site') setServerErr((s) => (s[k] ? { ...s, [k]: undefined } : s));
  };

  /**
   * Where to go once signed in: the tool page that sent the visitor here (?next=/app/…), else the tool's home — with the
   * "Website to rebuild" of a sign-up as ?site=, which opens the tool's Add a website form filled in with it.
   */
  const destination = () => {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && /^\/app(\/|$|\?)/.test(next)) return next;
    const site = mode === 'signup' ? values.site.trim() : '';
    return site ? `${APP_URL}/?site=${encodeURIComponent(site)}` : `${APP_URL}/`;
  };

  const showNotice = (text: string, kind: 'info' | 'error') => {
    setNoticeKind(kind);
    setNotice(text);
  };

  /** Sign in or sign up through the tool's API. The server decides; its message is shown as it is. */
  const send = async () => {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/${mode === 'signin' ? 'login' : 'signup'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email.trim(), password: values.password, ...(mode === 'signup' && { name: values.name.trim() }) }),
      });
    } catch {
      setPhase('idle');
      showNotice('The app could not be reached. Check your connection and try again.', 'error');
      return;
    }
    const data = (await res.json().catch(() => null)) as { error?: string; field?: string; user?: { verified?: boolean } } | null;
    // Keep the shimmer on for a moment, so a fast answer does not flash.
    await new Promise((r) => window.setTimeout(r, Math.max(0, LOADING_MS - (Date.now() - started))));
    if (!res.ok || !data?.user) {
      setPhase('idle');
      const message = data?.error || `Something went wrong (${res.status}). Try again.`;
      const field = data?.field as Key | undefined;
      if (field && keys.includes(field)) {
        setServerErr((s) => ({ ...s, [field]: message }));
        setShown((s) => ({ ...s, [field]: true }));
        setShake((s) => ({ ...s, [field]: (s[field] ?? 0) + 1 }));
        formRef.current?.querySelector<HTMLElement>(`#${id(field)}`)?.focus();
        setNotice('');
      } else {
        showNotice(message, 'error');
      }
      return;
    }
    if (!data.user.verified) {
      // Room for the email code step: the account exists and is signed in, but the tool lets it in only once verified.
      setPhase('verify');
      showNotice(`Your account is created. Confirm ${values.email.trim()} to continue: email confirmation is not switched on yet, so this account waits until it is.`, 'info');
      return;
    }
    window.location.assign(destination());
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
    if (!live) {
      // Nothing is connected: say so at once, with no loading state that could look like progress.
      showNotice(AUTH_NOT_OPEN[mode], 'info');
      return;
    }
    setNotice('');
    setServerErr({});
    setPhase('loading');
    void send();
  };

  const forgot = () => showNotice('Password reset is not open yet.', 'info');

  /** Error to display: only once the field has been revealed (blur or submit); then it updates live. The server's comes after. */
  const err = (k: Key) => (shown[k] ? errorOf(k) || serverErr[k] || undefined : undefined);
  const ok = (k: Key) => Boolean(values[k]) && !errorOf(k) && !serverErr[k] && Boolean(shown[k] || blurred[k]);

  const pw = values.password;
  let i = 0;

  return (
    <form ref={formRef} className="auth-form" noValidate onSubmit={onSubmit}>
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
                // No reset in the tool yet (it needs email): say so rather than link to a page that does not exist.
                <button type="button" className="link-btn tf__aside" onClick={forgot}>
                  Forgot password?
                </button>
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
        <p ref={noticeRef} tabIndex={-1} className="auth-notice" role={noticeKind === 'error' ? 'alert' : 'status'} data-kind={noticeKind}>
          <Info size={16} aria-hidden="true" />
          <span>
            {notice}
            {noticeKind === 'info' && phase !== 'verify' && (
              <>
                {' '}
                <Link href="/contact">Contact us</Link>
              </>
            )}
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
