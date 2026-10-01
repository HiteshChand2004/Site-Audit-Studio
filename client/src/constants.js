export const STACKS = [
  {
    id: 'html',
    name: 'Plain HTML / CSS / JS',
    short: 'HTML',
    detail: 'Static, zero-dependency output. Fastest load, hosts anywhere.',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    short: 'React',
    detail: 'Component-based SPA with production build. Pre-rendered HTML for SEO.',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    short: 'Next',
    detail: 'Static export / SSR, file-based routing, built-in image optimisation.',
  },
  {
    id: 'mern',
    name: 'MERN',
    short: 'MERN',
    detail: 'React client + Express API + MongoDB. Includes stub endpoints for forms.',
  },
];

// Stacks the recreate pipeline can generate so far (the others arrive in Phase 6).
export const RECREATE_STACKS = ['html', 'react-vite', 'nextjs'];

export const stackById = (id) => STACKS.find((s) => s.id === id) ?? STACKS[0];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
