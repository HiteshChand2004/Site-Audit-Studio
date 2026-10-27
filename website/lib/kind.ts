/** A group label as an attribute value: lower case, runs of anything but letters and digits become one dash ("CMS and shops" → "cms-and-shops"). */
export const kindSlug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
