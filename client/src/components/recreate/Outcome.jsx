import { useState } from 'react';
import { ArrowRight, ChevronDown, Trophy } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Card } from '../common/Surface.jsx';
import { Pill } from '../common/Score.jsx';
import InfoTip from '../common/InfoTip.jsx';
import CountUp from '../common/CountUp.jsx';
import { CHECKS, HEALTH, matchRating, OUTSIDE, RESULT_STATUS, TERMS } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './Outcome.module.css';
import { stackById } from '../../constants.js';
import { copiedPages } from '../../copiedPages.js';
import { WORSE_CAUSES, worseSplit } from '../../siteData.js';

// Before → after scores shown (phone measurements: most visitors).
const SCORES = [
  ['performance', 'performance'],
  ['seo', 'seo'],
  ['accessibility', 'accessibility'],
];

const titleOf = (item) => CHECKS[item.title]?.title ?? CHECKS[item.title?.split(' · ')[0]]?.title ?? item.title;

// Rows shown at first in each list; the rest open with "Show all".
const FIRST_ROWS = 6;

/**
 * One list of rows, its count in the title: the ones that got worse, the ones still open on both sides, or the ones that only
 * read worse for one reason (`explain` says why; `first` rows shown before "Show all", 0 = folded).
 */
function RowList({ title, tone, explain, items, first = FIRST_ROWS }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, first);
  return (
    <div className={styles.todo}>
      <p className={styles.todoTitle}>
        <span className={styles.tone} data-tone={tone} aria-hidden="true" />
        {title} <span className={`${styles.todoCount} tabular`}>{items.length}</span>
      </p>
      {explain && <p className={styles.todoExplain}>{explain}</p>}
      <ul>
        {shown.map((item) => (
          <li key={item.key}>
            <span className={styles.todoName}>{titleOf(item)}</span>
            {item.after?.detail && (
              <span className={`${styles.todoDetail} ${styles.oneLine}`} title={item.reasonEvidence ?? item.after.detail}>
                {item.after.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
      {items.length > first && (
        <Button variant="ghost" size="sm" icon={ChevronDown} className={styles.more} data-open={all || undefined} aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : first ? `Show all ${items.length}` : `Show the ${plural(items.length, 'row')}`}
        </Button>
      )}
    </div>
  );
}

/**
 * The result in one card: a plain summary, four counts, the main scores before → after, the overall match, and the few
 * rows that got worse or still need work (every one of them, the first few shown at once). `comparison` is the real before / after comparison (null until it exists).
 */
export default function Outcome({ result, comparison }) {
  const match = result.fidelity?.score ?? null;
  const m = matchRating(match);
  const s = comparison?.summary ?? null;
  // Rows outside what Remastly can change (server copy/gotWorse.js markOutside) are not "got worse" / "still open": the counts
  // (summary) leave them out, and so do the lists below. They are shown in their own calm section of the checklist.
  const own = (comparison?.items ?? []).filter((i) => !i.outside);
  const outsideN = comparison?.outside?.total ?? 0;
  // "Got worse" split by cause: the rows the copy may really be worse on, and the ones that only read worse for a reason the
  // run measured (an as-is copy: server copy/gotWorse.js). Only the first count as "got worse", here and everywhere.
  const worse = worseSplit(comparison);
  // An as-is copy: how many of its own "still open" rows carry a reason, and how many none fits.
  const stillOpen = (() => {
    if (!comparison?.stillOpen) return null;
    const rows = own.filter((i) => i.status === 'open');
    return { explained: rows.filter((i) => i.reason).length, unexplained: rows.filter((i) => !i.reason).length };
  })();
  const better = s ? (s.fixed ?? 0) + (s.improved ?? 0) : 0;
  const rowsOf = (status) => own.filter((i) => i.status === status);
  const before = comparison?.scores?.before?.mobile;
  const after = comparison?.scores?.after?.mobile;

  // The one plain line of "Copy my site" (the same words as server/src/copy/regress.js summaryLine).
  const stackName = stackById(result.stack)?.label ?? result.stack ?? '';
  const pagesN = copiedPages(result).length;
  const fixedN = s ? (s.fixed ?? 0) + (s.improved ?? 0) : 0;
  const summaryText = `${plural(pagesN, 'page')} copied${stackName ? ` in ${stackName}` : ''} · ${result.asIs ? pagesN : 0} as-is, ${result.asIs ? 0 : pagesN} rebuilt · ${s ? `Got worse: ${worse.realCount}${worse.explained ? ` (${worse.explained} more only read worse, explained below)` : ''} · Fixed: ${fixedN} · Still open: ${s.open ?? 0}${stillOpen ? ` (${stillOpen.explained} with a reason, ${stillOpen.unexplained} unexplained)` : ''}` : 'Got worse: not measured yet (the check after the copy has not finished)'}`;

  const sentence = [
    `The copy has ${plural(copiedPages(result).length, 'page')}`,
    match != null ? `. How closely it matches the original: ${m.label.toLowerCase()} (${match}/100).` : '.',
    s ? ` Compared with the original, ${plural(better, 'thing')} got better${worse.realCount ? `, ${worse.realCount} got worse` : ''} and ${s.open ?? 0} still need${(s.open ?? 0) === 1 ? 's' : ''} work.` : '',
  ].join('');

  return (
    <Card icon={Trophy} title="How the copy turned out">
      <p className={styles.sentence}><strong>{summaryText}</strong></p>
      <p className={styles.sentence}>{sentence}</p>

      {s && (
        <ul className={styles.counts}>
          {[
            ['better', better, RESULT_STATUS.fixed.tone, 'Better than the original', `${RESULT_STATUS.fixed.explain} Or: ${RESULT_STATUS.improved.explain.toLowerCase()}`],
            ['open', s.open ?? 0, (s.open ?? 0) ? 'warn' : 'neutral', RESULT_STATUS.open.label, RESULT_STATUS.open.explain],
            ['regressed', worse.realCount, worse.realCount ? 'bad' : 'neutral', RESULT_STATUS.regressed.label, `${RESULT_STATUS.regressed.explain}${worse.explained ? ` Not counted: ${plural(worse.explained, 'row')} that only read worse, for a reason shown below the counts.` : ''}`],
            ['manual', s.manual ?? 0, 'neutral', RESULT_STATUS.manual.label, RESULT_STATUS.manual.explain],
          ].map(([id, n, tone, label, tip]) => (
            <li key={id} data-tone={tone}>
              <strong>
                <CountUp value={n} />
              </strong>
              <span>
                {label}
                <InfoTip label={label}>{tip}</InfoTip>
              </span>
            </li>
          ))}
        </ul>
      )}
      {s && worse.explained > 0 && (
        <p className={styles.worseNote}>
          {plural(worse.explained, 'more check')} only read worse, and the copy is not the cause: the reason for each is below.
          They are not counted as “{RESULT_STATUS.regressed.label}”.
        </p>
      )}

      {outsideN > 0 && <p className={styles.todoDetail}>{OUTSIDE.line(outsideN)}</p>}

      <div className={styles.facts}>
        {match != null && (
          <div className={styles.fact}>
            <span className={styles.factLabel}>
              {TERMS.fidelity.title}
              <InfoTip label={TERMS.fidelity.title} align="start">
                {TERMS.fidelity.explain}
              </InfoTip>
            </span>
            <span className={styles.factValue}>{match}/100</span>
            <Pill tone={m.tone}>{m.label}</Pill>
          </div>
        )}
        {before &&
          after &&
          SCORES.map(([key, h]) =>
            before[key] != null && after[key] != null ? (
              <div key={key} className={styles.fact}>
                <span className={styles.factLabel}>{HEALTH[h].title} on phones</span>
                <span className={styles.factValue}>
                  {before[key]} <ArrowRight size={14} aria-label="to" /> {after[key]}
                </span>
                <Pill tone={after[key] > before[key] ? 'ok' : after[key] < before[key] ? 'bad' : 'neutral'}>
                  {after[key] > before[key] ? 'Better' : after[key] < before[key] ? 'Worse' : 'Same'}
                </Pill>
              </div>
            ) : null,
          )}
      </div>

      <RowList title={RESULT_STATUS.regressed.label} tone={RESULT_STATUS.regressed.tone} items={worse.real} />
      <RowList title={RESULT_STATUS.open.label} tone={RESULT_STATUS.open.tone} items={rowsOf('open')} />
      {Object.entries(WORSE_CAUSES).map(([group, why]) => (
        <RowList key={group} title={why.title} tone="neutral" explain={why.text} items={worse.byReason[group] ?? []} first={group === 'measurement' ? 0 : FIRST_ROWS} />
      ))}
    </Card>
  );
}
