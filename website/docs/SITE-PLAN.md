# Remastly marketing site: plan

Light, warm, calm. One point per section, proved by a product mockup built in HTML/CSS (no screenshots).
Numbers only from the labelled example run on makememo.ai: Lighthouse 98–99 vs 91 original, visual difference under 1%, 15/15 hovers kept.

## Inventory (before the redesign)

| Route | File | Status |
| --- | --- | --- |
| `/` | `app/page.tsx` | Redesigned (old version in `_legacy/home-page.tsx.txt`) |
| `/features` | `app/features/page.tsx` | Redesign |
| `/how-it-works` | `app/how-it-works/page.tsx` | Redesign |
| `/report` | `app/report/page.tsx` | Redesign (linked from the footer) |
| `/pricing` | `app/pricing/page.tsx` | Redesign, no invented prices |
| `/faq` | `app/faq/page.tsx` | Redesign |
| `/contact` | `app/contact/page.tsx` | Redesign |
| 404 | `app/not-found.tsx` | Redesign |
| `/opengraph-image`, `/sitemap.xml`, `/robots.txt` | `app/*.ts(x)` | Update to the new look and routes |

Old components: Header, Footer, Logo, RevealObserver (kept and restyled); BeforeAfter, Blocks, ContactForm, CountUp, Gauge,
HowSteps, Plans, ReportMock, Shot, SiteMarquee, hero/CinematicHero (replaced). Old styles: `app/globals.css`, `app/visual.css` (replaced).

## Sitemap (after)

| Route | Purpose | Sections |
| --- | --- | --- |
| `/` | Explain Remastly in one short scroll and get a sign-up | Hero (3D stage: Paste → Audit → Fix → Rebuild) · Audit story (sticky, scroll-scrubbed) · Before/after wipe card · 4 stacks · Example run · Quick FAQ · Final CTA |
| `/features` | Everything the product does, by step | Page hero · Audit (8 checks + report mockup) · Fix & rebuild · Compare · Results · Fixed or flagged · Limitations · CTA |
| `/how-it-works` | The exact steps and timings | Page hero · 6-step guide with mockups · Tips · CTA |
| `/report` | The audit report | Page hero · Audit report mockup · Found / Fixed / Flagged · Two-page PDF mockup · Formats · CTA |
| `/pricing` | Plans without invented prices | Page hero · 3 plan cards (“Coming soon” / “Contact us”) · In every plan · Plan FAQ · CTA |
| `/faq` | Straight answers | Page hero · Accordion · Contact link |
| `/about` | Why Remastly exists and how it behaves | Page hero · Principles · Who it’s for · CTA |
| `/contact` | Reach the team | Page hero · Email card · Contact form (mailto) |
| `/auth` (`/signin`, `/signup` redirect here) | One frosted glass auth card on a cinematic light stage (no side image): Sign in / Sign up toggle, floating labels, validation; posts to `NEXT_PUBLIC_APP_URL`, otherwise “opens soon”. Opens as a full-viewport modal from any “Get started” link on desktop | Stage · card |
| `/privacy`, `/terms` | Legal (drafts with placeholders, need legal review) | Page hero · Prose |
| 404 | Recover | Message · Home link |

## Design system (single source of truth)

- Tokens, type, spacing, radii, shadows, base and UI primitives: `app/theme.css`.
- Layout and page styles: `app/site.css` (header, footer, hero stage, home sections) and `app/pages.css` (inner pages, auth card and dialog).
- Components in `components/ui/`: `Button`/`ButtonLink`, `Card`, `Section`, `SectionHead`, `PageHero`, `Badge`, `Field`/`PasswordField`,
  `FaqList`, `BrowserFrame`, `JsonLd`, `PointerEffects` (magnetic primary buttons, card glow), `IconList` (open rows/columns: icon + label + hairlines), `FloatField` (floating-label input).
- Cards only where they add meaning: the auth card, the hero stage, the audit/before-after mockups and the pricing plans. Everything else is open layout; never a card inside a card.
- Fonts: Instrument Serif (headlines, italic for one emphasised word) and Geist (everything else), via `next/font`.
- Motion: transform/opacity only. Scroll reveals (`data-reveal`); buttons: sheen, lift, press, magnetic pull; secondary: drawn border + fill; cards: lift + cursor glow; nav: gliding pill. Hover effects only on mouse/trackpad. 3D only in the home hero. Static under reduced motion.

## Global layout

- Header: logo · Features, How it works, Pricing, FAQ, About (gliding hover pill) · one “Get started” button (opens the auth modal). Sticky, frosted, mobile menu.
- Footer (light): Product / Company / Legal columns, small print.
