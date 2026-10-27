import { ArrowRight, Columns2, ListChecks, Play, Sparkles } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import Details from '../../components/common/Details.jsx';
import { CopyArt } from '../../components/common/Illustrations.jsx';
import { problemsOf } from '../../components/audit/FixList.jsx';
import { summarize } from '../../components/audit/HealthOverview.jsx';
import { BrowserShot } from '../../components/site/Site.jsx';
import { hostOf, stackById } from '../../constants.js';
import { COPY_KIND, copyStackOf, reasonWord, RESULT_WORD_FOR, resultTitle, SEVERITY, TERMS } from '../../copy.js';
import { plural, timeAgo } from '../../format.js';
import { comparisonOf, copyShot, isReal, originalShot, outcomeCounts, platformOf, useSiteData } from '../../siteData.js';
import { useProjects } from '../../store/useProjects.js';
import { HOW } from '../Home.jsx';
import styles from './OverviewStep.module.css';

/** A website that has not been checked yet: the four steps, the first one to start. */
function FirstSteps({ project, onGo }) {
  const analyze = useProjects((s) => s.analyze);
  return (
    <div className={styles.first}>
      <div className={styles.firstHead}>
        <span className="eyebrow intro">Start here</span>
        <h2 className={styles.firstTitle}>Four steps to a better copy of {hostOf(project.url)}</h2>
        <p className={styles.muted}>Each step unlocks the next. The original website is only read, never changed.</p>
      </div>
      <ol className={styles.steps}>
        {HOW.map(({ n, art: Art, title, text }, i) => (
          <li key={n} data-current={i === 0 || undefined} style={{ animationDelay: `${i * 70}ms` }}>
            <div className={styles.stepArt}>
              <Art />
            </div>
            <span className={`${styles.stepNum} tabular`}>{n}</span>
            <h3>{title}</h3>
            <p>{text}</p>
            {i === 0 && (
              <Button
                variant="primary"
                icon={Play}
                onClick={() => {
                  analyze(project.id);
                  onGo('check');
                }}
              >
                Check the site
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Plain facts about the site and its copy, inside "Show details" (what it is made with and its pages are key points). */
function Facts({ audit, result, project }) {
  const broken = audit.brokenLinks?.broken?.length ?? 0;
  const a11y = (audit.accessibility ?? []).reduce((n, a) => n + (a.count ?? 1), 0);
  const rows = [
    ['Links that lead nowhere', broken],
    ['Accessibility problems', `${a11y} on the homepage`],
    ['Needs a person', audit.manualRebuild?.length ? plural(audit.manualRebuild.length, 'part') : 'Nothing'],
    result && ['Copy technology', stackById(copyStackOf(result, project.stack)).name],
  ].filter(Boolean);
  return (
    <section className={styles.card} aria-labelledby="ov-facts">
      <h3 id="ov-facts" className={styles.cardTitle}>
        About this site
      </h3>
      <dl className={styles.facts}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="tabular">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Overview: the summary of everything, with a way into each section. */
export default function OverviewStep({ project, audit, loading, onGo }) {
  const { result } = useSiteData(project.id);
  if (loading && !audit) {
    return (
      <div className={styles.loading} aria-hidden="true">
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    );
  }
  if (!isReal(audit)) return <FirstSteps project={project} onGo={onGo} />;

  const host = hostOf(project.url);
  const cmp = comparisonOf(audit);
  const shot = originalShot(project.id, audit, result, 'fold');
  const copy = copyShot(project.id, result);

  // What needs a look: the comparison's worse / open items (got worse first, each with its reason in plain words), else the
  // original's problems.
  const todo = cmp
    ? (cmp.items ?? [])
        .filter((i) => i.status === 'regressed' || i.status === 'open')
        .sort((a, b) => (a.status === 'regressed' ? 0 : 1) - (b.status === 'regressed' ? 0 : 1))
        .map((i) => ({ id: i.key, tone: i.status === 'regressed' ? 'bad' : 'warn', label: RESULT_WORD_FOR[i.status], title: resultTitle(i), detail: reasonWord(i), tip: i.after?.detail }))
    : problemsOf(audit).rows.map((r) => ({ id: r.id, tone: SEVERITY[r.severity]?.tone ?? 'warn', label: SEVERITY[r.severity]?.label, title: r.title, detail: r.area }));

  // Six rows, but never fewer than every "Got worse" row: a worse result is never left out.
  const shown = Math.max(6, todo.filter((i) => i.tone === 'bad' && cmp).length);

  // The one-line answer, then the key points.
  const counts = outcomeCounts(audit);
  const platform = platformOf(audit);
  const answer = counts
    ? `Your copy is ready: ${counts.better} better, ${counts.open} still ${counts.open === 1 ? 'needs' : 'need'} work, ${counts.regressed} got worse.`
    : result
      ? 'Your copy is ready. It has not been compared with the original yet.'
      : `Checked ${timeAgo(audit.analyzedAt)}: ${plural(todo.length, 'thing')} to fix on the original.`;
  const points = [
    ...summarize(audit, 'mobile').slice(0, 3),
    platform && `Made with ${platform.name}.`,
    `${plural(audit.pagesCrawled ?? 0, 'page')} found.`,
    result && `Your copy: ${COPY_KIND[copyStackOf(result, project.stack)] ?? stackById(copyStackOf(result, project.stack)).name}.`,
  ].filter(Boolean);

  return (
    <div className={styles.main}>
      <p className={styles.answer}>
        <strong>{answer}</strong>
      </p>
      <ul className={styles.points}>
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>

      <section className={styles.card} aria-labelledby="ov-ba">
        <div className={styles.cardHead}>
          <h3 id="ov-ba" className={styles.cardTitle}>
            {result ? 'Original and copy' : 'The original'}
          </h3>
        </div>
        {result ? (
          <>
            <div className={styles.pair}>
              <figure>
                <BrowserShot src={shot} address={host} alt={`The original ${host}`} ratio={16 / 10} />
                <figcaption>
                  <i data-side="old" /> {TERMS.original}
                </figcaption>
              </figure>
              <figure>
                <BrowserShot src={copy} address="the copy" alt={`The copy of ${host}`} ratio={16 / 10} />
                <figcaption>
                  <i data-side="new" /> {TERMS.copy}
                </figcaption>
              </figure>
            </div>
            <div className={styles.cardFoot}>
              <span className={styles.muted}>Homepage on a computer screen. Every page and screen size is in Compare.</span>
              <Button size="sm" icon={Columns2} onClick={() => onGo('compare')}>
                Compare page by page
              </Button>
            </div>
          </>
        ) : (
          <div className={styles.noCopy}>
            <BrowserShot src={shot} address={host} alt={`The original ${host}`} ratio={16 / 10} />
            <div className={styles.noCopyText}>
              <CopyArt className={styles.noCopyArt} />
              <h4>No copy yet</h4>
              <p className={styles.muted}>The copy visits every page, saves its images and rebuilds it cleanly, fixing what the check found.</p>
              <Button variant="primary" icon={Sparkles} onClick={() => onGo('create')}>
                Make the copy
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className={styles.card} aria-labelledby="ov-todo">
        <div className={styles.cardHead}>
          <h3 id="ov-todo" className={styles.cardTitle}>
            {cmp ? 'Got worse and still needs work' : 'What needs fixing on the original'}
          </h3>
          <span className={styles.muted}>{plural(todo.length, 'item')}</span>
        </div>
        {todo.length === 0 ? (
          <p className={styles.muted}>Nothing left to do: every check passes or was fixed.</p>
        ) : (
          <ul className={styles.todo}>
            {todo.slice(0, shown).map((t) => (
              <li key={t.id}>
                <span className={styles.tone} data-tone={t.tone}>
                  {t.label}
                </span>
                <span className={styles.todoTitle} title={t.tip ?? undefined}>
                  {t.title}
                </span>
                {t.detail && <span className={styles.todoDetail}>{t.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.cardFoot}>
          {todo.length > shown && <span className={styles.muted}>and {todo.length - shown} more</span>}
          <Button size="sm" variant="ghost" icon={cmp ? ListChecks : ArrowRight} onClick={() => onGo(cmp ? 'results' : 'check')}>
            {cmp ? 'See all results' : 'The full check'}
          </Button>
        </div>
      </section>

      <Details>
        <Facts audit={audit} result={result} project={project} />
      </Details>
    </div>
  );
}
