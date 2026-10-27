import { ArrowRight, Trophy } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { Pill } from '../common/Score.jsx';
import InfoTip from '../common/InfoTip.jsx';
import CountUp from '../common/CountUp.jsx';
import { HEALTH, reasonWord, RESULT_EXPLAIN, RESULT_WORDS, resultTitle } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './Outcome.module.css';
import { STACKS } from '../../constants.js';
import { copiedPages } from '../../copiedPages.js';

// Before → after scores shown (phone measurements: most visitors).
const SCORES = ['performance', 'seo', 'accessibility'];

const places = (n) => `${n} ${n === 1 ? 'place' : 'places'}`;

/**
 * The result in one card: the one-line answer, the four counts, the main scores before → after, and every row that got
 * worse or still needs work (got worse first), each with its reason in plain words. Nothing bad is left out or folded away.
 * `comparison` is the real before / after comparison (null until it exists).
 */
export default function Outcome({ result, comparison }) {
  const s = comparison?.summary ?? null;
  const better = s ? (s.fixed ?? 0) + (s.improved ?? 0) : 0;
  const todo = (comparison?.items ?? [])
    .filter((i) => i.status === 'regressed' || i.status === 'open')
    .sort((a, b) => (a.status === 'regressed' ? 0 : 1) - (b.status === 'regressed' ? 0 : 1));
  const before = comparison?.scores?.before?.mobile;
  const after = comparison?.scores?.after?.mobile;

  // The copy's own technology, as Results' download card reads it (an as-is copy is packaged in result.asIs.stack), by its
  // readable name; an id the app does not know is shown as it is rather than as another technology.
  const stackId = result.asIs?.stack ?? result.stack;
  const stackName = (stackId && STACKS.find((x) => x.id === stackId)?.name) ?? stackId ?? '';
  const pagesN = copiedPages(result).length;

  const answer = s
    ? `Your copy is better than the original in ${places(better)}, still needs work in ${s.open ?? 0}, and ${s.regressed ?? 0} got worse.`
    : 'Your copy is ready. It has not been compared with the original yet, so what got better or worse is not known.';

  return (
    <Card icon={Trophy} title="How the copy turned out">
      <p className={styles.sentence}>
        <strong>{answer}</strong>
      </p>
      <p className={styles.sentence}>
        {plural(pagesN, 'page')} copied{stackName ? ` in ${stackName}` : ''}.
      </p>

      {s && (
        <ul className={styles.counts}>
          {[
            ['better', better, 'ok'],
            ['open', s.open ?? 0, (s.open ?? 0) ? 'warn' : 'neutral'],
            ['regressed', s.regressed ?? 0, (s.regressed ?? 0) ? 'bad' : 'neutral'],
            ['manual', s.manual ?? 0, 'neutral'],
          ].map(([id, n, tone]) => (
            <li key={id} data-tone={tone}>
              <strong>
                <CountUp value={n} />
              </strong>
              <span>
                {RESULT_WORDS[id]}
                <InfoTip label={RESULT_WORDS[id]}>{RESULT_EXPLAIN[id]}</InfoTip>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.facts}>
        {before &&
          after &&
          SCORES.map((key) =>
            before[key] != null && after[key] != null ? (
              <div key={key} className={styles.fact}>
                <span className={styles.factLabel}>{HEALTH[key].title} on phones</span>
                <span className={styles.factValue}>
                  {before[key]} <ArrowRight size={14} aria-label="to" /> {after[key]}
                </span>
                <Pill tone={after[key] > before[key] ? 'ok' : after[key] < before[key] ? 'bad' : 'neutral'}>
                  {after[key] > before[key] ? RESULT_WORDS.better : after[key] < before[key] ? RESULT_WORDS.regressed : 'Same'}
                </Pill>
              </div>
            ) : null,
          )}
      </div>

      {todo.length > 0 && (
        <div className={styles.todo}>
          <p className={styles.todoTitle}>
            {RESULT_WORDS.regressed} and {RESULT_WORDS.open.toLowerCase()}
          </p>
          <ul>
            {todo.map((item) => {
              const why = reasonWord(item);
              return (
                <li key={item.key}>
                  <span className={styles.tone} data-tone={item.status === 'regressed' ? 'bad' : 'warn'}>
                    {RESULT_WORDS[item.status]}
                  </span>
                  <span className={styles.todoName} title={item.after?.detail ?? undefined}>
                    {resultTitle(item)}
                  </span>
                  {why && <span className={styles.todoDetail}>{why}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
