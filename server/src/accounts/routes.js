// @ts-check
// /api/auth — sign-up, sign-in, sign-out, who am I, and email verification. Mounted only while SAS_ACCOUNTS=1 (src/index.js).
//
//   POST /signup   { email, password, name? } → 201 { user, verification } + session cookie. Verified at once only under
//                                                SAS_DEV_NO_VERIFY (config/index.js devNoVerify); otherwise the account is
//                                                unverified and a six-digit code is emailed (src/mail.js). 503 when the email
//                                                could not be sent (the address stays claimable, no session), 429 when this
//                                                address had its share of codes (store.js CODES_PER_HOUR / CODES_PER_DAY).
//   POST /login    { email, password }  → 200 { user }   + a new session cookie;  401 for a wrong email or password (one message);
//                                         403 { auth: 'verify', next: 'signup' } for an account that never confirmed its email
//                                         (no session: it signs up again with the same address to get a new code).
//   POST /logout                        → 204            session removed, cookie cleared
//   GET  /me                            → 200 { user }   | 401
//   POST /verify   { code }             → 200 { user }   the account is verified. 400 { field: 'code', reason, next? } otherwise:
//                                         reason 'wrong' (with triesLeft), or 'expired' | 'too-many' | 'used' | 'none' with
//                                         next: 'signup' — there is NO resend: a new code means signing up again.
//   POST /password { currentPassword, newPassword } → 200 { user }   every other session of the account ends
// Every error is { error: <a sentence for the person>, field? } so the sign-in form can show it as it is.
import { Router } from 'express';
import { devNoVerify } from '../config/index.js';
import { normalizeEmail } from '../db/migrations.js';
import { sendMail } from '../mail.js';
import { verificationMail } from './verificationMail.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import {
  CODE_ATTEMPTS, CODE_MINUTES, checkCode, codeAllowance, createCode, createSession, createUser, discardCode, endSession,
  findUserByEmail, markVerified, publicUser, reclaimUser, findUser, changePassword,
} from './store.js';
import { clearSessionCookie, limiter, readSessionCookie, setSessionCookie } from './http.js';
import { currentSession } from './gate.js';

const router = Router();

const signins = limiter({ max: 10, windowMs: 15 * 60_000 }); // failed sign-ins per address + IP
const signups = limiter({ max: 20, windowMs: 60 * 60_000 }); // sign-ups per IP
const verifies = limiter({ max: 10, windowMs: 15 * 60_000 }); // code checks per session (each code also dies after CODE_ATTEMPTS)
const NAME_MAX = 80;

/** How a dead code is replaced, in one sentence: the only way, since there is no resend. */
export const SIGN_UP_AGAIN = 'To get a new code, create the account again with the same email address.';

/** The name as given (trimmed, inner spaces collapsed), null when none was given, or false when it cannot be one. */
function cleanName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return false;
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.length > NAME_MAX || /[\u0000-\u001f\u007f<>]/.test(name)) return false;
  return name;
}

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
const wait = (res, seconds, error = `Too many tries. Try again in ${minutes(seconds * 1000)} minute(s).`, extra = {}) => {
  res.set('Retry-After', String(seconds));
  return fail(res, 429, error, extra);
};

/** The verification facts the sign-up form shows, so nobody waits for a resend that does not exist. */
const verificationInfo = (user, expiresAt) => ({ sentTo: user.email, expiresAt, expiresInMinutes: CODE_MINUTES, attempts: CODE_ATTEMPTS, resend: false, next: 'signup' });

router.post('/signup', async (req, res) => {
  const ip = req.ip ?? '';
  const retry = signups.blocked(ip);
  if (retry) return wait(res, retry);
  const email = normalizeEmail(req.body?.email);
  if (!email) return fail(res, 400, 'Enter a valid email address.', { field: 'email' });
  const problem = passwordProblem(req.body?.password);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  const name = cleanName(req.body?.name);
  if (name === false) return fail(res, 400, `Use up to ${NAME_MAX} letters and spaces for your name.`, { field: 'name' });

  const existing = findUserByEmail(email);
  if (existing?.email_verified_at) {
    signups.hit(ip);
    return fail(res, 409, 'An account with this email already exists. Sign in instead.', { field: 'email' });
  }
  const verified = devNoVerify();
  if (!verified) {
    // Before anything is written: a blocked sign-up changes nothing, not even the unverified account's password.
    const allowance = codeAllowance(email, 'verify');
    if (!allowance.ok) {
      const wait_ = minutes(allowance.retryAfterMs);
      return wait(res, Math.ceil(allowance.retryAfterMs / 1000),
        `${email} has already been sent its share of codes for ${allowance.window === 'day' ? 'today' : 'this hour'}. `
        + `Try again in ${wait_} minute(s)${allowance.window === 'day' ? '' : ', or look for the last code in the inbox'}.`,
        { field: 'email', reason: 'code-limit', retryAfterMinutes: wait_ });
    }
  }
  signups.hit(ip);

  const passwordHash = await hashPassword(req.body.password);
  const user = existing ? reclaimUser(existing.id, { passwordHash, verified, name }) : createUser({ email, name, passwordHash, verified });
  if (user.email_verified_at) {
    const { token } = createSession(user.id, { userAgent: req.get('user-agent') });
    setSessionCookie(res, token);
    return res.status(201).json({ user: publicUser(user) });
  }

  const { id, code, expiresAt } = createCode(user, 'verify');
  try {
    await sendMail(verificationMail(user, code));
  } catch (err) {
    discardCode(id);
    console.error(`[accounts] verification email to ${user.email} not sent: ${/** @type {Error} */ (err).message}`);
    return fail(res, 503, 'We could not send the verification email right now. Nothing was lost: create the account again in a few minutes.', { reason: 'mail' });
  }
  const { token } = createSession(user.id, { userAgent: req.get('user-agent') });
  setSessionCookie(res, token);
  res.status(201).json({ user: publicUser(user), verification: verificationInfo(user, expiresAt) });
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
  if (!user.email_verified_at) {
    // No session for an account that never confirmed its address. There is no resend, so the way back in is a new sign-up.
    return fail(res, 403, `This account has not confirmed its email address yet, so it cannot sign in. ${SIGN_UP_AGAIN}`, { auth: 'verify', next: 'signup' });
  }
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

// A new password for the signed-in account: the current one first. Every other session ends; this one stays.
router.post('/password', async (req, res) => {
  const s = currentSession(req);
  if (!s) return fail(res, 401, 'Sign in first.');
  const key = `password|${s.user.id}`;
  const retry = signins.blocked(key);
  if (retry) return wait(res, retry);
  if (!(await verifyPassword(String(req.body?.currentPassword ?? ''), s.user.password_hash))) {
    signins.hit(key);
    return fail(res, 400, 'Your current password is not right.', { field: 'currentPassword' });
  }
  const problem = passwordProblem(req.body?.newPassword);
  if (problem) return fail(res, 400, problem, { field: 'newPassword' });
  if (req.body.newPassword === req.body.currentPassword) return fail(res, 400, 'Choose a password different from the current one.', { field: 'newPassword' });
  signins.reset(key);
  changePassword(s.user.id, await hashPassword(req.body.newPassword), s.session.id);
  res.json({ user: publicUser(s.user), otherSessionsEnded: true });
});

router.post('/verify', (req, res) => {
  const s = currentSession(req);
  if (!s) return fail(res, 401, 'Sign in first.');
  if (s.user.email_verified_at) return res.json({ user: publicUser(s.user) });
  const key = `verify|${s.session.id}`;
  const retry = verifies.blocked(key);
  if (retry) return wait(res, retry);
  const code = String(req.body?.code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return fail(res, 400, 'Enter the six-digit code from the email.', { field: 'code' });
  verifies.hit(key);
  const result = checkCode(s.user.id, 'verify', code);
  if (result.status === 'wrong') {
    return fail(res, 400, `That code is not right. Check the email and try again (${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left).`,
      { field: 'code', reason: 'wrong', triesLeft: result.triesLeft });
  }
  const dead = {
    expired: `That code has expired (a code lasts ${CODE_MINUTES} minutes). ${SIGN_UP_AGAIN}`,
    'too-many': `That code was tried ${CODE_ATTEMPTS} times and no longer works. ${SIGN_UP_AGAIN}`,
    used: `That code was already used. ${SIGN_UP_AGAIN}`,
    none: `No code was sent for this account. ${SIGN_UP_AGAIN}`,
  };
  if (result.status !== 'ok') return fail(res, 400, dead[result.status], { field: 'code', reason: result.status, next: 'signup' });
  verifies.reset(key);
  markVerified(s.user.id);
  res.json({ user: publicUser(/** @type {any} */ (findUser(s.user.id))) });
});

// Anything else under /api/auth does not exist (a removed route such as /verify/send answers 404, not the gate's 401 / 403).
router.use((req, res) => res.status(404).json({ error: 'No such route.' }));

export default router;
