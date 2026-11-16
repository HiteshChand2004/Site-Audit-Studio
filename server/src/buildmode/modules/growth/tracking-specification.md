---
id: tracking-specification
kind: growth
version: 1
title: Growth OS playbook: Tracking specification
---
### 7.1 What Remastly MUST build into the code

1. **Install Google Tag Manager on every page** through one component loaded in the root layout. The GTM ID comes from an environment variable (e.g. `NEXT_PUBLIC_GTM_ID`); if it is empty, no tags load.

```js
// Analytics component (root layout). Loads GTM only on live hosts.
const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID;
const LIVE_HOSTS = ["example.com", "www.example.com"]; // the venture's live domains
export function trackEvent(event, params = {}) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event, ...params });
}
// On mount: if GTM_ID && LIVE_HOSTS.includes(location.hostname) && !internal flag:
//   inject https://www.googletagmanager.com/gtm.js?id=GTM_ID (async) once, id="gtm-loader"
// ?internal=1 → localStorage flag + traffic_type=internal ; ?internal=0 clears it
```

2. **Push the events in the table below** from the forms and CTAs (`trackEvent("generate_lead", { form_name, form_context })` only after the server confirms success).
3. **Capture attribution** (UTM, gclid, li_fat_id, landing page, first touch) and send it with every form.
4. **Consent component** per section 7 rules, and a "Cookie settings" link in the footer.
5. **Verification tag slot:** a place for the Google Search Console and Bing Webmaster verification `<meta>` tags (values from env), in case DNS verification is not possible.

### 7.2 What a person MUST set up (Remastly cannot): Day-1 accounts, all free

Use **one company login** for all tools across ventures (one consolidated view), and add **a second admin** from the venture team on every account, so access never depends on one person.

| Tool | Cost | Set up | Why |
|---|---|---|---|
| **Google Tag Manager** | Free | Create container → add GA4 tag (all pages) + GA4 event tags for `generate_lead` and the other events → publish | One place for all tags |
| **Google Analytics 4** | Free | Property in the venture's time zone and currency → data stream → mark **`generate_lead` as the only key event** → define internal traffic (`traffic_type=internal`) and activate the filter → data retention 14 months | Visitors, sources, leads |
| **Google Search Console** | Free | Add domain property (DNS) or URL prefix (meta tag / GA) → **submit sitemap** → check Page indexing weekly → "Validate fix" after fixes | Which searches show the site, position, indexing errors |
| **Bing Webmaster Tools** | Free | Import from Search Console (one click) → submit sitemap → enable IndexNow | Bing index feeds Microsoft Copilot and several AI assistants *(recommended; not yet measured on our sites)* |
| **Microsoft Clarity** | Free | Project for the domain → install through GTM | Session recordings, heatmaps, rage/dead clicks, quick-backs |
| **Google Ads** (only if ads planned) | Free account; pay per click | Venture's own billing → link GA4 → import `generate_lead` as the conversion → Keyword Planner for search demand and prices | Paid search + demand research |
| **Google Keyword Planner** | Free (inside Google Ads) | Pull search volumes and top-of-page bids for the brief's phrases | Chooses page titles and which pages to build |
| **LinkedIn Insight Tag** (B2B, if LinkedIn ads planned) | Free tag | Install via GTM; set lead conversion | LinkedIn audiences and conversions |
| **Company-visit tool** (B2B) | Free tier (e.g. Dealfront/Leadfeeder) | Install via GTM | Which companies visit |
| **PageSpeed Insights / Lighthouse** | Free | Test home and each landing page | Speed targets in section 9 |
| **Google Rich Results Test / Schema validator** | Free | Test each page type | Checks the JSON-LD |
| **Google Ads Transparency Center, LinkedIn Ad Library** | Free | Look up competitors | What rivals pay for |

### 7.3 Tag Manager rules

**Container:** all tags load through Google Tag Manager. The site code only pushes events to `dataLayer`.

**MUST load tracking only on the live domain(s)** (not on staging or localhost), so test traffic never pollutes data.

**Internal traffic:** visiting `?internal=1` once marks a browser as internal (GA4 `traffic_type=internal`, filtered out); `?internal=0` clears it. Every team member does this once.

**Events:**

| Event | When | Parameters | Counts as lead? |
|---|---|---|---|
| `page_view` | Every page | (default) | No |
| `form_start` | First focus on a buyer form | `form_name` | No (diagnostic) |
| `generate_lead` | Buyer form submitted successfully | `form_name`, `form_context` (the page/offer) | **Yes: the only key event / ad conversion** |
| `newsletter_signup` | Newsletter form | `form_name` | No |
| `partner_enquiry` | Partner form | `form_name` | No |
| `expert_application` / `careers_application` | Job/expert forms | `form_name` | No |
| `cta_click` | Any primary CTA click | `cta_location` | No |
| `phone_click` / `email_click` / `whatsapp_click` | Click on any `tel:`, `mailto:` or WhatsApp link (one document-level listener, so future links are covered) | `contact_method`, `link_location`, `page_path` | No (diagnostic). Real calls are logged as leads by hand (below) |

**Attribution capture (no personal data pushed to analytics):**
- Store UTM tags, `gclid`, `li_fat_id`, landing page for the session; first touch for 90 days (with consent where required).
- Send these with every form submission so each lead knows which ad, phrase and page produced it.
- `gclid` is required later to send "this lead became a qualified meeting" back to Google Ads (offline conversions).

**Consent:** notice mode (measure from first view, with Accept and Manage preferences) for India, US and non-European visitors; strict opt-in with an equal-size Reject button for Europe. Describe every tool in the privacy policy. Do not let chat widgets cover the consent buttons.

**Tool set per venture:** GTM, GA4 (key event = `generate_lead` only), Google Search Console (verify on day one), Microsoft Clarity (session recordings), Google Ads conversion linked to GA4, LinkedIn Insight Tag if LinkedIn ads are planned, a company-visit tool (e.g. Dealfront/Leadfeeder) for B2B.

**Reading the data correctly:** visits from data-centre cities (Ashburn, Singapore) with 0–5 seconds on site are bots. In 30 days, Singapore sent 21 "visitors" at 0 seconds while real Indian buyers stayed 1–2 minutes. Reports SHOULD offer a "real visitors" view excluding these.
