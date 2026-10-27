// The homepage address check talks to the Remastly API through this one function. The API is not connected yet, so it
// always answers "not-connected": no lookup is made, nothing is sent anywhere, and no stack is ever invented.
// When the API exists, replace the body (keep the return type) and the UI's result state lights up.

export type SiteCheckResult =
  | { status: 'not-connected' }
  | { status: 'invalid' }
  | { status: 'error' }
  | { status: 'ok'; stack: { label: string; category: string }[] };

/** Normalises what a visitor typed into an http(s) address, or null when it is not one. */
export function normaliseAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.includes('.') ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function checkSite(input: string): Promise<SiteCheckResult> {
  if (!normaliseAddress(input)) return { status: 'invalid' };
  return { status: 'not-connected' };
}
