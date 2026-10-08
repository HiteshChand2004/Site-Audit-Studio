import { ArrowRight, Columns2, ListChecks, Play, Sparkles } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { CopyArt } from '../../components/common/Illustrations.jsx';
import { problemsOf } from '../../components/audit/FixList.jsx';
import { summarize } from '../../components/audit/HealthOverview.jsx';
import { BrowserShot } from '../../components/site/Site.jsx';
import { hostOf, stackById } from '../../constants.js';
import { CHECKS, matchRating, RESULT_STATUS, SEVERITY, TERMS } from '../../copy.js';
import { plural, timeAgo } from '../../format.js';
import { comparisonOf, copyShot, isReal, originalShot, platformOf, useSiteData } from '../../siteData.js';
import { useProjects } from '../../store/useProjects.js';
import { HOW } from '../Home.jsx';
import styles from './OverviewStep.module.css';

const titleOf = (item) => CHECKS[item.title]?.title ?? CHECKS[item.title?.split(' · ')[0]]?.title ?? item.title;

/** A website that has not been checked yet: the four steps, the first one to start. */
function FirstSteps({ project, onGo }) {
  const analyze = useProjects((s) => s.analyze);
  return (
    <div className={styles.first}>
      <div className={styles.firstHead}>
        <span className="eyebrow">Start here</span>
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

/** Where each stage stands, as a vertical line of four steps; each opens its section. */
function Progress({ audit, result, stages, onGo }) {
  const cmp = comparisonOf(audit);
  const rows = [
    {
      id: 'check',
      title: 'Check the original',
      state: stages.check,
      text: isReal(audit) ? `${timeAgo(audit.analyzedAt)} · ${plural(audit.pagesCrawled ?? 0, 'page')} read` : 'Not checked yet',
    },
    {
      id: 'create',
      title: 'Make the copy',
      state: stages.copy,
      text: result ? `${timeAgo(result.createdAt)} · ${plural(result.pages.length, 'page')} in ${stackById(result.stack).short}` : 'Not made yet',
    },
    {
      id: 'compare',
      title: 'Compare page by page',
      state: result ? 'done' : 'none',
      text: result?.fidelity?.score != null ? `${result.fidelity.score}/100 match · ${matchRating(result.fidelity.score).label.toLowerCase()}` : result ? 'Ready to look at' : 'After the copy',
    },
    {
      id: 'results',
      title: 'Results & download',
      state: stages.results,
      text: cmp ? `Compared ${timeAgo(cmp.reauditedAt)}` : result ? 'Not compared yet' : 'After the copy',
    },
  ];
  return (
    <section className={styles.card} aria-labelledby="ov-progress">
      <h3 id="ov-progress" className={styles.cardTitle}>
        Progress
      </h3>
      <ol className={styles.timeline}>
        {rows.map((r) => (
          <li key={r.id} data-state={r.state}>
            <span className={styles.node} aria-hidden="true" />
            <button type="button" onClick={() => onGo(r.id)}>
              <span className={styles.tlTitle}>{r.title}</span>
              <span className={styles.tlText}>{r.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Plain facts about the site and its copy. */
function Facts({ audit, result, project }) {
  const platform = platformOf(audit);
  const broken = audit.brokenLinks?.broken?.length ?? 0;
  const a11y = (audit.accessibility ?? []).reduce((n, a) => n + (a.count ?? 1), 0);
  const rows = [
    ['Built with', platform?.name ?? 'Not recognised'],
    ['Pages found', audit.pagesCrawled ?? '–'],
    ['Links that lead nowhere', broken],
    ['Accessibility problems', `${a11y} on the homepage`],
    ['Needs a person', audit.manualRebuild?.length ? plural(audit.manualRebuild.length, 'part') : 'Nothing'],
    result && ['Copy technology', stackById(result.stack ?? project.stack).name],
    result?.fidelity?.score != null && [TERMS.fidelity.title, `${result.fidelity.score}/100`],
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
  const { result, stages } = useSiteData(project.id);
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
  const match = result?.fidelity?.score ?? null;
  const m = matchRating(match);

  // What needs a look: the comparison's open / worse items, else the original's problems.
  const todo = cmp
    ? (cmp.items ?? [])
        .filter((i) => i.status === 'regressed' || i.status === 'open')
        .sort((a, b) => (a.status === 'regressed' ? 0 : 1) - (b.status === 'regressed' ? 0 : 1))
        .map((i) => ({ id: i.key, tone: RESULT_STATUS[i.status]?.tone ?? 'warn', label: RESULT_STATUS[i.status]?.label ?? i.status, title: titleOf(i), detail: i.after?.detail }))
    : problemsOf(audit).rows.map((r) => ({ id: r.id, tone: SEVERITY[r.severity]?.tone ?? 'warn', label: SEVERITY[r.severity]?.label, title: r.title, detail: r.area }));

  return (
    <div className={styles.grid}>
      <div className={styles.main}>
        <p className={styles.summary}>{summarize(audit, 'mobile').join(' ')}</p>

        <section className={styles.card} aria-labelledby="ov-ba">
          <div className={styles.cardHead}>
            <h3 id="ov-ba" className={styles.cardTitle}>
              {result ? 'Original and copy' : 'The original'}
            </h3>
            {match != null && (
              <span className={styles.match} data-tone={m.tone}>
                <strong className="tabular">{match}</strong>/100 · {m.label}
              </span>
            )}
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
                  Set up the copy
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="ov-todo">
          <div className={styles.cardHead}>
            <h3 id="ov-todo" className={styles.cardTitle}>
              {cmp ? 'Still needs a look in the copy' : 'What needs fixing on the original'}
            </h3>
            <span className={styles.muted}>{plural(todo.length, 'item')}</span>
          </div>
          {todo.length === 0 ? (
            <p className={styles.muted}>Nothing left to do: every check passes or was fixed.</p>
          ) : (
            <ul className={styles.todo}>
              {todo.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <span className={styles.tone} data-tone={t.tone}>
                    {t.label}
                  </span>
                  <span className={styles.todoTitle}>{t.title}</span>
                  {t.detail && <span className={styles.todoDetail}>{t.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className={styles.cardFoot}>
            {todo.length > 6 && <span className={styles.muted}>and {todo.length - 6} more</span>}
            <Button size="sm" variant="ghost" icon={cmp ? ListChecks : ArrowRight} onClick={() => onGo(cmp ? 'results' : 'check')}>
              {cmp ? 'Every check, before and after' : 'The full check'}
            </Button>
          </div>
        </section>
      </div>

      <aside className={styles.side}>
        <Progress audit={audit} result={result} stages={stages} onGo={onGo} />
        <Facts audit={audit} result={result} project={project} />
      </aside>
    </div>
  );
}
