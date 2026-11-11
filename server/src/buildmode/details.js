// @ts-check
// The owner's own facts about their business, given before the plan: the details form (name, phone, email, address, opening
// hours, anything else) and what is known of the photos and logo they added (never the images themselves). Checked here as
// plain text within limits, then turned into fact lines: the plan's two model steps read them as data (<owner_facts>), and the
// understanding's facts carry them to the build.
import { ContextError } from './context.js';

/** Each detail: the label its fact line starts with, and its longest length. */
export const DETAILS = {
  name: { label: 'Business name', max: 120 },
  phone: { label: 'Phone', max: 40 },
  email: { label: 'Email', max: 200 },
  address: { label: 'Address', max: 300 },
  hours: { label: 'Opening hours', max: 300 },
  more: { label: 'More facts from the owner', max: 2000, multiline: true },
};
export const IMAGE_FACTS = { photo: 'Photos from the owner', logo: 'Logo from the owner' };
export const MAX_PHOTOS = 12;
export const MAX_ALT = 200;
const ID = /^[0-9a-f-]{36}$/;
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** Plain text: control characters removed (line breaks kept only where the field has several lines), spaces tidied. */
export function plainText(/** @type {string} */ value, multiline = false) {
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, (c) => (c === '\t' ? ' ' : ''));
  return (multiline ? text.replace(/[ ]+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ')).trim();
}

/**
 * The details of a request, checked; {} when there are none. Unknown fields, values that are not text, text past its limit and
 * an email or phone that cannot be one are refused with a message the owner can act on.
 * @returns {Record<string, string>}
 */
export function checkDetails(/** @type {any} */ details) {
  if (details == null) return {};
  if (typeof details !== 'object' || Array.isArray(details)) throw new ContextError('"details" must be an object.');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    const field = DETAILS[/** @type {keyof typeof DETAILS} */ (key)];
    if (!field) throw new ContextError(`"details.${key}" is not a detail this form has.`);
    if (value == null) continue;
    if (typeof value !== 'string') throw new ContextError(`"details.${key}" must be text.`);
    const text = plainText(value, field.multiline);
    if (!text) continue;
    if (text.length > field.max) throw new ContextError(`${field.label} is longer than ${field.max} characters.`);
    out[key] = text;
  }
  if (out.email && !EMAIL.test(out.email)) throw new ContextError('That email address does not look right.');
  if (out.phone && (out.phone.match(/\d/g) ?? []).length < 5) throw new ContextError('The phone number needs at least 5 digits.');
  return out;
}

/**
 * The photos and logo a request names: [{ role, alt, id? }], checked. id is the stored image's (images.js); a plan needs none.
 * @returns {{ role: 'photo' | 'logo', alt: string, id?: string }[]}
 */
export function checkImageList(/** @type {any} */ images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new ContextError('"images" must be a list.');
  const out = images.map((img) => {
    if (!img || typeof img !== 'object' || !['photo', 'logo'].includes(img.role)) throw new ContextError('Every image needs a role: photo or logo.');
    if (img.alt != null && typeof img.alt !== 'string') throw new ContextError('An image description must be text.');
    if (img.id != null && (typeof img.id !== 'string' || !ID.test(img.id))) throw new ContextError('An image id is not valid.');
    const alt = plainText(img.alt ?? '');
    if (alt.length > MAX_ALT) throw new ContextError(`An image description is longer than ${MAX_ALT} characters.`);
    return { role: img.role, alt, ...(img.id && { id: img.id }) };
  });
  if (out.filter((i) => i.role === 'photo').length > MAX_PHOTOS) throw new ContextError(`At most ${MAX_PHOTOS} photos.`);
  if (out.filter((i) => i.role === 'logo').length > 1) throw new ContextError('At most one logo.');
  return out;
}

/** The owner's details and images as fact lines ("Business name: Trattoria Rosa"), in the form's order. */
export function ownerFacts(/** @type {Record<string, string>} */ details = {}, /** @type {{ role: string, alt: string }[]} */ images = []) {
  const facts = Object.entries(DETAILS).filter(([key]) => details[key]).map(([key, f]) => `${f.label}: ${details[key]}`);
  const photos = images.filter((i) => i.role === 'photo');
  const logo = images.find((i) => i.role === 'logo');
  const said = (/** @type {string} */ alt) => (alt ? `"${alt}"` : '(no description)');
  if (photos.length) facts.push(`${IMAGE_FACTS.photo}: ${photos.length} real photo${photos.length === 1 ? '' : 's'} for the site: ${photos.map((p, i) => `${i + 1}) ${said(p.alt)}`).join('; ')}`);
  if (logo) facts.push(`${IMAGE_FACTS.logo}: the business's own logo, ${said(logo.alt)}`);
  return facts;
}

/**
 * Facts with the owner's own lines in place of any earlier line on the same subject (one the model wrote, or the owner's before
 * they changed it): the owner's word is the latest.
 */
export function withOwnerFacts(/** @type {string[] | undefined} */ facts, /** @type {string[]} */ owner) {
  if (!owner.length) return facts ?? [];
  const labels = owner.map((f) => f.slice(0, f.indexOf(':') + 1).toLowerCase());
  return [...(facts ?? []).filter((f) => !labels.some((l) => String(f).toLowerCase().startsWith(l))), ...owner];
}
