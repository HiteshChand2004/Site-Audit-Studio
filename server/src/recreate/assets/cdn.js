// Platform CDN hosts come from the detection rules (`cleanup.cdnHosts` in rules/<platform>.json),
// so a new platform file also teaches Recreate its CDN. The recreated site must not reference any
// of them: every asset is downloaded, or left out and reported.
import { RULES } from '../../detection/engine.js';

export const PLATFORM_CDN_HOSTS = [...new Set(RULES.flatMap((r) => r.cleanup?.cdnHosts ?? []).map((h) => h.toLowerCase()))];

/** The matching platform CDN host (the host itself or a parent domain), or null. */
export function platformCdnHost(url, hosts = PLATFORM_CDN_HOSTS) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return hosts.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
}

/**
 * Platform CDN URLs found in a text (HTML, CSS, JS, JSON). The build step uses it to prove the
 * generated site is free of them.
 * @returns {string[]} unique URLs
 */
export function findPlatformCdnRefs(text, hosts = PLATFORM_CDN_HOSTS) {
  const found = new Set();
  for (const m of String(text).matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?[^\s"'()<>\\]*/gi)) {
    const url = m[0].startsWith('//') ? `https:${m[0]}` : m[0];
    if (platformCdnHost(url, hosts)) found.add(url);
  }
  return [...found];
}
