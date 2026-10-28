// THE accent colour. Change this one value and the whole site follows: the CSS reads it as var(--accent) (set on <html> in
// app/layout.tsx), every tint, strong shade and translucent use is derived from it in app/theme.css, the logo mark and the
// social image use it too. Picked to pass contrast as text on #FAFAF7 (4.5:1), as a fill under white text (4.5:1) and as a
// graphic on the near-black band (3:1); the lighter text colour used on dark bands is derived from it (see --accent-on-dark).
export const ACCENT = '#c2410c';
