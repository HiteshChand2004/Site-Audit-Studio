---
id: search-and-ai-search-technical-rules
kind: growth
version: 1
title: Growth OS playbook: Search (SEO) and AI-search (GEO/AEO) technical rules
---
**SEO, MUST:**
- A self-referencing **canonical** tag on every page (missing canonicals triggered Google's "Duplicate without user-selected canonical").
- Every page in the **sitemap** with a last-modified date.
- **Redirects for retired URLs at the server/config level** (301/308 with a Location header). Never redirect inside the page code; Google reports in-page redirects as "Redirect error".
- Every old URL that ever existed (including links on directories, e.g. `/pricing` from an F6S listing) redirects to the closest live page. No 404s for known URLs.
- JSON-LD schema: `Organization` (legal name, founding date, address, `areaServed`, `sameAs` social links, `knowsAbout`), `Service` on offer pages, `FAQPage` where there is an FAQ, `Article` on guides.
- Titles ≤ 60 characters, query first; unique meta descriptions (≤ 155 characters, answer + action).
- **Social share previews** (Open Graph + Twitter card) on every page, with a default image when a page has none.
- **Internal links:** every solution page links to its related use-case pages and guides ("related pages"), and every guide links back to its solution page. The footer links all landing pages.
- **Image alt text** describing what the image shows; meaningful file names.
- **One H1 per page**; headings in order (H2, H3).
- **`robots.txt`**: allow all public pages, point to the sitemap, block only private paths (`/api/`, admin).
- **Sitemap `lastmod`** updated whenever a page changes, so Google re-crawls it.
- **Guides/articles** carry `Article` + `FAQPage` schema and a "last updated" date.
- **IndexNow** (recommended): notify Bing on publish/update.

**AI search (GEO/AEO), MUST:**
- **Keep all text in the served HTML.** Collapsed FAQ answers use the `hidden` attribute, not conditional rendering, because AI crawlers often do not run JavaScript.
- Publish **`/llms.txt`**: one line per page with buyer + problem + URL. Also generate **`/llms-full.txt`** (every page's answer, entity line and FAQs) by a script from the content files, re-run on every content change; warn on FAQ answers over 60 words.
- Allow AI crawlers in `robots.txt` unless the venture decides otherwise:

```
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: *
Allow: /
Disallow: /api/
Sitemap: https://example.com/sitemap.xml
```
- **Organization schema** with `sameAs` (LinkedIn, parent company site) and `knowsAbout` (the topics the venture should be known for), so AI assistants link the brand to its topics.
- **Answer the long questions buyers ask AI assistants** (e.g. "which companies provide X in India?") in guides and FAQs, in plain sentences that can be quoted.
- **Get listed where AI assistants look:** the "top 10" articles, review sites (G2, Clutch) and directories that already rank for the venture's topics. AI answers quote these pages; track which ones with the AI-search tracker.
- Each offer page carries the 40–60-word entity paragraph and short, quotable answers.

**Evidence:** after this layer, AI assistants appeared as a traffic source (1 → 5 visits in a week), and one inbound lead (PR Metal Alloys) came directly from a ChatGPT answer. Long sentence-style searches (AI assistants searching Google for a buyer) showed our pages at positions 1–7.
