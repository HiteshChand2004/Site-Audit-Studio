# Remastly website

Marketing website for **Remastly**, built with Next.js (App Router). All pages are static.

## Run it

```bash
npm install
npm run build
npm start          # production server on http://localhost:3000
```

For editing with live reload: `npm run dev` (also http://localhost:3000).

When you deploy, set `SITE_URL` to the real domain (for example `SITE_URL=https://remastly.com npm run build`) so canonical URLs, the sitemap, robots.txt and link previews use it.

## Pages

| Route | What's on it |
| --- | --- |
| `/` | Hero story in one 8-second timeline (URL typed, site scanned, layers, rebuilt, side by side; Replay button), problem and solution, the 4 steps (highlighted as you scroll), feature tiles with the real screens, before/after slider, Full report (dark band), technologies, real results, who it's for, honest limits, pricing, FAQ link, call to action |
| `/features` | Check, Create the copy, Compare, Results & download in detail; technologies; what's fixed vs "Needs a person"; Exact copy (Coming soon); all limitations (`#limitations`) |
| `/how-it-works` | Six-step guide with timings and tips |
| `/report` | The Full report: real example, speed bars, checklist donut, what's on page 1 and 2, formats |
| `/pricing` | Starter / Team / Agency, what every plan includes, pricing questions |
| `/faq` | Questions and answers (with FAQ structured data) |
| `/contact` | Email address and a form that opens the visitor's email app |

Also `sitemap.xml`, `robots.txt`, the link-preview image (`app/opengraph-image.tsx`), the favicon (`app/icon.svg`) and a 404 page.

## Placeholders to fill in

| Placeholder | Where |
| --- | --- |
| `[YOUR EMAIL]` | `lib/site.ts` (`CONTACT_EMAIL`): used on the contact page, footer and contact form |
| `[PRICE]` | `components/Plans.tsx` |
| `[NUMBER]` (websites per plan) | `components/Plans.tsx` |
| `[ANSWER: …]` (2 pricing questions) | `app/pricing/page.tsx` (`PRICING_FAQ`) |

## Images

All images are in `public/images/`, converted to WebP at the size they are shown. `next/image` serves AVIF or WebP from them. Only sites the owner has authorised are used. Balance rule: nyaayai is used at most twice (hero, and one tile in the rebuilt-sites strip); the other sites are spread across the rest.

| File | What it is | Where it comes from | Used on |
| --- | --- | --- | --- |
| `screens/check.webp` | The Check step, tool screen | Tool UI (the tool is named Remastly on screen), parchaa.com project, Check screen, 1440 × 900 | Home (bento), Features, How it works |
| `screens/create.webp` | The Create step, tool screen | Tool UI, indikaai.com project, Copy screen | Home (bento), Features, How it works |
| `screens/compare.webp` | The Compare step, tool screen | Tool UI, panscience.xyz project, Compare screen | Home (bento), Features, How it works |
| `screens/results.webp` | The Results step, tool screen | Tool UI, collateral.panscience.ai project, Results screen | Home (bento), Features, How it works |
| `sites/nyaayai-original-home.webp` | nyaayai.com homepage before the rebuild, top 990 px | Tool data folder: `corpus/nyaayai/capture/index/desktop-full.webp` | Hero (step 2) |
| `sites/nyaayai-copy-home.webp` | nyaayai.com rebuilt by Remastly (as-is copy), top 990 px | Tool data folder: `projects/1f98e132…/recreate/ab2729a9…/fidelity/index/desktop-full.webp` | Hero (steps 4 to 6) |
| `sites/collateral-original-home.webp` | collateral.panscience.ai homepage before, top 990 px | Tool data folder: `corpus/collateral/capture/index/desktop-full.webp` | Home (before/after slider) |
| `sites/collateral-copy-home.webp` | collateral.panscience.ai rebuilt, top 990 px | Tool data folder: `projects/48ba9d10…/recreate/3019a275…/fidelity/index/desktop-full.webp` | Home (before/after slider) |
| `sites/marquee-nyaayai.webp` | Rebuilt nyaayai.com, top 1100 px | Same copy as `nyaayai-copy-home.webp` | Home, rebuilt-sites strip |
| `sites/marquee-indikaai.webp` | Rebuilt indikaai.com, top 1100 px | Tool data folder: `projects/298cd46c…/recreate/f6035800…/fidelity/index/desktop-full.webp` | Home, rebuilt-sites strip |
| `sites/marquee-collateral.webp` | Rebuilt collateral.panscience.ai, top 1100 px | Tool data folder: `projects/48ba9d10…/recreate/3019a275…/fidelity/index/desktop-full.webp` | Home, rebuilt-sites strip |
| `sites/marquee-panscience.webp` | Rebuilt panscience.xyz, top 1100 px | Tool data folder: `projects/b210e06f…/recreate/9f2e79f3…/fidelity/index/desktop-full.webp` | Home, rebuilt-sites strip |
| `sites/marquee-parchaa.webp` | Rebuilt parchaa.com, top 1100 px | Tool data folder: `projects/d5691f4f…/recreate/18b20408…/fidelity/index/desktop-full.webp` | Home, rebuilt-sites strip |

No stock or internet images are used yet, so there is no `public/images/temp/` folder.

Still placeholders (no image yet): the Full report pages (`public/report-page1.png`, `public/report-page2.png`, shown on `/report`) and the Add a website form (`public/add-website.png`, shown on How it works). Until a file with that name exists in `public/`, a labelled placeholder is shown in its place.

To change an image, replace the file in `public/images/` and keep its name, or point `SHOTS` and `MARQUEE_SITES` in `lib/content.ts` at the new file.

## Hero story and motion

- **Hero story** (`components/hero/CinematicHero.tsx`): one 8-second GSAP timeline. A URL bar types the address and presses Enter; an older site floats in with its issues and a speed gauge (the real original figure, 79 on phones); a scan beam sweeps down and the page splits into layers; the layers reassemble into the rebuilt window with the stack chips; the markers become "Fixed" ticks and the counter reaches 8 (the real count of better checks); finally the original and the copy sit side by side with the 98% visual match badge. It plays once and settles on the last frame, with a Replay button. It starts once the hero is visible and pauses when it scrolls away or the tab is hidden.
- **3D** is CSS 3D transforms (perspective, preserve-3d), so text stays sharp. No WebGL.
- **Phones** use the same story in a flatter 3D setting, with a shorter stage so the hero fits one screen (844 px high at 390 × 844).
- **Reduced motion** shows the final frame, with no timeline.
- **Real figures only.** Every number on the hero and in "Real results" was read from the tool's saved data for that site. The copy's performance re-audit failed in the saved data, so no copy speed figure is used.
- **Motion system** (`app/visual.css`): reveals (fade and rise), card lift with a border glow, button hover and press states, the steps highlight as you scroll (`components/HowSteps.tsx`). Durations are 200 to 900 ms with ease-out expo and quart. Nothing bounces or spins. Everything is static under `prefers-reduced-motion`.

## Where things live

- `lib/content.ts`: product wording, features, limitations, FAQ, the example numbers, screenshot files and marquee sites
- `lib/site.ts`: site URL, name, email, navigation
- `app/globals.css`: the theme (tokens from the Remastly app), layout, components
- `app/visual.css`: the hero story, the home sections, card and button states, the reduced-motion rules
- `components/`: header, footer, report mock-up, gauges, count-ups, before/after slider, screenshot frames, marquee, sticky steps, plans, contact form, hero story

Animations (scroll reveals, count-ups, gauges drawing, bars growing, the slider hint, the hero story and the marquee) are switched off for visitors who ask for reduced motion, and content is never hidden when JavaScript is off.
