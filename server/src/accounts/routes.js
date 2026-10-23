// @ts-check
// /api/auth — sign-up, sign-in, sign-out, who am I, and email verification. Mounted only while SAS_ACCOUNTS=1 (src/index.js).
//
//   POST /signup   { email, password }  → 201 { user }   + session cookie. Verified at once only under SAS_DEV_NO_VERIFY
//                                                         (config/index.js devNoVerify); otherwise unverified, and a code is sent.
//   POST /login    { email, password }  → 200 { user }   + a new session cookie;  401 for a wrong email or password (one message)
//   POST /logout                        → 204            session removed, cookie cleared
//   GET  /me                            → 200 { user }   | 401
//   POST /verify/send                   → 202 { sentTo, expiresAt }   a new code (no mail module yet: written to the server log)
//   POST /verify   { code }             → 200 { user }   the account is verified
// Every error is { error: <a sentence for the person>, field? } so the sign-in form can show it as it is.
import { Router } from 'express';
import { devNoVerify, isProduction } from '../config/index.js';
import { normalizeEmail } from '../db/migrations.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import {
  checkCode, createCode, createSession, createUser, endSession, findUserByEmail, lastCodeAt, markVerified, publicUser,
  reclaimUser, findUser,
} from './store.js';
import { clearSessionCookie, limiter, readSessionCookie, setSessionCookie } from './http.js';
import { currentSession } from './gate.js';

const router = Router();

const signins = limiter({ max: 10, windowMs: 15 * 60_000 }); // failed sign-ins per address + IP
const signups = limiter({ max: 20, windowMs: 60 * 60_000 }); // sign-ups per IP
const RESEND_MS = 60_000;

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const wait = (res, seconds) => { res.set('Retry-After', String(seconds)); return fail(res, 429, `Too many tries. Try again in ${Math.ceil(seconds / 60)} minute(s).`); };

/** A code for this account; with no mail module yet it goes to the server's log (never in production, never in a response). */
function sendVerificationCode(user) {
  const { code, expiresAt } = createCode(user, 'verify');
  if (!isProduction()) console.log(`[accounts] verification code for ${user.email}: ${code} (valid until ${expiresAt})`);
  return { sentTo: user.email, expiresAt };
}

router.post('/signup', async (req, res) => {
  const ip = req.ip ?? '';
  const retry = signups.blocked(ip);
  if (retry) return wait(res, retry);
  const email = normalizeEmail(req.body?.email);
  if (!email) return fail(res, 400, 'Enter a valid email address.', { field: 'email' });
  const problem = passwordProblem(req.body?.password);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  signups.hit(ip);

  const verified = devNoVerify();
  const passwordHash = await hashPassword(req.body.password);
  const existing = findUserByEmail(email);
  if (existing?.email_verified_at) {
    return fail(res, 409, 'An account with this email already exists. Sign in instead.', { field: 'email' });
  }
  const user = existing ? reclaimUser(existing.id, { passwordHash, verified }) : createUser({ email, passwordHash, verified });
  const { token } = createSession(user.id, { userAgent: req.get('user-agent') });
  setSessionCookie(res, token);
  const out = { user: publicUser(user) };
  if (!user.email_verified_at) Object.assign(out, { verification: sendVerificationCode(user) });
  res.status(201).json(out);
});

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const key = `${email ?? ''}|${req.ip ?? ''}`;
  const retry = signins.blocked(key);
  if (retry) return wait(res, retry);
  const user = email ? findUserByEmail(email) : undefined;
  const ok = await verifyPassword(String(req.body?.password ?? ''), user?.password_hash);
  if (!user || !ok) {
    signins.hit(key);
    return fail(res, 401, 'Wrong email or password.');
  }
  signins.reset(key);
  endSession(readSessionCookie(req)); // a sign-in never reuses the session it replaces
  const { token } = createSession(user.id, { userAgent: req.get('user-agent') });
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  endSession(readSessionCookie(req));
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', (req, res) => {
  const s = currentSession(req);
  if (!s) return fail(res, 401, 'Not signed in.');
  res.json({ user: publicUser(s.user) });
});

router.post('/verify/send', (req, res) => {
  const s = currentSession(req);
  if (!s) return fail(res, 401, 'Sign in first.');
  if (s.user.email_verified_at) return res.json({ user: publicUser(s.user), alreadyVerified: true });
  const last = lastCodeAt(s.user.id, 'verify');
  if (last && Date.now() - last < RESEND_MS) return wait(res, Math.ceil((RESEND_MS - (Date.now() - last)) / 1000));
  res.status(202).json(sendVerificationCode(s.user));
});

router.post('/verify', (req, res) => {
  const s = currentSession(req);
  if (!s) return fail(res, 401, 'Sign in first.');
  if (s.user.email_verified_at) return res.json({ user: publicUser(s.user) });
  const code = String(req.body?.code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return fail(res, 400, 'Enter the six-digit code from the email.', { field: 'code' });
  const result = checkCode(s.user.id, 'verify', code);
  const messages = {
    wrong: 'That code is not right. Check the email and try again.',
    expired: 'That code has expired. Ask for a new one.',
    none: 'There is no code for this account yet. Ask for one.',
    'too-many': 'Too many wrong codes. Ask for a new one.',
  };
  if (result !== 'ok') return fail(res, 400, messages[result], { field: 'code', reason: result });
  markVerified(s.user.id);
  res.json({ user: publicUser(/** @type {any} */ (findUser(s.user.id))) });
});

export default router;
