// @ts-check
// One test email through the server's own mail module and settings (server/.env): `npm run mail:test -w server -- <address>`.
// It is the real verification email (accounts/verificationMail.js: HTML with the inline logo + the plain-text alternative) with a
// random code, so what arrives is what a new account gets; the code is printed here and means nothing to the server.
// Exactly one recipient, given on the command line; nothing is read from the database. Prints the mail settings as the server
// logs them (never the password) and the result. Exit 1 on any refusal or failure.
import { randomInt } from 'node:crypto';
import { mailConfig, mailProblems } from '../src/config/index.js';
import { sendMail } from '../src/mail.js';
import { verificationMail } from '../src/accounts/verificationMail.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (args.length !== 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args[0])) {
  console.error('Usage: npm run mail:test -w server -- <one email address>');
  process.exit(1);
}
const [to] = args;
const m = mailConfig();
const problems = mailProblems();
if (m.transport !== 'smtp') problems.unshift('SMTP_HOST is not set in server/.env: there is nothing to send with.');
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`Mail: SMTP ${m.host}:${m.port} (${m.tls === 'implicit' ? 'TLS' : m.tls === 'starttls' ? 'STARTTLS' : 'no TLS, local relay'})${m.user ? ` as ${m.user}` : ''}, from ${m.from}.`);
const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
const mail = verificationMail({ email: to }, code);
console.log(`Sending one test email to ${to}: "${mail.subject}", sample code ${code} (not a real code) ...`);
try {
  const { id } = await sendMail(mail);
  console.log(`Sent${id ? ` (message id ${id})` : ''}.`);
} catch (err) {
  console.error(`Not sent: ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}
