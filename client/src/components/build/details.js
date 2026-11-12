// The owner's details and photos in Build mode: one source for the form, the plan request and the facts the build gets. Mirrors
// server/src/buildmode/details.js (limits, labels, fact lines), so what the app sends is what the server accepts.

// The facts most sites need and only the owner knows. Name and phone are asked for before a new site is planned; each filled
// one is a fact the plan's copy and the build use as it is.
export const DETAIL_FIELDS = [
  { id: 'name', label: 'Business name', fact: 'Business name', placeholder: 'e.g. Trattoria Rosa', autoComplete: 'organization', max: 120, required: true },
  { id: 'phone', label: 'Phone', fact: 'Phone', placeholder: 'e.g. +91 98765 43210', inputMode: 'tel', autoComplete: 'tel', max: 40, required: true },
  { id: 'email', label: 'Email', fact: 'Email', placeholder: 'e.g. hello@yourbusiness.com', inputMode: 'email', autoComplete: 'email', max: 200 },
  { id: 'address', label: 'Address', fact: 'Address', placeholder: 'Street, area, city', autoComplete: 'street-address', max: 300 },
  { id: 'hours', label: 'Opening hours', fact: 'Opening hours', placeholder: 'e.g. Mon–Fri 12–11 pm, Sat–Sun 11 am–11 pm', wide: true, max: 300 },
  { id: 'more', label: 'Anything else', fact: 'More facts from the owner', placeholder: 'Prices, team names, year founded, social links, reviews you have…', multiline: true, wide: true, max: 2000 },
];
export const EMPTY_DETAILS = Object.fromEntries(DETAIL_FIELDS.map((f) => [f.id, '']));

export const IMAGE_RULES = { photos: 12, bytes: 8 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'], alt: 200 };
const IMAGE_FACTS = { photo: 'Photos from the owner', logo: 'Logo from the owner' };

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const digits = (text) => (text.match(/\d/g) ?? []).length;

/** The details as the plan request carries them: trimmed, empty ones left out. */
export function cleanDetails(details) {
  return Object.fromEntries(DETAIL_FIELDS.map((f) => [f.id, String(details?.[f.id] ?? '').trim()]).filter(([, v]) => v));
}

/** Whether one field holds something the server would refuse; the reason in the owner's words, or ''. */
export function fieldProblem(id, value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (id === 'email' && !EMAIL.test(text)) return 'That email address does not look right.';
  if (id === 'phone' && digits(text) < 5) return 'The phone number needs at least 5 digits.';
  return '';
}

/** Why the details are not ready for planning a new site, or null: name and phone are needed, the rest must be valid. */
export function detailsProblem(details) {
  if (!String(details?.name ?? '').trim()) return 'Give your business name to continue.';
  if (!String(details?.phone ?? '').trim()) return 'Give a phone number to continue.';
  const bad = DETAIL_FIELDS.map((f) => fieldProblem(f.id, details?.[f.id])).find(Boolean);
  return bad || null;
}

/** The photos and logo as the plan request names them (facts only, no files). */
export const imagesForPlan = (images) => images.map(({ role, alt }) => ({ role, alt: alt.trim() }));
/** The photos and logo as a build asks for them: the server copies these, by id, from the saved site. */
export const imagesForBuild = (images) => images.map(({ id, role, alt }) => ({ id, role, alt: alt.trim() }));

/** The owner's details and photos as fact lines, as the server writes them (server/src/buildmode/details.js ownerFacts). */
export function ownerFacts(details = {}, images = []) {
  const facts = DETAIL_FIELDS.filter((f) => details[f.id]).map((f) => `${f.fact}: ${details[f.id]}`);
  const photos = images.filter((i) => i.role === 'photo');
  const logo = images.find((i) => i.role === 'logo');
  const said = (alt) => (alt?.trim() ? `"${alt.trim()}"` : '(no description)');
  if (photos.length) facts.push(`${IMAGE_FACTS.photo}: ${photos.length} real photo${photos.length === 1 ? '' : 's'} for the site: ${photos.map((p, i) => `${i + 1}) ${said(p.alt)}`).join('; ')}`);
  if (logo) facts.push(`${IMAGE_FACTS.logo}: the business's own logo, ${said(logo.alt)}`);
  return facts;
}

/** The plan's facts with the owner's latest lines in place of any earlier line on the same subject. */
export function withOwnerFacts(facts, owner) {
  if (!owner.length) return facts ?? [];
  const labels = owner.map((f) => f.slice(0, f.indexOf(':') + 1).toLowerCase());
  return [...(facts ?? []).filter((f) => !labels.some((l) => String(f).toLowerCase().startsWith(l))), ...owner];
}

/** Images from a saved state, checked (states saved before photos existed have none). */
export function savedImages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i && typeof i.id === 'string' && (i.role === 'photo' || i.role === 'logo'))
    .map((i) => ({ id: i.id, role: i.role, alt: typeof i.alt === 'string' ? i.alt : '', width: i.width ?? null, height: i.height ?? null }));
}

/** The saved list matched to what the server holds: kept in its order, gone ones dropped, ones the state missed added. */
export function reconcileImages(list, stored) {
  const known = new Map(stored.map((s) => [s.id, s]));
  const kept = list.filter((i) => known.has(i.id));
  const listed = new Set(kept.map((i) => i.id));
  const missed = stored.filter((s) => !listed.has(s.id)).map((s) => ({ id: s.id, role: s.role, alt: '', width: s.width, height: s.height }));
  return [...kept, ...missed];
}
