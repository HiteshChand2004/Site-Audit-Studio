// Blog posts from Botza CMS (read-only public API). Server only: the token is never sent to the browser.
// Env: BOTZA_CMS_API_URL, BOTZA_CMS_API_TOKEN, BOTZA_CMS_COLLECTION_SLUG. When any is missing, the Media page shows
// "no posts yet" instead of failing the build.

/** Seconds a fetched response is reused. Image URLs are signed S3 links that expire, so this stays short. */
export const CMS_REVALIDATE = 300;

export type CmsImage = { id: string; url: string; mimeType?: string; originalFileName?: string; objectPosition?: string };

export type Post = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  type: string;
  author: string;
  /** ISO date shown on the page: the editor's `date`, else `publishedAt`. */
  date: string;
  updatedAt: string;
  img: CmsImage | null;
  /** Set when the post lives on another site: the card links there and no page is made here. */
  externalUrl: string | null;
  /** Rich text as HTML. */
  content: string;
};

const BASE = (process.env.BOTZA_CMS_API_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.BOTZA_CMS_API_TOKEN ?? '';
const COLLECTION = process.env.BOTZA_CMS_COLLECTION_SLUG ?? '';

export const cmsConfigured = Boolean(BASE && TOKEN && COLLECTION);

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function toImage(v: unknown): CmsImage | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Raw;
  return typeof o.url === 'string' && o.url ? { id: str(o.id), url: o.url, mimeType: str(o.mimeType), originalFileName: str(o.originalFileName), objectPosition: str(o.objectPosition) || '50% 50%' } : null;
}

function toPost(r: Raw): Post {
  const original = str(r.originalurl);
  return {
    id: str(r.id),
    slug: str(r.slug),
    title: str(r.title) || 'Untitled',
    excerpt: str(r.excerpt),
    type: str(r.type),
    author: str(r.author),
    date: str(r.date) || str(r.publishedAt),
    updatedAt: str(r.updatedAt) || str(r.publishedAt),
    img: toImage(r.img),
    externalUrl: r.external === true && /^https?:\/\//i.test(original) ? original : null,
    content: str(r.content),
  };
}

async function cmsGet(params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams({ includeAssetUrls: 'true', ...params });
  return fetch(`${BASE}/${COLLECTION}?${qs}`, { headers: { 'X-API-Token': TOKEN }, next: { revalidate: CMS_REVALIDATE, tags: ['cms'] } });
}

/** Every published post, newest first. Returns [] when the CMS is not configured or cannot be reached. */
export async function getPosts(): Promise<Post[]> {
  if (!cmsConfigured) return [];
  const posts: Post[] = [];
  try {
    for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
      const res = await cmsGet({ page: String(page), limit: '100', sort: 'publishedAt' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Raw[]; pagination?: { totalPages?: number } };
      posts.push(...(body.data ?? []).map(toPost));
      pages = body.pagination?.totalPages ?? 1;
    }
  } catch (err) {
    console.error('[cms] could not load posts:', err);
    return [];
  }
  return posts.filter((p) => p.slug).sort((a, b) => b.date.localeCompare(a.date));
}

/** One post by slug, or null when there is none. Throws when the CMS fails, so a cached page is kept instead of a 404. */
export async function getPost(slug: string): Promise<Post | null> {
  if (!cmsConfigured || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  const res = await cmsGet({ slug });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`[cms] post "${slug}": HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Raw | null };
  return body.data ? toPost(body.data) : null;
}

/** "21 Nov 2026" */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
