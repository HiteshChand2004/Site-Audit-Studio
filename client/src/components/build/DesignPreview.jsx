import { useEffect, useRef } from 'react';
import { apiUrl } from '../../api/base.js';
import styles from './DesignPreview.module.css';

// A small picture of a design direction: a heading in its heading font, a line in its body font and a button in its main
// colour, on its background, with its colours in a strip along the bottom. Owners see the difference instead of reading it.
// The fonts come from the app's own address (server/src/buildmode/fontPreview.js), never from Google: a family's stylesheet is
// added once, the first time a preview using it comes into view. A font that cannot be had falls back to a similar system font.

const PREVIEW_SUFFIX = 'sas-preview';
// Fonts every computer has (or CSS keywords): drawn as they are, nothing to ask for.
const SYSTEM = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont',
  'arial', 'helvetica', 'helvetica neue', 'georgia', 'times', 'times new roman', 'verdana', 'tahoma', 'trebuchet ms', 'courier new', 'segoe ui']);
const SERIF = /serif|slab|playfair|lora|merriweather|fraunces|garamond|baskerville|georgia|times|crimson|caslon|cormorant|spectral|bitter|newsreader|bodoni|prata|cinzel|literata|gelasio|vollkorn|alegreya|domine|zilla/i;
/** Families whose stylesheet this page has already asked for (once per page, whatever the number of previews). */
const requested = new Set();

/** The family a direction names, as the API accepts it (letters, digits, spaces), or null. */
export function familyOf(value) {
  const first = String(value ?? '').split(',')[0].replace(/["']/g, '').trim().replace(/\s+/g, ' ');
  return first && first.length <= 48 && /^[A-Za-z0-9 ]+$/.test(first) && /[A-Za-z]/.test(first) ? first : null;
}

const isSystem = (family) => SYSTEM.has(family.toLowerCase());

/** The font stack a preview draws with: the app's copy of the family, the family itself, then a fallback of the same kind. */
function fontStack(family) {
  const generic = family && /mono|code/i.test(family) ? 'ui-monospace, monospace'
    : family && SERIF.test(family) && !/sans/i.test(family) ? 'Georgia, "Times New Roman", serif'
      : 'system-ui, -apple-system, "Segoe UI", sans-serif';
  if (!family) return generic;
  return isSystem(family) ? `"${family}", ${generic}` : `"${family} ${PREVIEW_SUFFIX}", "${family}", ${generic}`;
}

/** Adds the stylesheets of these families to the page, each once. */
function loadFamilies(families) {
  for (const family of families) {
    const key = family.toLowerCase();
    if (requested.has(key)) continue;
    requested.add(key);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = apiUrl(`/build/fonts/${encodeURIComponent(family)}.css`);
    link.dataset.previewFont = family;
    document.head.appendChild(link);
  }
}

/** Loads the families once the element is (nearly) on screen. */
function useFontsWhenShown(ref, families) {
  const key = families.join('|');
  useEffect(() => {
    const wanted = key ? key.split('|').filter((f) => !requested.has(f.toLowerCase())) : [];
    if (!wanted.length) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      loadFamilies(wanted);
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        loadFamilies(wanted);
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, key]);
}

const hexOf = (value) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${h.toLowerCase()}`;
};

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const DARK = '#111111';
const LIGHT = '#ffffff';
/** Black or white, whichever reads better on this colour. */
export const readableOn = (bg) => (contrast(LIGHT, bg) >= contrast(DARK, bg) ? LIGHT : DARK);

/** The colours a preview uses, chosen from the palette's roles; missing or unreadable ones get a sensible stand-in. */
export function previewColors(palette) {
  const role = {};
  for (const c of Array.isArray(palette) ? palette : []) {
    const hex = hexOf(c?.hex);
    if (hex && c.role && !role[c.role]) role[c.role] = hex;
  }
  const bg = role.background ?? role.surface ?? LIGHT;
  const text = role.text && contrast(role.text, bg) >= 3 ? role.text : readableOn(bg);
  const muted = role.muted && contrast(role.muted, bg) >= 3 ? role.muted : text;
  const button = role.primary ?? role.accent ?? text;
  return {
    bg,
    text,
    muted,
    button,
    label: readableOn(button),
    // A button the colour of the page around it still shows as a button.
    buttonEdge: contrast(button, bg) < 1.5 ? text : 'transparent',
    mark: role.accent ?? role.primary ?? text,
    edge: role.border ?? 'var(--hairline-strong)',
    strip: Object.values(role),
  };
}

/**
 * @param {{ design: { name?: string, palette?: { role: string, hex: string }[], fonts?: { heading?: string, body?: string } },
 *   size?: 'md' | 'sm', heading?: string }} props
 *   size sm: one line (a heading and a button), for lists of sites
 */
export default function DesignPreview({ design, size = 'md', heading }) {
  const ref = useRef(null);
  const headingFamily = familyOf(design?.fonts?.heading);
  const bodyFamily = familyOf(design?.fonts?.body);
  const families = [...new Set([headingFamily, bodyFamily].filter((f) => f && !isSystem(f)))];
  useFontsWhenShown(ref, families);
  const c = previewColors(design?.palette);
  const style = {
    '--p-bg': c.bg,
    '--p-text': c.text,
    '--p-muted': c.muted,
    '--p-button': c.button,
    '--p-label': c.label,
    '--p-button-edge': c.buttonEdge,
    '--p-mark': c.mark,
    '--p-edge': c.edge,
    '--p-heading': fontStack(headingFamily),
    '--p-body': fontStack(bodyFamily ?? headingFamily),
  };
  // Spans only: the preview sits inside the direction's radio button. It is a picture, so screen readers skip it; the fonts and
  // colours are named in words next to it.
  return (
    <span ref={ref} className={styles.preview} data-size={size} style={style} aria-hidden="true">
      {size === 'md' && <span className={styles.mark} />}
      <span className={styles.heading}>{heading ?? (size === 'sm' ? 'Hello there' : 'Hello, and welcome')}</span>
      {size === 'md' && <span className={styles.body}>This is how your text reads on the site.</span>}
      <span className={styles.button}>{size === 'sm' ? 'Contact' : 'Get in touch'}</span>
      {c.strip.length > 0 && (
        <span className={styles.strip}>
          {c.strip.map((hex, i) => <span key={`${hex}${i}`} style={{ background: hex }} />)}
        </span>
      )}
    </span>
  );
}
