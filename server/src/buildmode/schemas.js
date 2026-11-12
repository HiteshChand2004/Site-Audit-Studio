// @ts-check
// The JSON schemas the two LLM steps must answer in (structured outputs: the API guarantees the shape). The lists of site types,
// goals and quality areas come from the module library, so a new module file is also a new choice the model can make.
// Structured outputs need every object closed (additionalProperties: false) and every property listed in `required`.

/** @typedef {import('./library.js').Library} Library */

const str = (/** @type {string} */ description) => ({ type: 'string', description });
const strings = (/** @type {string} */ description) => ({ type: 'array', items: { type: 'string' }, description });
const obj = (/** @type {Record<string, object>} */ properties, /** @type {string} */ description = '') => ({
  type: 'object', ...(description && { description }), properties, required: Object.keys(properties), additionalProperties: false,
});

export const TASKS = ['build-new', 'redesign', 'edit', 'fix-audit'];

/**
 * Step 1: what kind of job this is.
 * @param {Library} library
 */
export function understandingSchema(library) {
  return obj({
    task: { type: 'string', enum: TASKS, description: 'build-new only when there is no existing site; redesign = make it noticeably better; edit = a specific limited change; fix-audit = fix the audit findings without changing the look' },
    site_type: { type: 'string', enum: library.ids('site'), description: 'The closest kind of site; general when none fits' },
    goal: { type: 'string', enum: library.ids('goal'), description: 'The single most important thing the site must achieve' },
    audience: str('Who the site is for, as specifically as the request allows'),
    tone: str('The voice and feel the owner wants, in a few words'),
    pages: { type: 'array', description: 'Pages to create or change, homepage first', items: obj({ path: str('URL path, e.g. / or /pricing'), purpose: str('What the page is for'), change: { type: 'string', enum: ['create', 'change', 'keep'] } }) },
    must_haves: strings('Things the owner explicitly asked for'),
    keep_unchanged: strings('Things that must stay exactly as they are (existing sites only)'),
    quality_focus: { type: 'array', items: { type: 'string', enum: library.ids('quality') }, description: 'Quality areas the request stresses' },
    facts: strings('Facts about the business stated by the owner or present in the site content (never guessed)'),
    unknowns: strings('Facts the site needs that nobody has given (prices, hours, photos…)'),
    questions: strings('At most 3 questions whose answers would most change the result'),
  });
}

/** One design direction: in the brief, and alone when a repeat build gets a design of its own (steps.js writeDirection). */
export function directionSchema() {
  return obj({
    name: str('A short evocative name for this direction'),
    palette: { type: 'array', items: obj({ role: { type: 'string', enum: ['background', 'surface', 'text', 'muted', 'primary', 'accent', 'border'] }, hex: str('#rrggbb') }) },
    fonts: obj({ heading: str('A font family available on Google Fonts or the system'), body: str('A font family available on Google Fonts or the system') }),
    layout: str('Layout style: grid, density, section rhythm, image treatment'),
    imagery: str('What the images or illustrations look like'),
    motion: { type: 'string', enum: ['none', 'subtle', 'expressive'] },
    why: str('Why this direction fits the audience and goal'),
  });
}

/** Step 2: the creative and technical brief the agent works from. */
export function briefSchema() {
  const direction = directionSchema();
  return obj({
    summary: str('Two or three sentences: what will be built or changed, and why'),
    design: obj({
      mode: { type: 'string', enum: ['new', 'keep-existing', 'evolve-existing'] },
      existing_notes: str('For existing sites: the design system observed and what to keep; empty for new sites'),
      directions: { type: 'array', items: direction, description: 'New sites: 3 clearly different directions. Otherwise 0 or 1.' },
    }),
    pages: { type: 'array', items: obj({
      path: str('URL path'),
      title: str('The page title tag text'),
      description: str('The meta description, 50-160 characters'),
      purpose: str('What the page must achieve'),
      sections: { type: 'array', items: obj({ name: str('Section name'), content: str('The actual copy or a precise description of it'), notes: str('Layout or behaviour notes, including how the section adapts between phone and desktop') }) },
    }) },
    requirements: { type: 'array', items: obj({ id: str('R1, R2 …'), text: str('One concrete requirement'), check: str('How a reviewer can verify it on the finished site') }) },
    keep_unchanged: strings('What must stay exactly as it is'),
    placeholders: strings('Facts still missing that will be shown as marked placeholders'),
    structured_data: strings('Schema.org types to add, with the page they go on'),
  });
}
