// @ts-check
// The verification email, in two forms that say the same thing: plain text (what every client can show, and what a client with
// HTML off shows) and a small HTML page in the marketing site's light theme (its colours and type from remastly-website:
// #FAFAF7 base, white card, #111 ink, the orange only as an accent) with the Remastly logo at the top. The logo is the PNG in
// server/assets/mail (Gmail does not draw SVG), embedded as an inline attachment the HTML addresses as cid:… — the mail fetches
// nothing: no remote picture, no link, no tracking pixel. The PNG carries its own white card (padding, rounded corners), because a
// client in dark mode (the Gmail app among them) paints the mail's background black and ignores much of its CSS: dark ink on a
// transparent logo vanished there. The head also says the mail is light only, for the clients that listen.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODE_ATTEMPTS, CODE_MINUTES } from './policy.js';

export const PRODUCT = 'Remastly';
export const SUBJECT = `Your ${PRODUCT} verification code`;
export const LOGO_CID = 'remastly-logo@remastly';

const LOGO_FILE = fileURLToPath(new URL('../../assets/mail/remastly-logo.png', import.meta.url));
/** Read once; 416 × 104 px (the 360 × 63 logo on its white card), drawn at half size so it stays sharp on dense screens. */
const LOGO_PNG = readFileSync(LOGO_FILE);
const LOGO_WIDTH = 208;
const LOGO_HEIGHT = 52;

// The site's theme (app/theme.css + lib/accent.ts of remastly-website), as literal colours: email clients read no custom properties.
const C = { bg: '#fafaf7', card: '#ffffff', line: '#e8e6e0', codeBg: '#f6f5f1', text: '#111111', text2: '#3d3c38', muted: '#6b6a65', accent: '#c2410c' };
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The sentences both forms share, so the text and the HTML never drift apart. */
function lines(code) {
  return {
    intro: 'Here is the code to confirm your email address. Enter it on the page where you created your account.',
    code,
    expires: `This code expires in ${CODE_MINUTES} minutes.`,
    tries: `It can be tried ${CODE_ATTEMPTS} times and cannot be re-sent: if it expires, create the account again with the same email address to get a new one.`,
    ignore: `If you didn't sign up for ${PRODUCT}, you can ignore this email.`,
  };
}

/** @param {ReturnType<typeof lines>} l */
function textOf(l) {
  return [
    `Your ${PRODUCT} verification code`,
    '',
    l.intro,
    '',
    `    ${l.code}`,
    '',
    l.expires,
    l.tries,
    '',
    l.ignore,
  ].join('\n');
}

/** @param {ReturnType<typeof lines>} l */
function htmlOf(l) {
  const p = (text, extra = '') => `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.text2};${extra}">${escapeHtml(text)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(SUBJECT)}</title>
<style>:root{color-scheme:light only;supported-color-schemes:light;}</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.bg};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:480px;">
<tr><td style="padding:0 4px 20px;">
  <img src="cid:${LOGO_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="${PRODUCT}" style="display:block;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;outline:none;">
</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-top:3px solid ${C.accent};border-radius:14px;padding:32px 32px 26px;">
  <h1 style="margin:0 0 12px;font-family:${SANS};font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${C.text};">Your verification code</h1>
  ${p(l.intro)}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 20px;">
  <tr><td align="center" style="background:${C.codeBg};border:1px solid ${C.line};border-radius:10px;padding:18px 16px;">
    <div style="font-family:${MONO};font-size:36px;line-height:1.2;font-weight:700;letter-spacing:0.3em;padding-left:0.3em;color:${C.text};" aria-label="Verification code">${escapeHtml(l.code)}</div>
  </td></tr>
  </table>
  ${p(l.expires, `color:${C.text};font-weight:600;`)}
  ${p(l.tries, `font-size:13px;color:${C.muted};`)}
  <hr style="border:0;border-top:1px solid ${C.line};margin:20px 0 16px;">
  ${p(l.ignore, `margin:0;font-size:13px;color:${C.muted};`)}
</td></tr>
<tr><td style="padding:18px 4px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.muted};">
  ${escapeHtml(PRODUCT)} &middot; This email was sent because this address was used to create a ${escapeHtml(PRODUCT)} account.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/**
 * The verification email for a user and the six-digit code just created for them.
 * @param {{ email: string }} user
 * @param {string} code
 * @returns {import('../mail.js').Mail}
 */
export function verificationMail(user, code) {
  const l = lines(code);
  return {
    to: user.email,
    subject: SUBJECT,
    text: textOf(l),
    html: htmlOf(l),
    attachments: [{ filename: 'remastly-logo.png', content: LOGO_PNG, contentType: 'image/png', cid: LOGO_CID }],
  };
}
