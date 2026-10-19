import { Accessibility, Check, Flag, Gauge, Link2Off, Search, ShieldCheck, Terminal } from 'lucide-react';
import { Badge, BrowserFrame, type Tone } from '@/components/ui';

/*
 * The audit report, compact (about 480×320), built in HTML/CSS. Categories and issue types are real checks of the
 * tool; the statuses and issues shown are an illustration, so it shows status words instead of invented scores.
 * Broken links and console errors are always "Flagged for you".
 */

export const AUDIT_CHECKS = [
  { Icon: Gauge, name: 'Performance' },
  { Icon: Search, name: 'SEO' },
  { Icon: Accessibility, name: 'Accessibility' },
  { Icon: ShieldCheck, name: 'Best practices' },
  { Icon: Link2Off, name: 'Broken links' },
  { Icon: Terminal, name: 'Console errors' },
];

const STATUS: Array<[string, Tone]> = [
  ['Needs work', 'warn'],
  ['Needs work', 'warn'],
  ['Issues', 'bad'],
  ['Good', 'ok'],
  ['Found', 'warn'],
  ['Found', 'warn'],
];

const ISSUES: Array<{ issue: string; area: string; fixed: boolean }> = [
  { issue: 'Images without alt text', area: 'Accessibility', fixed: true },
  { issue: 'Missing page descriptions', area: 'SEO', fixed: true },
  { issue: 'Broken link', area: 'Broken links', fixed: false },
];

export default function AuditReport({ site = 'yoursite.com' }: { site?: string }) {
  return (
    <BrowserFrame addr={`Audit report · ${site}`} tag="Illustration" className="viz audit">
      <div className="audit__body">
        <ul className="audit__cats">
          {AUDIT_CHECKS.map(({ Icon, name }, i) => (
            <li key={name}>
              <span className="audit__cat-icon" aria-hidden="true">
                <Icon size={15} />
              </span>
              <span className="audit__cat-name">{name}</span>
              <Badge tone={STATUS[i][1]}>{STATUS[i][0]}</Badge>
            </li>
          ))}
        </ul>
        <ul className="audit__issues">
          {ISSUES.map((it) => (
            <li key={it.issue}>
              <span className="audit__issue">
                {it.issue}
                <small>{it.area}</small>
              </span>
              {it.fixed ? (
                <Badge tone="ok">
                  <Check size={12} strokeWidth={3} aria-hidden="true" /> Fixed in your copy
                </Badge>
              ) : (
                <Badge tone="info">
                  <Flag size={12} aria-hidden="true" /> Flagged for you
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    </BrowserFrame>
  );
}
