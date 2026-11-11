// Plain names for what the after-build tools show (components/build).

/** A page's address as the owner calls it: / → Home, /our-menu/ → Our menu. */
export function pageName(path) {
  if (!path || path === '/') return 'Home';
  const last = path.replace(/\/$/, '').replace(/\.html?$/, '').split('/').pop() ?? '';
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}

/** What a text block is, in the owner's words. */
export const KIND_NAMES = {
  heading: 'Heading', paragraph: 'Text', 'list item': 'List item', button: 'Button', link: 'Link',
  label: 'Label', quote: 'Quote', caption: 'Caption', table: 'Table', text: 'Text',
};
