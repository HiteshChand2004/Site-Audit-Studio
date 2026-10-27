import { Accessibility, Check, FileArchive, Gauge, Link2, Lock, Search, ShieldCheck, Terminal } from 'lucide-react';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { LOGO_COLORS, LOGO_DIM, LOGO_PLATED } from '@/lib/content';
import '@/app/tour.css';

/*
 * Small drawings of the Remastly app in HTML and CSS, shared by Features and How it works. They are drawn, not
 * screenshots, so they stay sharp at any size. They show status words, never scores. Broken links and console errors
 * are always "Flagged for you"; only items from FIXABLE are shown as fixed.
 */

type Tone = 'ok' | 'warn' | 'info';

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`mk-pill mk-pill--${tone}`}>{children}</span>;
}

export function Logo({ id, k = 1 }: { id: string; k?: number }) {
  const [w, h] = LOGO_DIM[id] ?? [30, 30];
  return (
    <svg className="mk-logo" data-plate={LOGO_PLATED.includes(id) || undefined} width={w * k} height={h * k} style={{ fill: LOGO_COLORS[id] }} aria-hidden="true">
      <use href={`/platforms/sprite.svg#${id}`} />
    </svg>
  );
}

const AUDIT_ROWS: [typeof Gauge, string, string, Tone][] = [
  [Gauge, 'Speed', 'Needs work', 'warn'],
  [Search, 'Found on Google', 'Good', 'ok'],
  [Accessibility, 'Easy for everyone', 'Good', 'ok'],
  [ShieldCheck, 'Safe and modern', 'Good', 'ok'],
  [Link2, 'Broken links', 'Flagged for you', 'info'],
  [Terminal, 'Console errors', 'Flagged for you', 'info'],
];

export function AuditMock({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="mk-rows">
      {AUDIT_ROWS.slice(0, rows).map(([Icon, name, word, tone]) => (
        <li key={name}>
          <Icon size={16} aria-hidden="true" />
          <span>{name}</span>
          <Pill tone={tone}>{word}</Pill>
        </li>
      ))}
    </ul>
  );
}

const FIX_ROWS: [string, string, Tone][] = [
  ['Image descriptions (alt text)', 'Fixed', 'ok'],
  ['Main headings and their order', 'Fixed', 'ok'],
  ['Link previews (Open Graph)', 'Fixed', 'ok'],
  ['Site map and robots.txt', 'Fixed', 'ok'],
  ['Login form', 'Needs a person', 'warn'],
];

export function FixMock() {
  return (
    <ul className="mk-rows">
      {FIX_ROWS.map(([name, word, tone]) => (
        <li key={name}>
          <span className={`mk-tick mk-tick--${tone}`} aria-hidden="true">
            {tone === 'ok' && <Check size={12} strokeWidth={3} />}
          </span>
          <span>{name}</span>
          <Pill tone={tone}>{word}</Pill>
        </li>
      ))}
    </ul>
  );
}

const STACKS = [
  { name: 'Plain HTML', logos: ['html5', 'css3', 'javascript'] },
  { name: 'React + Vite', logos: ['react', 'vite'] },
  { name: 'Next.js', logos: ['nextdotjs'] },
  { name: 'MERN', logos: ['mongodb', 'express', 'react', 'nodedotjs'] },
];

export function StackMock({ picked = 0 }: { picked?: number }) {
  return (
    <ul className="mk-stacks">
      {STACKS.map((s, i) => (
        <li key={s.name} data-on={i === picked || undefined}>
          <span className="mk-stacks__logos">
            {s.logos.map((l) => (
              <Logo key={l} id={l} k={0.6} />
            ))}
          </span>
          <span className="mk-stacks__name">{s.name}</span>
          <span className="mk-radio" aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

/*
 * Original and copy of one real run: indikaai.com, made in exact copy mode on 15 Oct, first screen of the home page
 * (docs/redesign-notes.md: 0 % blank on either side). Every comparison on the site names its mode.
 */
export function CompareMock() {
  return (
    <div className="mk-compare">
      <div className="mk-compare__bar">
        <span className="mk-seg">
          <b>Computer</b>
          <span>Tablet</span>
          <span>Phone</span>
        </span>
        <Pill tone="ok">Exact copy mode</Pill>
      </div>
      <div className="mk-compare__pair">
        {(['original', 'copy'] as const).map((side) => (
          <figure key={side} className="mk-shot">
            <figcaption>{side === 'original' ? 'Original' : 'Copy'}</figcaption>
            <Image src={`/shots/indikaai-${side}.webp`} width={900} height={563} sizes="(min-width: 960px) 260px, 45vw" alt="" />
          </figure>
        ))}
      </div>
      <span className="mk-compare__site">indikaai.com, home page</span>
    </div>
  );
}

/* The report's "Still needs work" list, a real screen of the app (public/tool/f-needs.webp), with the three formats. */
export function ReportMock() {
  return (
    <div className="mk-report">
      <div className="mk-report__page">
        <Image src="/tool/f-needs.webp" width={1400} height={409} unoptimized alt="" />
      </div>
      <span className="mk-report__formats">
        <b>PDF</b>
        <b>HTML</b>
        <b>JSON</b>
      </span>
    </div>
  );
}

const KEPT = ['Markup', 'Styles', 'Fonts', 'Images', 'Animations', 'Hover effects', 'Clicks'];

export function KeptMock() {
  return (
    <div className="mk-kept">
      <ul>
        {KEPT.map((k) => (
          <li key={k}>
            <Check size={13} strokeWidth={3} aria-hidden="true" />
            {k}
          </li>
        ))}
      </ul>
      <span className="mk-kept__foot">
        Compared with the original at desktop and phone width <Pill tone="ok">Measured</Pill>
      </span>
    </div>
  );
}


/* The copy of a real run (indikaai.com, exact copy mode, see CompareMock) as it shows in the private preview. */
export function PreviewMock() {
  return (
    <div className="mk-preview">
      <div className="mk-preview__bar">
        <Lock size={13} aria-hidden="true" />
        <span>Private preview</span>
        <Pill tone="info">Not published</Pill>
      </div>
      <Image src="/shots/indikaai-copy.webp" width={900} height={563} sizes="(min-width: 1040px) 340px, 90vw" alt="" />
    </div>
  );
}

const ZIP_FILES = ['index.html', 'about/index.html', 'assets/  (images, fonts)', 'DEPLOY.md', 'RECREATE-REPORT.md'];

export function ZipMock() {
  return (
    <div className="mk-zip">
      <div className="mk-zip__head">
        <span className="mk-zip__ico" aria-hidden="true">
          <FileArchive size={20} />
        </span>
        <span>
          <b>your-site-html.zip</b>
          <small>Plain HTML / CSS / JS</small>
        </span>
        <span className="mk-btn">Download .zip</span>
      </div>
      <ul className="mk-zip__files">
        {ZIP_FILES.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </div>
  );
}

export function AddressMock() {
  return (
    <div className="mk-form">
      <b className="mk-form__title">Add a website</b>
      <span className="mk-form__label">Website URL</span>
      <span className="mk-input">
        <span className="mk-type">https://yoursite.com</span>
      </span>
      <span className="mk-check">
        <span className="mk-tick mk-tick--ok" aria-hidden="true">
          <Check size={12} strokeWidth={3} />
        </span>
        I confirm this website belongs to our company, or we may use it.
      </span>
      <span className="mk-btn mk-btn--end">Add website</span>
    </div>
  );
}

const STAGES: [string, number][] = [
  ['Visit every page', 100],
  ['Save images and files', 100],
  ['Build the new pages', 64],
  ['Check the result', 0],
];

export function CopyMock() {
  return (
    <ul className="mk-stages">
      {STAGES.map(([name, p]) => (
        <li key={name} data-state={p === 100 ? 'done' : p > 0 ? 'run' : 'wait'}>
          <span className="mk-stages__top">
            <span>{name}</span>
            <small>{p === 100 ? 'Done' : p > 0 ? 'Working' : 'Waiting'}</small>
          </span>
          <span className="mk-bar">
            <i style={{ width: `${p}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
