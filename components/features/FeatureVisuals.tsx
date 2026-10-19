import { Accessibility, Check, FileCode2, FileJson, FileText, Flag, Gauge, Link2Off, Loader, Monitor, Search, ShieldCheck, Smartphone, Tablet, Terminal } from 'lucide-react';
import { Badge, FrameBar, type Tone } from '@/components/ui';

/*
 * Compact visuals for the Features page (max 480×320), one per capability, never reused elsewhere.
 * Each is a short CSS loop (transform/opacity only) that only plays while on screen ([data-loop], InViewPlay) and
 * is static under prefers-reduced-motion. Statuses and code are illustrations; no numbers are shown.
 */

/* ---------- Audit: six checks resolve one by one ---------- */

const CHECKS: Array<{ Icon: typeof Gauge; name: string; status: string; tone: Tone }> = [
  { Icon: Gauge, name: 'Performance', status: 'Needs work', tone: 'warn' },
  { Icon: Search, name: 'SEO', status: 'Needs work', tone: 'warn' },
  { Icon: Accessibility, name: 'Accessibility', status: 'Issues found', tone: 'bad' },
  { Icon: ShieldCheck, name: 'Best practices', status: 'Good', tone: 'ok' },
  { Icon: Link2Off, name: 'Broken links', status: 'Flagged', tone: 'info' },
  { Icon: Terminal, name: 'Console errors', status: 'Flagged', tone: 'info' },
];

export function AuditMini() {
  return (
    <div className="viz frame am" data-loop aria-hidden="true">
      <FrameBar addr="Auditing yoursite.com" tag="Illustration" />
      <ul className="am__rows">
        {CHECKS.map(({ Icon, name, status, tone }, i) => (
          <li key={name} style={{ ['--i' as string]: i }}>
            <Icon size={16} className="am__icon" />
            <span className="am__name">{name}</span>
            <span className="am__state">
              <Loader size={15} className="am__spin" />
              <Badge tone={tone} className="am__badge">
                {status}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Kept as-is: a cursor hovers a button, clicks a menu, cards fade in ---------- */

export function KeptMini() {
  return (
    <div className="viz km" data-loop aria-hidden="true">
      <div className="frame">
        <FrameBar addr="preview · your copy" />
        <div className="km__page">
          <span className="km__logo" />
          <span className="km__link" style={{ left: '20%' }} />
          <span className="km__link" style={{ left: '32%' }} />
          <span className="km__menu">
            Menu
            <span className="km__drop">
              <i />
              <i />
              <i />
            </span>
          </span>
          <span className="km__l1" />
          <span className="km__l2" />
          <span className="km__btn">Get started</span>
          <span className="km__art" />
          <span className="km__cards">
            <i />
            <i />
            <i />
          </span>
          <span className="km__pointer">
            <svg className="km__cursor" viewBox="0 0 24 24" width="20" height="20">
              <path d="M5 3l14 8-6 1.6L10 19z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </div>
      <div className="km__events">
        <span className="km__ev km__ev--1">Animation</span>
        <span className="km__ev km__ev--2">Hover</span>
        <span className="km__ev km__ev--3">Click</span>
      </div>
    </div>
  );
}

/* ---------- Fixed for you: a small diff of what the copy changes ---------- */

const DIFF: Array<{ area: string; del: string; add?: string }> = [
  { area: 'Accessibility', del: '<img src="team.jpg">', add: '<img src="team.jpg" alt="Our team">' },
  { area: 'SEO', del: '<title></title>', add: '<title>Yoursite · Home</title>' },
  { area: 'Speed', del: '<script src="unused.js"></script>' },
];

export function FixedMini() {
  return (
    <div className="viz frame fm" data-loop aria-hidden="true">
      <FrameBar addr="index.html · your copy" tag="Illustration" />
      <div className="fm__body">
        {DIFF.map((d, i) => (
          <div key={d.area} className="fm__hunk" style={{ ['--i' as string]: i }}>
            <span className="fm__area">{d.area}</span>
            <code className="fm__line fm__line--del">
              <b>−</b>
              {d.del}
            </code>
            {d.add ? (
              <code className="fm__line fm__line--add">
                <b>+</b>
                {d.add}
              </code>
            ) : (
              <code className="fm__line fm__line--note">
                <b>✓</b>removed
              </code>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Four stacks: the active stack cycles, its entry file shows ---------- */

const STACK_CODE = [
  { name: 'HTML', file: 'index.html', code: ['<!doctype html>', '<html lang="en">', '  <body>…</body>'] },
  { name: 'React + Vite', file: 'src/App.jsx', code: ['export default function App() {', '  return <Home />;', '}'] },
  { name: 'Next.js', file: 'app/page.tsx', code: ['export default function Page() {', '  return <Home />;', '}'] },
  { name: 'MERN', file: 'server/index.js', code: ["app.post('/api/contact', save);", 'app.listen(PORT);', ''] },
];

export function StacksMini() {
  return (
    <div className="viz sk" data-loop aria-hidden="true">
      <div className="sk__chips">
        <span className="sk__pill" />
        {STACK_CODE.map((s) => (
          <span key={s.name} className="sk__chip">
            {s.name}
          </span>
        ))}
      </div>
      <div className="frame sk__code">
        <div className="sk__files">
          {STACK_CODE.map((s, i) => (
            <div key={s.name} className="sk__file" style={{ ['--i' as string]: i }}>
              <p className="sk__path">
                <FileCode2 size={13} /> {s.file}
              </p>
              {s.code.map((line, j) => (
                <code key={j}>{line || ' '}</code>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Compare view: original and copy scroll together; the device switches ---------- */

function Pane({ label }: { label: string }) {
  return (
    <div className="cv__pane">
      <span className="cv__label">{label}</span>
      <div className="cv__screen">
        <div className="cv__scroll">
          {Array.from({ length: 2 }, (_, k) => (
            <div key={k} className="cv__page">
              <i className="cv__nav" />
              <i className="cv__h" />
              <i className="cv__p" />
              <i className="cv__img" />
              <i className="cv__p" />
              <i className="cv__p cv__p--s" />
              <i className="cv__img cv__img--s" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CompareMini() {
  return (
    <div className="viz cv" data-loop aria-hidden="true">
      <div className="cv__bar">
        <span className="cv__devices">
          <span className="cv__dev cv__dev--1">
            <Monitor size={13} /> Computer
          </span>
          <span className="cv__dev cv__dev--2">
            <Tablet size={13} /> Tablet
          </span>
          <span className="cv__dev cv__dev--3">
            <Smartphone size={13} /> Phone
          </span>
        </span>
        <span className="cv__sync">Scroll together</span>
      </div>
      <div className="cv__panes">
        <Pane label="Original" />
        <Pane label="Copy" />
      </div>
      <p className="cv__foot">Match score for every page · below 80 flagged</p>
    </div>
  );
}

/* ---------- Report: three formats, the front file cycles ---------- */

const FILES = [
  { Icon: FileText, name: 'audit-report.pdf', kind: 'PDF' },
  { Icon: FileCode2, name: 'audit-report.html', kind: 'HTML' },
  { Icon: FileJson, name: 'audit-report.json', kind: 'JSON' },
];

export function ReportMini() {
  return (
    <div className="viz rf" data-loop aria-hidden="true">
      {FILES.map(({ Icon, name, kind }, i) => (
        <div key={kind} className="rf__file" style={{ ['--i' as string]: i }}>
          <div className="rf__head">
            <span className="rf__icon">
              <Icon size={18} />
            </span>
            <span className="rf__name">{name}</span>
            <span className="rf__kind">{kind}</span>
          </div>
          <i className="rf__line rf__line--lg" />
          <i className="rf__line" />
          <div className="rf__rows">
            <span>
              <Check size={12} strokeWidth={3} /> Fixed in your copy
            </span>
            <span>
              <Flag size={12} /> Flagged for you
            </span>
          </div>
          <i className="rf__line rf__line--s" />
        </div>
      ))}
    </div>
  );
}
