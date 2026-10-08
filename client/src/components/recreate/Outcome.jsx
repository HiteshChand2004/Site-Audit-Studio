import { ArrowRight, Trophy } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { Pill } from '../common/Score.jsx';
import InfoTip from '../common/InfoTip.jsx';
import { CHECKS, HEALTH, matchRating, RESULT_STATUS, TERMS } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './Outcome.module.css';

// Before → after scores shown (phone measurements: most visitors).
const SCORES = [
  ['performance', 'performance'],
  ['seo', 'seo'],
  ['accessibility', 'accessibility'],
];

const titleOf = (item) => CHECKS[item.title]?.title ?? CHECKS[item.title?.split(' · ')[0]]?.title ?? item.title;

/**
 * The result in one card: a plain summary, four counts, the main scores before → after, the overall match, and the few
 * things that still need work. `comparison` is the real before / after comparison (null until it exists).
 */
export default function Outcome({ result, comparison }) {
  const match = result.fidelity?.score ?? null;
  const m = matchRating(match);
  const s = comparison?.summary ?? null;
  const better = s ? (s.fixed ?? 0) + (s.improved ?? 0) : 0;
  const todo = (comparison?.items ?? []).filter((i) => i.status === 'regressed' || i.status === 'open').sort((a, b) => (a.status === 'regressed' ? 0 : 1) - (b.status === 'regressed' ? 0 : 1));
  const before = comparison?.scores?.before?.mobile;
  const after = comparison?.scores?.after?.mobile;

  const sentence = [
    `The copy has ${plural(result.pages.length, 'page')}`,
    match != null ? `. How closely it matches the original: ${m.label.toLowerCase()} (${match}/100).` : '.',
    s ? ` Compared with the original, ${plural(better, 'thing')} got better${s.regressed ? `, ${s.regressed} got worse` : ''} and ${s.open ?? 0} still need${(s.open ?? 0) === 1 ? 's' : ''} work.` : '',
  ].join('');

  return (
    <Card icon={Trophy} title="How the copy turned out">
      <p className={styles.sentence}>{sentence}</p>

      {s && (
        <ul className={styles.counts}>
          {[
            ['better', better, RESULT_STATUS.fixed.tone, 'Better than the original', `${RESULT_STATUS.fixed.explain} Or: ${RESULT_STATUS.improved.explain.toLowerCase()}`],
            ['open', s.open ?? 0, (s.open ?? 0) ? 'warn' : 'neutral', RESULT_STATUS.open.label, RESULT_STATUS.open.explain],
            ['regressed', s.regressed ?? 0, (s.regressed ?? 0) ? 'bad' : 'neutral', RESULT_STATUS.regressed.label, RESULT_STATUS.regressed.explain],
            ['manual', s.manual ?? 0, 'neutral', RESULT_STATUS.manual.label, RESULT_STATUS.manual.explain],
          ].map(([id, n, tone, label, tip]) => (
            <li key={id} data-tone={tone}>
              <strong>{n}</strong>
              <span>
                {label}
                <InfoTip label={label}>{tip}</InfoTip>
              </span>
            </li>
          ))}
        </ul>
      )}

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

      {todo.length > 0 && (
        <div className={styles.todo}>
          <p className={styles.todoTitle}>Still needs work</p>
          <ul>
            {todo.slice(0, 6).map((item) => (
              <li key={item.key}>
                <span className={styles.tone} data-tone={RESULT_STATUS[item.status]?.tone ?? 'warn'}>
                  {RESULT_STATUS[item.status]?.label ?? item.status}
                </span>
                <span className={styles.todoName}>{titleOf(item)}</span>
                {item.after?.detail && (
                  <span className={`${styles.todoDetail} ${styles.oneLine}`} title={item.after.detail}>
                    {item.after.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {todo.length > 6 && <p className={styles.todoDetail}>and {todo.length - 6} more in “Every check, before and after” below.</p>}
        </div>
      )}
    </Card>
  );
}
