// DEPLOY.md and KNOWN-ISSUES.md for "Copy my site" (docs/COPY-MY-SITE.md §8). Plain language, written for each stack.

export const STACK_FACTS = {
  html: {
    label: 'Plain HTML',
    run: ['Open a terminal in the copy folder and run `npx serve .`, then open the address it prints.',
      'Do not double-click index.html: forms, the service worker and some scripts need a web address.'],
    hosts: ['Netlify: drag the folder onto app.netlify.com/drop.', 'GitHub Pages: push the folder to a repository, then Settings → Pages → deploy from the main branch.'],
  },
  'react-vite': {
    label: 'React + Vite',
    run: ['Run `npm install`, then `npm run dev` and open the address it prints.', 'For the real files run `npm run build`; they are in dist/.'],
    hosts: ['Netlify: connect the repository; build command `npm run build`, publish folder `dist`.', 'Vercel: import the repository; the framework is detected as Vite.'],
  },
  nextjs: {
    label: 'Next.js',
    run: ['Run `npm install`, then `npm run dev` and open the address it prints.', 'For the real files run `npm run build`; they are in out/.'],
    hosts: ['Vercel: import the repository; the framework is detected as Next.js.', 'Netlify: connect the repository; build command `npm run build`, publish folder `out`.'],
  },
  mern: {
    label: 'MERN',
    run: ['Run `npm run install:all`, then `npm start` and open http://localhost:3000 (or the PORT you set).',
      'Form submissions are stored in MongoDB when MONGODB_URI is set; without it the site still runs and forms report that they cannot save.'],
    hosts: ['Render: a web service from the repository, with a MongoDB Atlas database and MONGODB_URI set.', 'A VPS: Node 22, the app behind a reverse proxy with HTTPS.'],
  },
};

/**
 * @param {object} o
 * @param {keyof typeof STACK_FACTS} o.stack
 * @param {string} o.siteName
 * @param {string} [o.address]         the new site's address
 * @param {string} [o.formEndpoint]    where form submissions go (html / react-vite / nextjs), if any
 * @param {{ text: string }[]} [o.checks] reason-e items: what to check after deploying
 */
export function deployMd({ stack, siteName, address = null, formEndpoint = null, checks = [] }) {
  const facts = STACK_FACTS[stack];
  if (!facts) throw new Error(`no deploy notes for the ${stack} stack`);
  const lines = [
    `# Deploy ${siteName}`,
    '',
    `This copy is in the ${facts.label} stack.`,
    '',
    '## Run it on your computer',
    '',
    ...facts.run.map((s) => `- ${s}`),
    '',
    '## Put it on the web',
    '',
    ...facts.hosts.map((s) => `- ${s}`),
    '',
    '## Settings to set',
    '',
    ...(address ? [`- The new site's address: \`${address}\` (search tags, sitemap and links already use it).`] : ['- The new site\'s address was not set; the search tags still name the original. Set it and copy again.']),
    ...(formEndpoint ? [`- Form submissions: \`FORM_ENDPOINT=${formEndpoint}\`.`] : ['- Forms: none of the copy\'s forms send anything yet. Connect a form service and set FORM_ENDPOINT to its address.']),
    '- HTTPS is needed for the service worker and for forms to work. Every host above provides it.',
    '',
    '## After you deploy',
    '',
    ...(checks.length ? checks.map((c) => `- ${c.text}`) : ['- Open the address, check the main pages on a phone, and try the menus.']),
    '',
  ];
  return lines.join('\n');
}

/**
 * @param {object} o
 * @param {string} o.siteName
 * @param {keyof typeof STACK_FACTS} o.stack
 * @param {{ page: string, check: string, values: string, tried: string, reason: string }[]} o.pages  open items
 * @returns {string | null} the file text, or null when nothing is open
 */
export function knownIssuesMd({ siteName, stack, pages }) {
  if (!pages.length) return null;
  const lines = [
    `# Known issues — ${siteName} (${STACK_FACTS[stack]?.label ?? stack})`,
    '',
    'These pages or checks could not be made fully right. The copy is still the best version we could make; each item says why.',
    '',
  ];
  for (const p of pages) {
    lines.push(`## ${p.page}`, '', `- Check: ${p.check}`, `- Values: ${p.values}`, `- Tried: ${p.tried}`, `- Reason: ${p.reason}`, '');
  }
  return lines.join('\n');
}

/**
 * One line for the server log the admin reviews (JSON lines: one record per open item).
 * @param {{ site: string, stack: string, page: string, check: string, values: string, tried: string, reason: string }} e
 */
export function issueRecord(e) {
  return JSON.stringify({ at: new Date().toISOString(), ...e });
}
