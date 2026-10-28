# Remastly marketing site: handoff

State as of 2026-10-19. This file is the source of truth; `docs/SITE-PLAN.md` is the original plan and is partly
out of date (How it works is now a clock, Contact is the open layout, the auth card has labels above the fields).

Repo: https://github.com/HiteshChand2004/remastly-website (branch `main`).

## Run it

- Next.js 16.4 (App Router), React 19, TypeScript, GSAP 3.13 (with ScrollTrigger), lucide-react. No other UI libs.
- `npm install`, then `npx next dev -p 3000` → http://localhost:3000 (the dev server has always run on port 3000).
- `npx tsc --noEmit -p .` passes. **`npm run build` has never been run** (see Phase 6).
- Read `AGENTS.md`: this Next version differs from older ones; check `node_modules/next/dist/docs/` before using APIs.
- Env (see `.env.example`): `NEXT_PUBLIC_APP_URL` (auth forms post here; empty = "Sign-in opens soon"), `SITE_URL`.

## Working rules agreed with the owner

- **Machine is busy:** until the owner says **"machine is free"**: no Playwright, no screenshots, no `npm run build`,
  no Lighthouse. Only the dev server on port 3000. Never touch the `Website-Audit-exact` folder's running servers or
  ports 4000/5173.
- **`C:\Users\urvas\Downloads\Website-Audit-exact` is the tool itself and is READ-ONLY.** Only read its saved runs in
  `data/` (Phase 6). Never edit, create or delete anything there, never run its scripts or git.
- **Numbers:** none are shown right now. `lib/content.ts` → `exampleRun` has status 'pending' and every run figure null; each
  component shows a dash or "Example run to come". Fill it only from ONE real, complete run (`data/example-runs.json`, never mix
  runs), then set status 'ready'. The old "91 → 98–99" example was wrong (three runs mixed). Never invent stats,
  testimonials, logos or prices. Illustrations show status words, not scores.
- **Audit labels:** broken links and console errors are always **"Flagged for you"**, never "Fixed" (the tool keeps
  broken links deliberately). Settled; don't ask again. Only items in `FIXABLE` may be shown as "Fixed in your copy".
- **Images:** only the owner's own sites (nyaayai, parchaa, indikaai, collateral.panscience.ai, panscience.xyz), max
  1–2 on the site. Currently **none** are used; everything is an HTML/CSS mockup. `public/images/*` is unused.
- Owner writes in Hinglish; replies were in English. Keep the light theme only. Keep `_legacy/` until told to delete.

## Design system

- **Fonts** (`app/layout.tsx`, next/font): Instrument Serif (headlines; italic for one emphasised word) + Geist.
- **Tokens and primitives:** `app/theme.css` (colours #FAFAF7 / white / #111 / orange `#c2410c` as accent only,
  type scale, spacing, radii, shadows, buttons, cards, badges, fields, FAQ, browser frame, reveal, reduced motion).
- **Layout/pages:** `app/site.css` (header, footer, home hero + sections), `app/pages.css` (inner pages, auth),
  `app/visuals.css` (Features visuals, the How it works clock).
- **Components:** `components/ui/` (Button/ButtonLink, Card, Section/SectionHead/PageHero, Badge, Field,
  PasswordField, TextField, FaqList, BrowserFrame, IconList, JsonLd, PointerEffects, InViewPlay).
- **Decisions:**
  - Cards only for: auth card, hero stage, audit/before-after mockups, pricing plans. Everything else is open layout
    (icon + label + whitespace); never a card inside a card.
  - No section divider lines on inner pages (soft tint gradients instead). **The home page keeps its thin dividers**
    (`.home` wrapper; uses `:has()`, ignored by Firefox < 121).
  - Motion: transform/opacity only; hover effects only on mouse/trackpad; everything static under reduced motion;
    looping CSS visuals pause off screen (`[data-loop]` + `InViewPlay`). 3D only in the home hero.
  - Short, confident copy. The owner first asked for much less text, later for "a bit more within existing elements".

## Pages (all return 200; 404 page works)

| Route | What's there |
| --- | --- |
| `/` | Hero ("Paste a link. Get a *better* site.") with the 3D GSAP stage: URL centred → glides up → audit → fix → rebuild copy; 4-step rail (Paste · Audit · Fix · Rebuild); speed `SPEED = 1.4` in `components/hero/timeline.ts`. Audit → Fix → Rebuild story (rail + one visual, sticky + scroll-scrubbed on desktop). Before/after wipe card. 4 stacks tabs with file trees and run commands (auto-cycle). Example run (open layout, count-up). Quick FAQ. "Paste your address" CTA form → `/auth`. |
| `/features` | Split hero (headline + buttons; two real app screenshots layered, `f-glance` + `f-speed`), then a 3 × 3 grid of same-size cards: eight capabilities, each with a drawn app piece on top (`components/how/Mocks.tsx`: audit list, kept chips, fixes, stack picker with logos, compare with the real indikaai original/copy (exact copy mode, labelled), report, zip, private preview), and a dark "Check my site" card, then honest limits. Styles: `app/tour.css` (`fx-`, `mk-`). |
| `/how-it-works` | Interactive stepper (`components/how/Journey.tsx`): six steps on the left, an app window on the right showing a drawing of that step; plays through on its own until clicked, stops under reduced motion. Then "Inside a run" (dark), tips. Styles: `app/tour.css` (`hw-`). |
| `/report` | Compact audit report mockup, Found / Fixed / Flagged columns, two-page PDF mockup + formats. |
| `/pricing` | 3 plans, all "Price coming soon" + "Contact us"; what's in every plan; plan FAQ. |
| `/faq`, `/about` | FAQ accordion (`lib/content.ts` → `FAQS`); About: four promises + audiences. |
| Inner page heroes | How it works, Pricing, FAQ, About and Audit report pass `art` to `PageHero` (split layout): `components/ui/HeroArt.tsx` (`HeroArt` = main + overlapping overlay + glow; `HeroShot` = framed real picture with optional window bar, zoom, trim), styles in `app/hero-art.css`. Pictures: h-add + zip (how), collateral features-page copy + stack picker (pricing), botza original/copy labelled standard mode (FAQ), botza/panscience/indikaai-mid fanned (about); contact uses panscience.xyz. Each hero shows a different site, f-needs + f-overview (report). Drawn overlays hide under 600px. |
| Contact, Get started, About | Contact: hero art (botza copy + message note), side column + form laid out on the page (`app/contact.css`, `ct-`); the form opens mailto when `NEXT_PUBLIC_CONTACT_EMAIL` is set, otherwise says nothing was sent. Get started: `/auth` is a simple page, just the form centred, no card and no pictures (`AuthCard plain`, `app/authpage.css`); the desktop modal (`AuthDialog`) is no longer mounted in `app/layout.tsx`. About "How it behaves": collateral live site + copy (exact copy mode) replace the empty AI image slot. |
| Scroll on navigation | `components/ScrollManager.tsx` (mounted in `app/layout.tsx`, plus `data-scroll-behavior="smooth"` on `<html>`): a link to another page opens it at the top; a link with `#section` (e.g. `/#check`) opens that section; Back/Forward keep the restored position. Needed because Next 16 keeps the scroll position when the new page is already in view. |
| `/contact` | Page hero, email + "Helpful to include", form that opens the visitor's email app (no backend). |
| `/auth` | Sign in / Sign up glass card on a light "aurora" stage: typographic "Sign in · Sign up" switch, labels above fields, example placeholders, validation, posts to `NEXT_PUBLIC_APP_URL` or shows "opens soon". `/signin` and `/signup` redirect here (307, `next.config.mjs`). On desktop every `/auth` link opens it as a full-screen modal (`components/auth/AuthDialog.tsx`). |
| `/privacy`, `/terms` | Drafts with `[BRACKETED]` placeholders and a visible "draft for review" note. |

Header: Features · How it works · Pricing · FAQ · About (gliding hover pill) + one "Get started" button.

## Pending

### Phase 6 (only after the owner says "machine is free")

1. Playwright screenshots of every page at 1440 and 390 width; look at them and fix anything ugly, cramped,
   overflowing, misaligned or low-contrast. Repeat until clean. Specifically check: hero card footers and the step
   rail, the home audit story at 1366×768, the How it works dial (never seen in a real browser), the auth card height
   on 1366×768 (estimated ~600px in the modal, ~650px on the page), phone layouts.
2. Console errors = 0 on every page, all links work, keyboard navigation works (tabs, dialog, accordion, sliders).
3. `npm run build` passes, then Lighthouse on home + one inner page (target 90+ on all four scores); fix and re-check.
4. **Real numbers / example-run switcher:** read (read-only!) the saved runs in `Website-Audit-exact/data` for
   makememo.ai, nyaayai, parchaa, indikaai, collateral.panscience.ai, panscience.xyz. Use only sites with complete
   numbers (Lighthouse before/after, visual difference, hovers/clicks kept, audit category scores). Replace the
   single makememo example (`components/home/ExampleRun.tsx`) with tabs/chips "Example run · <site>"; use real
   per-category scores in the audit visuals only if they exist, otherwise keep status words. Never estimate or fill
   gaps; report which sites made it in and why others didn't.

How earlier work was verified without a browser: the hero and story timelines were stepped through in jsdom with
the real SSR HTML (scripts lived in a temp scratchpad, not in the repo). Recreate if needed.

### Inputs needed from the owner

- Real contact email (`lib/site.ts` → `CONTACT_EMAIL`, currently `[YOUR EMAIL]`).
- `NEXT_PUBLIC_APP_URL` of the Remastly app (auth forms) and the production `SITE_URL`.
- Legal: company legal name, address, dates, hosting provider, retention periods, processors, liability, governing
  law (`app/privacy/page.tsx`, `app/terms/page.tsx`); then legal review.
- Prices per plan (or confirm "coming soon"); website limits for Team/Agency.
- Confirm the stack file trees and run commands in `components/home/StackTabs.tsx` match the tool's real output, and
  the FAQ hosting answer (React/Next/MERN need hosting that runs them).
- Whether to delete `_legacy/` and the unused `public/images/*`; whether to keep `.env.example` in git.
- Whether the remaining "Remastly is built by …" / company naming should appear anywhere (currently it doesn't).

## Key files

- Content and facts: `lib/content.ts` (STEPS, AREAS, STACKS, FIXABLE, NEEDS_A_PERSON, LIMITS, AUDIENCES,
  EXAMPLE_RUN, FAQS), `lib/site.ts` (nav, footer, URLs, contact email).
- Hero: `components/hero/HeroStage.tsx` + `timeline.ts`. Home story: `components/home/AuditStory.tsx` +
  `storyTimeline.ts`. Other home pieces: `CompareWipe.tsx`, `StackTabs.tsx`, `ExampleRun.tsx`, `SiteMock.tsx`.
- Auth: `components/auth/*`, `components/ui/TextField.tsx`, `app/auth/page.tsx`.
