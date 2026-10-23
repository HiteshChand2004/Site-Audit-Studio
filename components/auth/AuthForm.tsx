'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { Button, TextField } from '@/components/ui';
import { AUTH_NOT_OPEN, AUTH_VERIFY } from '@/lib/content';
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

/** What the API says about the code it emailed at sign-up (POST /auth/signup → verification). */
type Verification = { sentTo: string; expiresAt?: string; expiresInMinutes?: number; attempts?: number };
/** An API error: a sentence, the field it belongs to, and — for a code or a sign-in — what to do next. */
type ApiError = { error?: string; field?: string; reason?: string; next?: 'signup'; triesLeft?: number; auth?: 'signin' | 'verify' };

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
 * - the server's own error is shown as it is: under its field when it names one (email, password, code), else as a notice;
 * - signed in: the browser goes to the tool (?next= when the tool sent the visitor here, else NEXT_PUBLIC_APP_URL);
 * - a new account must confirm its email: the API emails a six-digit code and the form turns into the code step (also when the
 *   tool sends an unverified, signed-in visitor here with ?verify=1). The code lasts 10 minutes and allows 5 tries; there is no
 *   resend and no password reset — when a code is dead the form says so and offers to start over, which is signing up again with
 *   the same address (that is how a new code is sent). The API's sentences are shown as they are, nothing is promised that the
 *   API does not do.
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
  // The code step: what was emailed, what is typed, the API's answer to it, and whether the code is dead (then: start over).
  const [verification, setVerification] = useState<Verification | null>(null);
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [codeShake, setCodeShake] = useState(0);
  const [codeDead, setCodeDead] = useState(false);
  const [checking, setChecking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Whether the notice ends with a link to the contact page (only the "not open" notices ask for it).
  const [contactLink, setContactLink] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const live = Boolean(APP_URL);
  const id = (k: string) => `${idPrefix}-${mode}-${k}`;
  const keys = FIELDS[mode];

  useEffect(() => {
    if (notice) noticeRef.current?.focus({ preventScroll: true });
  }, [notice]);

  // Sent here by the tool with ?verify=1: a signed-in account whose email is not confirmed yet. Ask the API who it is and open the
  // code step for that address; anyone else (not signed in, or already verified) sees the ordinary form.
  useEffect(() => {
    if (!live || new URLSearchParams(window.location.search).get('verify') !== '1') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'same-origin' });
        const data = (await res.json().catch(() => null)) as { user?: { email?: string; verified?: boolean } } | null;
        if (cancelled || !res.ok || !data?.user?.email || data.user.verified) return;
        setValues((s) => ({ ...s, email: data.user!.email! }));
        setVerification({ sentTo: data.user.email });
        setPhase('verify');
        showNotice(AUTH_VERIFY.unconfirmed(data.user.email), 'info');
      } catch {
        /* the ordinary form stays */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

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

  const showNotice = (text: string, kind: 'info' | 'error', withContact = false) => {
    setNoticeKind(kind);
    setContactLink(withContact);
    setNotice(text);
  };

  /** The API's error under its field (when it names one the form has), else as a notice. */
  const showApiError = (data: ApiError | null, status: number) => {
    const message = data?.error || AUTH_VERIFY.failed(status);
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
      showNotice(AUTH_VERIFY.unreachable, 'error');
      return;
    }
    const data = (await res.json().catch(() => null)) as (ApiError & { user?: { email?: string; verified?: boolean }; verification?: Verification }) | null;
    // Keep the shimmer on for a moment, so a fast answer does not flash.
    await new Promise((r) => window.setTimeout(r, Math.max(0, LOADING_MS - (Date.now() - started))));
    if (!res.ok || !data?.user) {
      setPhase('idle');
      if (data?.auth === 'verify' && data.next === 'signup') {
        // Signing in with an account that never confirmed its email: the API refuses, and the way back in is a new sign-up.
        setCodeDead(true);
        showNotice(data.error || AUTH_VERIFY.signinUnconfirmed, 'error');
        return;
      }
      showApiError(data, res.status);
      return;
    }
    if (!data.user.verified) {
      // The account exists and is signed in, but the tool lets it in only once the emailed code is entered.
      setVerification(data.verification ?? { sentTo: values.email.trim() });
      setCode('');
      setCodeErr('');
      setCodeDead(false);
      setPhase('verify');
      const v = data.verification;
      showNotice(AUTH_VERIFY.sent(v?.sentTo ?? values.email.trim(), v?.expiresInMinutes, v?.attempts), 'info');
      return;
    }
    window.location.assign(destination());
  };

  /** The code step: POST /auth/verify. Right → the tool. Wrong → under the field with the tries left. Dead → start over. */
  const confirm = async () => {
    const clean = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) {
      setCodeErr(AUTH_VERIFY.codeFormat);
      setCodeShake((n) => n + 1);
      formRef.current?.querySelector<HTMLElement>(`#${id('code')}`)?.focus();
      return;
    }
    setChecking(true);
    setCodeErr('');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: clean }),
      });
    } catch {
      setChecking(false);
      showNotice(AUTH_VERIFY.unreachable, 'error');
      return;
    }
    const data = (await res.json().catch(() => null)) as (ApiError & { user?: { verified?: boolean } }) | null;
    setChecking(false);
    if (res.ok && data?.user?.verified) {
      window.location.assign(destination());
      return;
    }
    if (res.status === 401) {
      // The session is gone (another sign-up with this address ended it, or it expired): only a new sign-up helps.
      setCodeDead(true);
      showNotice(AUTH_VERIFY.sessionGone, 'error');
      return;
    }
    if (data?.next === 'signup') {
      // Expired, tried too often, already used, or never sent: the API says which, and that there is no resend.
      setCodeDead(true);
      setCode('');
      showNotice(data.error || AUTH_VERIFY.codeDead, 'error');
      return;
    }
    const message = data?.error || AUTH_VERIFY.failed(res.status);
    setCodeErr(message);
    setCodeShake((n) => n + 1);
    setNotice('');
    formRef.current?.querySelector<HTMLElement>(`#${id('code')}`)?.focus();
  };

  /**
   * Start over = sign up again with the same address (the only way to a new code). In sign-up mode the email and name stay, the
   * password is asked again; in sign-in mode the form switches to sign-up.
   */
  const startOver = () => {
    if (mode !== 'signup') {
      onSwitch('signup');
      return;
    }
    setPhase('idle');
    setVerification(null);
    setCode('');
    setCodeErr('');
    setCodeDead(false);
    setValues((s) => ({ ...s, password: '', confirm: '' }));
    setShown((s) => ({ ...s, password: false, confirm: false }));
    setServerErr({});
    showNotice(AUTH_VERIFY.startedOver, 'info');
    window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(`#${id('password')}`)?.focus(), 50);
  };

  const onBlur = (k: Key) => () => {
    setBlurred((b) => ({ ...b, [k]: true }));
    if (!shown[k]) reveal([k]);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (phase === 'verify') {
      if (!checking && !codeDead) void confirm();
      return;
    }
    if (phase === 'loading') return;
    const bad = reveal(keys);
    if (bad.length) {
      formRef.current?.querySelector<HTMLElement>(`#${id(bad[0])}`)?.focus();
      return;
    }
    if (!live) {
      // Nothing is connected: say so at once, with no loading state that could look like progress.
      showNotice(AUTH_NOT_OPEN[mode], 'info', true);
      return;
    }
    setNotice('');
    setServerErr({});
    setCodeDead(false);
    setPhase('loading');
    void send();
  };

  // There is no password reset (the user's decision): say so, and promise nothing (the contact page is not connected yet either).
  const forgot = () => showNotice(AUTH_VERIFY.noReset, 'info');

  /** Error to display: only once the field has been revealed (blur or submit); then it updates live. The server's comes after. */
  const err = (k: Key) => (shown[k] ? errorOf(k) || serverErr[k] || undefined : undefined);
  const ok = (k: Key) => Boolean(values[k]) && !errorOf(k) && !serverErr[k] && Boolean(shown[k] || blurred[k]);

  const pw = values.password;
  let i = 0;

  if (phase === 'verify') {
    // The code step replaces the fields: one six-digit field, the facts, Confirm — and Start over once the code is dead.
    return (
      <form ref={formRef} className="auth-form" noValidate onSubmit={onSubmit}>
        <div className="auth-grid">
          <div className="auth-grid__full" style={at(i++)}>
            <TextField
              id={id('code')}
              name="code"
              type="text"
              label={AUTH_VERIFY.codeLabel(verification?.sentTo ?? values.email.trim())}
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder={AUTH_VERIFY.codePlaceholder}
              maxLength={7}
              value={code}
              disabled={codeDead || checking}
              onChange={(e) => {
                setCode(e.currentTarget.value);
                if (codeErr) setCodeErr('');
              }}
              error={codeErr || undefined}
              shake={codeShake}
              describedBy={id('code-note')}
            />
            <p id={id('code-note')} className="auth-legal" style={{ marginTop: 6 }}>
              {AUTH_VERIFY.codeNote(verification?.expiresInMinutes)}
            </p>
          </div>
        </div>

        <div className="auth-foot" style={at(i++)}>
          <div className="auth-foot__meta">
            <p className="auth-req">
              {codeDead ? AUTH_VERIFY.factsDead : AUTH_VERIFY.facts(verification?.expiresInMinutes, verification?.attempts)}
            </p>
          </div>
          {codeDead ? (
            <Button type="button" arrow className="auth-submit" onClick={startOver}>
              {AUTH_VERIFY.startOver}
            </Button>
          ) : (
            <Button type="submit" arrow={!checking} aria-disabled={checking ? true : undefined} aria-busy={checking || undefined} className="auth-submit" data-loading={checking || undefined}>
              {checking ? (
                <>
                  <span className="btn-load" aria-hidden="true">
                    <i />
                  </span>
                  <span className="visually-hidden">{AUTH_VERIFY.checking}</span>
                </>
              ) : (
                AUTH_VERIFY.confirm
              )}
            </Button>
          )}
        </div>

        {notice && (
          <p ref={noticeRef} tabIndex={-1} className="auth-notice" role={noticeKind === 'error' ? 'alert' : 'status'} data-kind={noticeKind}>
            <Info size={16} aria-hidden="true" />
            <span>{notice}</span>
          </p>
        )}

        <p className="auth-switch" style={at(i++)}>
          {codeDead ? AUTH_VERIFY.startOverExplained : AUTH_VERIFY.wrongEmail}{' '}
          {!codeDead && (
            <button type="button" className="link-btn link-btn--strong" onClick={startOver}>
              {AUTH_VERIFY.startOver}
            </button>
          )}
        </p>
      </form>
    );
  }

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
              {live && ` ${AUTH_VERIFY.willEmail}`}
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
            {codeDead && mode === 'signin' && (
              <>
                {' '}
                <button type="button" className="link-btn link-btn--strong" onClick={startOver}>
                  {AUTH_VERIFY.createAgain}
                </button>
              </>
            )}
            {contactLink && !codeDead && (
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
