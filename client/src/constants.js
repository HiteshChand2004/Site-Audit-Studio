export const STACKS = [
  {
    id: 'html',
    name: 'Plain HTML / CSS / JS',
    short: 'HTML',
    detail: 'The simplest choice: plain web pages that load fastest and can be put on any web host. Best for most sites.',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    short: 'React',
    detail: 'For developer teams who work with React. Pages are ready for Google; visitors download a little app code.',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    short: 'Next',
    detail: 'For developer teams who work with Next.js (React). Pages are ready for Google; visitors download more app code.',
  },
  {
    id: 'mern',
    name: 'MERN',
    short: 'MERN',
    detail: 'React pages plus a small server and database that store what visitors send through contact forms.',
  },
];

// Stacks the recreate pipeline can generate so far (the others arrive in Phase 6).
export const RECREATE_STACKS = ['html', 'react-vite', 'nextjs', 'mern'];

export const stackById = (id) => STACKS.find((s) => s.id === id) ?? STACKS[0];

// Build mode builds these too (server/src/buildmode/stacks.js); Recreate does not, so they are not in STACKS.
export const BUILD_MODE_STACKS = [
  ...STACKS,
  {
    id: 'vue-vite',
    name: 'Vue + Vite',
    short: 'Vue',
    detail: 'For developer teams who work with Vue. Pages are ready for Google; visitors download a little app code.',
  },
  {
    id: 'astro',
    name: 'Astro',
    short: 'Astro',
    detail: 'Plain, fast pages with code only where a part needs it. For developer teams who work with Astro.',
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    short: 'SvelteKit',
    detail: 'For developer teams who work with Svelte. Every page is ready for Google; visitors download a little app code.',
  },
];

export const buildModeStackById = (id) => BUILD_MODE_STACKS.find((s) => s.id === id) ?? BUILD_MODE_STACKS[0];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
