// @ts-check
// The one way the server sends an email: sendMail({ to, subject, text }). Plain text only; nothing else in the server knows how a
// mail leaves (today nodemailer over SMTP, from config/index.js mailConfig), so the provider can be swapped by changing this file.
//
// Without SMTP_HOST a development server prints each mail to its log instead ('log' transport) — a hosted server never does: in
// production, accounts on and no SMTP refuses to start (config/index.js startupProblems). The SMTP password is read from config
// into the transport and appears in no log line and no error: a failure is reported with the server's reply, never the credentials.
import nodemailer from 'nodemailer';
import { isProduction, mailConfig } from './config/index.js';

/** @typedef {{ to: string, subject: string, text: string }} Mail */
/** @typedef {{ kind: 'smtp' | 'log', send: (mail: Mail) => Promise<{ id?: string }> }} Mailer */

const CONNECT_MS = 10_000;
const SOCKET_MS = 20_000;

/**
 * A mailer for a configuration (tests build one for a fake SMTP server; the server uses the one from the environment).
 * @param {ReturnType<typeof mailConfig>} m
 * @returns {Mailer}
 */
export function createMailer(m) {
  if (m.transport === 'log') {
    return {
      kind: 'log',
      async send(mail) {
        if (isProduction()) throw new Error('No mail server is set up (SMTP_HOST).');
        console.log(`[mail] (not sent: no SMTP_HOST) to ${mail.to} — ${mail.subject}\n${mail.text.replace(/^/gm, '    ')}`);
        return {};
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.tls === 'implicit',
    requireTLS: m.tls === 'starttls',
    ignoreTLS: m.tls === 'none',
    auth: m.user ? { user: m.user, pass: m.pass } : undefined,
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    logger: false,
  });
  return {
    kind: 'smtp',
    async send(mail) {
      const info = await transport.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text });
      return { id: info.messageId };
    },
  };
}

/** @type {Mailer | null} */
let current = null;

/** The server's mailer, built once from the environment. */
export const mailer = () => (current ??= createMailer(mailConfig()));

/**
 * Sends one plain-text email. Rejects with a sentence that names the stage that failed (connect, sign-in, the server's refusal)
 * and never a credential.
 * @param {Mail} mail
 */
export async function sendMail(mail) {
  try {
    return await mailer().send(mail);
  } catch (err) {
    throw new Error(describe(err), { cause: err });
  }
}

/** What went wrong, for the log: nodemailer's error code and the server's reply, without anything the client sent. */
function describe(err) {
  const e = /** @type {any} */ (err);
  const reply = typeof e?.response === 'string' ? ` (server said: ${e.response.replace(/\s+/g, ' ').trim().slice(0, 200)})` : '';
  switch (e?.code) {
    case 'ECONNECTION': case 'ETIMEDOUT': case 'ESOCKET': case 'EDNS': return `Could not reach the mail server${reply}.`;
    case 'EAUTH': return `The mail server refused the sign-in${reply}.`;
    case 'EENVELOPE': return `The mail server refused the sender or recipient${reply}.`;
    case 'EMESSAGE': return `The mail server refused the message${reply}.`;
    default: return `Sending the email failed${reply || (e?.message ? `: ${String(e.message).slice(0, 200)}` : '')}.`;
  }
}
