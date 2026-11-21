# Growth OS → Remastly: website changes (contract v1)

Growth OS decides **what** should change on a venture's website (a page for a buyer search, a better title, a shorter form).
Remastly **makes** the change on its own copy of the site, checks it, waits for a person to approve it **in Remastly**,
publishes it, and tells Growth OS the result. Growth OS then measures the page (Search Console, GA4, Clarity) after 14 days.

```
Growth OS                                   Remastly
Moves → Draft page → person reviews
"Send to Remastly"  ── POST change request ─▶ received → building (makes the page, checks it, screenshots)
                    ◀─ callback "ready" ───── preview link + score before/after + checks
                                              person approves in Remastly (website → Changes)
                    ◀─ callback "published" ─ live link + score before/after
GA4 / Clarity / Search Console after 14 days (Growth OS)
```

## Decisions

- The website lives **inside Remastly**: the change is made on the project's latest finished copy (or on the copy with the
  changes published since), never on another repository.
- The person approves **in Remastly** (the website's **Changes** tab). Growth OS shows the status only.
- Only a copy served as plain files can take changes (Plain HTML, or an as-is copy in any stack: its served folder). A MERN copy
  is refused with a message.

## Settings

| Where | Name | Meaning |
|---|---|---|
| Remastly `server/.env` | `SAS_GROWTHOS_KEY` | The key Growth OS sends (`Authorization: Bearer …`). At least 24 characters. Without it the API answers 503. |
| Remastly | `SAS_GROWTHOS_URL` | Growth OS's address (`http://localhost:4747`). Remastly calls back **only** under this address. |
| Remastly | `SAS_GROWTHOS_SECRET` | Signs every callback (HMAC-SHA256). The same value in Growth OS. |
| Remastly | `SAS_CHANGES_PUBLISH` | `local` = publish on this Remastly at `/live/<slug>/` (for a laptop); `hosting` = Go live's hosting (Remastly's server or Netlify). Unset: hosting when one is set up, else local. |
| Remastly | `SAS_PUBLIC_ORIGIN` | The address links in callbacks start with (default `APP_ORIGIN` or `http://localhost:5173`). |
| Growth OS `.env` | `REMASTLY_URL` | Remastly's API address (`http://127.0.0.1:4000`). |
| Growth OS | `REMASTLY_KEY` | = `SAS_GROWTHOS_KEY`. |
| Growth OS | `REMASTLY_SECRET` | = `SAS_GROWTHOS_SECRET`. |

## Requests (Growth OS → Remastly)

Every request: `Authorization: Bearer <SAS_GROWTHOS_KEY>`, JSON. Errors: `{ "error": "plain words" }` with 400 / 401 / 404 / 409 / 503.

### `GET /api/ext/v1/sites?url=https://predco.ai`
Which Remastly website holds that address (same host, `www.` ignored).
`200 { projectId, name, url, canChange, reason? }` or `404`.

### `POST /api/ext/v1/change-requests`
```json
{
  "requestId": "growthos:predco:rank:forklift pedestrian collision warning",
  "site": { "url": "https://predco.ai", "projectId": null },
  "type": "page.create",
  "page": "/ai-video-analytics/forklift-collision-warning",
  "draft": { "slug": "", "title": "", "metaDescription": "", "h1": "", "intro": "",
             "sections": [{ "h2": "", "body": "", "answers": [""] }], "faq": [{ "q": "", "a": "" }],
             "cta": "", "internalLinks": ["/existing-path"], "proof": [""], "changes": [""],
             "checks": { "numbersToCheck": ["45001"] } },
  "fix": null,
  "context": { "searches": ["forklift pedestrian collision warning"], "insight": "Reach the top 3 for …", "lift": 1.0, "venture": "predco" },
  "callbackUrl": "http://localhost:4747/hooks/remastly/predco/<secret>"
}
```
`202 { id, requestId, status: "received" }`. The same `requestId` again returns the existing request (`200`), so a retry never
makes a page twice. One open request per page and website at a time (`409` otherwise).

| `type` | `page` | Body | What Remastly does |
|---|---|---|---|
| `page.create` | the new address (else `draft.slug`) | `draft` | A new page built from the site's nearest page of the same kind: its head, header, footer and styles; the main part replaced by the draft (heading, intro, sections, proof, questions, call to action, related links). Added to `sitemap.xml`. |
| `page.improve` | the existing page | `draft` | New title, description and first heading; the draft's sections and questions added to the page's main part. `draft.changes` are shown to the person. |
| `meta.title` | the page | `fix: { title }` | The page's `<title>` (and `og:title`). |
| `meta.description` | the page | `fix: { description }` | The meta description (and `og:description`). |
| `image.alt` | the page | `fix: { items: [{ src, alt }] }` | `alt` of each picture whose address contains `src`. |
| `form.shorten` | the page | `fix: { remove: ["company", "phone"] }` | Those fields (by `name`) and their labels removed from the page's forms. |
| `tracking.ga4` | – (every page) | `fix: { measurementId: "G-XXXX" }` | The Google tag on every page; the site's `_headers` security policy allows Google's addresses. |

### `GET /api/ext/v1/change-requests/:id`
The request as in the callbacks below.

### `POST /api/ext/v1/change-requests/:id/cancel`
Cancels one that is not published yet.

## Callbacks (Remastly → Growth OS)

`POST <callbackUrl>` (only under `SAS_GROWTHOS_URL`), JSON, at every status change, retried 3 times (2 s, 10 s, 30 s).

Headers: `X-Remastly-Timestamp: <unix seconds>`, `X-Remastly-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
Growth OS refuses a signature that does not match or a timestamp more than 5 minutes off.

```json
{
  "event": "change.status",
  "id": "…", "requestId": "…", "type": "page.create", "status": "ready",
  "at": "2026-11-20T10:00:00.000Z",
  "page": "/ai-video-analytics/forklift-collision-warning",
  "previewUrl": "http://localhost:5173/preview/<token>/ai-video-analytics/forklift-collision-warning/",
  "liveUrl": null,
  "score": { "before": null, "after": 92 },
  "checks": [{ "id": "title", "label": "Title is 10–60 characters", "before": null, "after": true }],
  "notes": ["Numbers for a person to check: 45001"],
  "message": null
}
```

| `status` | Meaning |
|---|---|
| `received` | Stored, waiting its turn |
| `building` | Being made and checked |
| `ready` | Made and checked; waiting for a person's approval in Remastly (`previewUrl` set) |
| `publishing` | Approved; going live |
| `published` | Live (`liveUrl`, `publishedAt`) — Growth OS starts measuring |
| `rejected` | The person turned it down in Remastly (`message` says why) |
| `failed` | It could not be made or published (`message` says why) |
| `cancelled` | Growth OS cancelled it |

`score` is the share of the page checks below that pass (0–100), on the live page before and on the changed page after
(`before` is null for a new page). Checks: title 10–60 characters, description 50–160, one first heading, page language, every
picture has a description, a canonical address, a phone layout (viewport), links to the site's own pages that exist, and
**the change is still there after the page's own scripts ran** (a framework that redraws a page from its data could undo it).

## Rules that stay

Nothing goes live without a person's yes. Only the draft's own words and approved claims are used; Remastly does not write copy.
One open change per page. Every request and every callback is kept with its date (Remastly: `change_requests`; Growth OS: its database).

## Try it on a laptop

1. Pick two random values: a key (24+ characters) and a secret (16+).
2. Remastly `server/.env`: `SAS_GROWTHOS_KEY=<key>`, `SAS_GROWTHOS_SECRET=<secret>`, `SAS_GROWTHOS_URL=http://localhost:4747`,
   `SAS_CHANGES_PUBLISH=local`. Start it: `npm run dev` (app on 5173, API on 4000).
3. Growth OS `.env`: `REMASTLY_URL=http://127.0.0.1:4000`, `REMASTLY_KEY=<key>`, `REMASTLY_SECRET=<secret>`,
   `GROWTHOS_PUBLIC_URL=http://localhost:4747`. Start it: `npm start`.
4. In Remastly: add the website (same address as the company's website in Growth OS) and make its copy (**Copy my site**, Plain HTML).
5. In Growth OS: Buyers → Moves → **Draft the page** → **Send to Remastly**.
6. In Remastly: the website → **Changes**: the page, its checks, the pictures and **Open the preview** → **Approve and publish**.
7. Back in Growth OS, the draft shows **Live** with the live link and the date it will be measured.

Tests: Remastly `npm test -w server -- test/growthos-changes.test.js`; Growth OS `node test/ci.js remastly`.

## How a page is made (the site's own template)

Like Growth OS on a repository (one template + a content list), but on the copy Remastly holds:

1. **Kinds of pages** (`changes/template.js pageKinds`): pages of one folder that are built alike (`/ai-video-analytics/forklift/`,
   `/ai-video-analytics/ppe/`) are one kind. A new page's folder picks its kind.
2. **The template** (`deriveTemplate`): two pages of the kind are compared. What both share is the template (menu, footer, labels,
   buttons, the site's script files); what differs is a slot: text, a picture or link, a list of items of one shape (cards, FAQ),
   an optional part. Each slot keeps what the two pages put there, as examples. A page's own script data is never carried.
3. **The content entry** (`changes/agent.js`): Claude writes the words for the slots from the draft, the searches it answers and the
   approved claims, in the length and tone of the examples; it chooses a picture from the site's own files (with their sizes) and
   links only to the site's pages. It writes no HTML. Code checks the answer: only the template's slots, plain text cut to size,
   pictures and links that exist, numbers not in the draft listed for a person. No answer: a plain mapping (heading, intro,
   sections → cards, questions → FAQ); a slot nothing can fill honestly is left out, never copied from another page.
4. **The page** (`fillTemplate`): the kind's HTML with only the slots filled; head from a page of the kind with the new title,
   description and address; added to `sitemap.xml`.
5. **Improve** on a page of a kind: the page is made again by its template; the AI keeps its own content where the draft does not
   change it. Other pages: changed in place. A tool screen (no heading, no article): a new page instead.
6. **No kind** (a site with no two pages of a kind, like peelpress): **its homepage is the template** (`template.js deriveSingle`).
   Every word, picture and link of its content parts is a slot (its menu and footer stay), repeated parts are lists, and each part
   but the top one is optional. The AI fills the top and the parts the draft has content for (feature cards, steps, a closing call
   to action) and leaves out the rest (pricing, testimonials); the homepage's own links stay where the AI gives none, its pictures
   do not. Needs the AI; without it (or when the homepage has no main heading) the frames of the nearest page, said in the notes.
   A box of buttons (a hero's two buttons) keeps each button's label and link; links that are the same on both sides (a menu)
   stay part of the template.
   A block without a heading that ends up partly empty (an illustration whose sample rows were not written, a row of logos with
   none) is left out whole rather than shown as an empty frame (`template.js emptiedBlocks`); a section with a heading stays.
7. **Checks**: page checks (score before → after), "still there after the page's scripts ran", and the **design check** against a
   page of the kind (`checks.js designCheck`): same kinds of parts, the same type for headings and text, pictures that load and
   are not blown up, nothing wider than a phone. Pictures on a computer and a phone, after scrolling like a visitor.

Settings: `SAS_CHANGES_AI` (`api` | `cli` | `off`; unset = api with `ANTHROPIC_API_KEY`, else cli when Claude Code is found),
`SAS_CHANGES_AI_MODEL` (default `sonnet`), `SAS_CLAUDE_BIN`. Claude Code runs from an empty temporary folder with its own short
system prompt, no tools and no MCP servers (about 1 000 tokens a call, not the project's instructions).
Measured (a two-page use-case site, real Claude through Claude Code): 16–19 s and about $0.02 a page; it chose the fitting picture
of four; page checks 100; design check 4 of 4. Tests: `changes-template.test.js`, `changes-ai.test.js` (a stand-in answer; a test
never asks the real AI).

## Not done yet

- Only a copy served as files can take changes (no MERN), and a converted stack's source code (React / Next.js `src/`) does not
  get the change: the served files and the deploy do; the downloaded zip is the copy as it was.
- Growth OS's claim labels ("(C3)") are taken out of a draft's words when it arrives; the AI is told each slot's longest length.
- Measured on peelpress (homepage as the template, real Claude): 26–28 s, about $0.03–0.05 a page, page checks 88 (the site has
  no canonical address), design check 4 of 4.
- Never tried on a real site's copy with pages of a kind (only on a realistic two-page site); predco.ai's inner pages answered 404
  to a direct fetch, so the real check is a Remastly copy of it (Remastly visits with a browser).
- A preview address lives as long as the Remastly server: after a restart the Changes tab shows a new one (the one sent to
  Growth OS stops working).
- Growth OS stores `measureAfter`; comparing Search Console / GA4 numbers 14 days later is Growth OS's next step.
- Never tried on a real hosting deploy (Netlify / Remastly's server) end to end; the local address was.

## Builder sites, previews after a restart, Check again / Make again (2026-11-21)
- **A page a site builder draws as one block** (Framer: no `<main>`, the body one element whose children are the sections, each in a
  computer / tablet / phone copy, the text's look on the wrappers around it): when the template path is not used, the new page is
  made *in that structure* (`apply.js draftInPlace`): header and footer copies kept, every copy of the top gets the heading and
  intro, one of the page's sections is the model of each draft section (every heading and paragraph copy filled, the template's own
  words and pictures removed), the template's other sections left out; words written into a one-line text box may wrap (`letWrap`).
  Before, the whole block was replaced by bare `<h1 class="framer-text">`… and the page showed Framer's defaults (Inter 16px).
- **The AI is asked about each different text once** (`fromTemplate.js compactSlots`): the copies of a part share one answer, and a
  `<style>` / `<script>` slot is never asked, always kept (ChoiceAI's homepage: 244 slots → 114). `template.js fillTemplate` writes a
  stylesheet's or script's text unescaped.
- **Checks use the copy server** (`checks.js siteServer` = `preserve/serve.js serveCopy`): a packaged Next.js copy's `/_next`
  files load, so the pictures and the design check see the page's stylesheets. A page whose builder's script is taken off by the
  repair shows the parts it would have faded in (`shownAtStart`).
- **Preview addresses survive a restart**: a change keeps its preview address (`preview_url`); an unknown token is looked up there
  (`previewTokens.js addPreviewSource`, `store.js changeByPreviewToken`), so the same link works after a deploy.
- **Check again** (`POST /api/projects/:id/changes/:changeId/check-again`, ready or published): checks and pictures again, the page
  unchanged, `result.checkedAt`. **Make again** (`…/make-again`, ready / failed / turned down, never a live change): built again
  from the request with the current code, back to ready, same preview address; Growth OS is told each status.
- Tests: `changes-builder` (4), `growthos-changes` (+1).

## Go live keeps the published pages (2026-11-21)
A Go live deploy used to upload the bare copy (`routes/deploy.js` → `runDeploy` without `dir`), so it took every page Growth OS
had published off the live site (own360: a page published at 12:56 was gone after a deploy at 13:15 that turned tracking on).
One rule now says what the website is: `changes/site.js publishedOnCopy(projectId, recreateId, stack)` = the newest published
change made on that copy (its folder holds every change published on it), else the copy. `resolveBase` (the next change) and the
Go live deploy both use it; a deploy of that folder goes through `changeDeploySource` (shared with `publishChange`). `GET/POST
…/deploy` answer `includes` (the pages it keeps; the card says so). Deploying another copy than the one the live site runs warns
first (readiness `changes-dropped`, accepted by id, naming the pages), once: after that copy is live there is nothing to warn about.
Test: `deploy-netlify` (+1). A page already taken off comes back with one Go live deploy, as long as its change folder exists.
