// @ts-check
// How many pages one copy may take. Kept apart from inputs.js (which opens the database) so the as-is page choice can use it.

// The most pages one recreate takes, also in "All pages" mode: a safety cap for sites with thousands of URLs. Links to pages
// beyond it get a local notice page, never the live site.
export const SITE_PAGE_CAP = 300;

/**
 * SAS_COPY_MAX_PAGES: the most pages one copy takes on this server, the homepage included (1–300), whatever the project's
 * setting ("All pages" too) or the as-is page choice asks for; a busy server keeps copies short with it. Unset or unreadable =
 * no cap below SITE_PAGE_CAP. An exact copy is of the whole site by definition and is not capped.
 * @returns {number | null}
 */
export function copyPageCap(env = process.env) {
  const raw = String(env.SAS_COPY_MAX_PAGES ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 1 && n <= SITE_PAGE_CAP ? n : null;
}
