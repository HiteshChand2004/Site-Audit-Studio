---
id: launch-checklist
kind: growth
version: 1
title: Growth OS playbook: Launch checklist (all MUST pass)
---
**Content and trust**
- [ ] Every number, client, certification traced to the claims registry
- [ ] Brand facts identical on site, schema and social profiles
- [ ] Every press/media logo links to a real article
- [ ] One primary CTA, same wording everywhere

**Pages**
- [ ] One landing page per paid-search intent; H1 matches the ad phrase
- [ ] Answer paragraph, first-screen proof, form above the fold on ad pages
- [ ] FAQ with real search questions; answers ≤ 60 words
- [ ] Titles ≤ 60 chars, query first

**Forms and leads**
- [ ] Short form + one qualifying question + honeypot
- [ ] Test lead reaches the lead sheet with source, campaign, landing page and gclid
- [ ] Fake lead without the server secret is refused
- [ ] Internal alert email sent from a company domain
- [ ] Non-buyer forms (newsletter, partner, careers) fire their own events, not `generate_lead`
- [ ] Clicking a phone, email or WhatsApp link fires `phone_click` / `email_click` / `whatsapp_click` (seen in GA4 DebugView)
- [ ] Lead sheet has a way to log calls/emails by hand, including "How did you find us?" and a "Not qualified" status

**Tracking (built by Remastly)**
- [ ] Analytics component installed in the root layout; GTM ID from env
- [ ] GTM loads on the live domain only; GA4 receives `page_view` and `generate_lead`
- [ ] `generate_lead` is the only GA4 key event and the only ad conversion
- [ ] Internal traffic flag works (`?internal=1`)
- [ ] Consent mode correct per region; privacy policy lists every tool

**Accounts (set up by a person, section 7.2)**
- [ ] GTM container published; GA4 property with `generate_lead` as the only key event, internal-traffic filter active, retention 14 months
- [ ] Search Console verified, sitemap submitted
- [ ] Bing Webmaster Tools imported from Search Console, sitemap submitted
- [ ] Clarity recording
- [ ] Google Ads linked to GA4 with `generate_lead` imported (if ads planned)
- [ ] One company login + a second admin on every account

**Technical**
- [ ] Canonical on every page; sitemap complete
- [ ] All retired/known URLs redirect at server level; no 404s
- [ ] JSON-LD valid (Organization, Service, FAQPage, Article) in the Rich Results Test
- [ ] Social previews on every page; internal links between solution, use-case and guide pages
- [ ] `llms.txt` and `llms-full.txt` published; AI crawlers allowed in `robots.txt`
- [ ] Lighthouse mobile ≥ 60 home, ≥ 70 landing pages; no overflow at 390 px
