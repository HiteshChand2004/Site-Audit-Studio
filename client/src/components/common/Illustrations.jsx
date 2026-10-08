// Small line drawings made for this app (the four stages, empty states and the logo). Colours come from the tokens
// through the classes in Illustrations.module.css, so they follow the theme. Decorative: hidden from screen readers.
import s from './Illustrations.module.css';

const Svg = ({ children, viewBox = '0 0 160 112', className = '', ...rest }) => (
  <svg viewBox={viewBox} className={`${s.art} ${className}`} aria-hidden="true" focusable="false" {...rest}>
    {children}
  </svg>
);

/** A browser window: frame, address bar and three dots. */
const Window = ({ x, y, w, h, accent = false }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx="7" className={accent ? s.paperAccent : s.paper} />
    <path d={`M${x} ${y + 13}h${w}`} className={accent ? s.accentLine : s.line} />
    <circle cx={x + 7} cy={y + 6.5} r="1.7" className={accent ? s.accent : s.dot} />
    <circle cx={x + 12.5} cy={y + 6.5} r="1.7" className={s.dot} />
    <circle cx={x + 18} cy={y + 6.5} r="1.7" className={s.dot} />
  </g>
);

/** 1 · Check: a page under a magnifier with a speed gauge. */
export function CheckArt(props) {
  return (
    <Svg {...props}>
      <Window x={14} y={14} w={96} h={76} />
      <rect x="24" y="36" width="44" height="6" rx="3" className={s.ink} />
      <rect x="24" y="47" width="62" height="4" rx="2" className={s.soft} />
      <rect x="24" y="56" width="54" height="4" rx="2" className={s.soft} />
      <rect x="24" y="68" width="22" height="10" rx="3" className={s.tint} />
      <circle cx="108" cy="64" r="24" className={s.lens} />
      <path d="M93 70a16 16 0 0 1 30 0" className={s.gaugeTrack} />
      <path d="M93 70a16 16 0 0 1 24-13.5" className={`${s.gauge} ${s.draw}`} />
      <path d="M108 70l7-9" className={s.needle} />
      <circle cx="108" cy="70" r="2.2" className={s.accent} />
      <path d="M125 81l15 15" className={s.handle} />
    </Svg>
  );
}

/** 2 · Copy: the original page and a clean new one built beside it. */
export function CopyArt(props) {
  return (
    <Svg {...props}>
      <Window x={10} y={22} w={78} h={64} />
      <rect x="19" y="44" width="34" height="5" rx="2.5" className={s.soft} />
      <rect x="19" y="54" width="52" height="4" rx="2" className={s.soft} />
      <rect x="19" y="62" width="44" height="4" rx="2" className={s.soft} />
      <Window x={70} y={30} w={80} h={66} accent />
      <rect x="80" y="52" width="36" height="5" rx="2.5" className={s.ink} />
      <rect x="80" y="62" width="54" height="4" rx="2" className={s.tint} />
      <rect x="80" y="70" width="46" height="4" rx="2" className={s.tint} />
      <rect x="80" y="80" width="20" height="8" rx="3" className={s.accent} />
      <path d="M58 14c14-6 30-4 40 8" className={`${s.arrow} ${s.draw}`} />
      <path d="M93 16l5 6-7 2" className={s.arrow} />
    </Svg>
  );
}

/** 3 · Compare: one page split down the middle, original left, copy right. */
export function CompareArt(props) {
  return (
    <Svg {...props}>
      <Window x={16} y={14} w={128} h={84} />
      <path d="M80 27v71" className={s.split} />
      <rect x="26" y="38" width="40" height="6" rx="3" className={s.soft} />
      <rect x="26" y="50" width="46" height="4" rx="2" className={s.soft} />
      <rect x="26" y="58" width="38" height="4" rx="2" className={s.soft} />
      <rect x="26" y="72" width="44" height="16" rx="3" className={s.soft} />
      <rect x="88" y="38" width="40" height="6" rx="3" className={s.ink} />
      <rect x="88" y="50" width="46" height="4" rx="2" className={s.tint} />
      <rect x="88" y="58" width="38" height="4" rx="2" className={s.tint} />
      <rect x="88" y="72" width="44" height="16" rx="3" className={s.tint} />
      <circle cx="80" cy="62" r="9" className={s.knob} />
      <path d="M76.5 62h7M77.5 59.5 75 62l2.5 2.5M82.5 59.5 85 62l-2.5 2.5" className={s.knobArrows} />
    </Svg>
  );
}

/** 4 · Results: a checklist and the new site packed for download. */
export function ResultsArt(props) {
  return (
    <Svg {...props}>
      <rect x="14" y="12" width="76" height="88" rx="8" className={s.paper} />
      {[30, 50, 70].map((y, i) => (
        <g key={y}>
          <circle cx="28" cy={y} r="6" className={i === 2 ? s.warnDot : s.okDot} />
          <path d={i === 2 ? `M28 ${y - 3}v3.5M28 ${y + 2.6}v.4` : `M25 ${y}l2.2 2.2 4-4.4`} className={s.mark} />
          <rect x="40" y={y - 3} width={i === 1 ? 36 : 40} height="5" rx="2.5" className={s.soft} />
        </g>
      ))}
      <rect x="22" y="84" width="30" height="5" rx="2.5" className={s.soft} />
      <rect x="96" y="44" width="52" height="52" rx="10" className={s.paperAccent} />
      <path d="M122 56v22m-9-9 9 9 9-9" className={`${s.downArrow} ${s.draw}`} />
      <path d="M108 86h28" className={s.downArrow} />
    </Svg>
  );
}

/** An empty browser window drawn with dashes: a website that has not been checked yet. */
export function EmptySiteArt(props) {
  return (
    <Svg viewBox="0 0 220 140" {...props}>
      <rect x="20" y="14" width="180" height="112" rx="10" className={s.dashed} />
      <path d="M20 32h180" className={s.dashedLine} />
      <circle cx="31" cy="23" r="2.4" className={s.dot} />
      <circle cx="39" cy="23" r="2.4" className={s.dot} />
      <circle cx="47" cy="23" r="2.4" className={s.dot} />
      <rect x="40" y="50" width="78" height="9" rx="4.5" className={s.soft} />
      <rect x="40" y="66" width="120" height="6" rx="3" className={s.soft} />
      <rect x="40" y="78" width="104" height="6" rx="3" className={s.soft} />
      <rect x="40" y="96" width="38" height="14" rx="4" className={s.tint} />
      <circle cx="166" cy="100" r="18" className={s.lens} />
      <path d="M178 112l12 12" className={s.handle} />
      <path d="M159 100h14M166 93v14" className={s.plus} />
    </Svg>
  );
}

/** The app's mark: an original page and its copy, overlapping. */
export function LogoMark({ size = 32 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={s.logo} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" className={s.logoBg} />
      <rect x="7" y="7" width="13" height="15" rx="2.5" className={s.logoBack} />
      <rect x="12" y="11" width="13" height="15" rx="2.5" className={s.logoFront} />
      <path d="M15 16h7M15 19.5h5" className={s.logoLines} />
    </svg>
  );
}
