import { ArrowRight, ArrowUpRight, Plus } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import CountUp from '../components/common/CountUp.jsx';
import { CheckArt, CompareArt, CopyArt, EmptySiteArt, ResultsArt } from '../components/common/Illustrations.jsx';
import { BrowserShot, SiteIcon, StageDots } from '../components/site/Site.jsx';
import { hostOf, stackById } from '../constants.js';
import { rating } from '../copy.js';
import { plural, timeAgo } from '../format.js';
import { copyShot, isReal, originalShot, outcomeCounts, platformOf, scoresOf, useSiteData } from '../siteData.js';
import { useProjects } from '../store/useProjects.js';
import styles from './Home.module.css';

/** The four stages of the app, drawn. */
export const HOW = [
  { n: '01', art: CheckArt, title: 'Check', text: 'Speed, Google, accessibility and broken links of the live site, in plain words.' },
  { n: '02', art: CopyArt, title: 'Copy', text: 'Every page rebuilt as a clean site, with the problems fixed where that can be done safely.' },
  { n: '03', art: CompareArt, title: 'Compare', text: 'The original and the copy side by side, page by page, at every screen size.' },
  { n: '04', art: ResultsArt, title: 'Results', text: 'What got better, what still needs a look, and the new site as a download.' },
];

const SCORE_KEYS = [
  ['performance', 'Speed'],
  ['seo', 'Google'],
  ['accessibility', 'Access'],
  ['bestPractices', 'Safety'],
];

/** One score of a site: the copy's (or the original's when there is no copy yet), and the change against the original. */
function MiniScore({ label, before, after }) {
  const value = after ?? before;
  const delta = after != null && before != null ? after - before : null;
  const tone = rating(value).tone;
  return (
    <div className={styles.mini}>
      <span className={styles.miniLabel}>{label}</span>
      <span className={styles.miniValue} data-tone={tone}>
        {value ?? '–'}
      </span>
      {delta != null && delta !== 0 && (
        <span className={styles.delta} data-dir={delta > 0 ? 'up' : 'down'}>
          {delta > 0 ? '+' : '−'}
          {Math.abs(delta)}
        </span>
      )}
    </div>
  );
}

function statusLine({ audit, result, stages }) {
  if (stages.check === 'running') return 'Checking now…';
  if (stages.copy === 'running') return 'Making the copy…';
  if (stages.results === 'running') return 'Comparing the copy…';
  if (!isReal(audit)) return 'Not checked yet';
  if (!result) return `Checked ${timeAgo(audit.analyzedAt)}`;
  return `${plural(result.pages.length, 'page')} copied · ${timeAgo(result.createdAt)}`;
}

/** A website in the gallery: a picture of it, where its work stands and its scores. */
function SiteCard({ project, featured = false, index }) {
  const select = useProjects((s) => s.select);
  const data = useSiteData(project.id);
  const { audit, result, stages, loaded } = data;
  const host = hostOf(project.url);
  const shot = originalShot(project.id, audit, result);
  const copy = featured ? copyShot(project.id, result) : null;
  const { before, after } = scoresOf(audit, 'mobile');
  const counts = outcomeCounts(audit);
  const platform = platformOf(audit);
  const checked = isReal(audit);

  return (
    <button
      type="button"
      className={styles.card}
      data-featured={featured || undefined}
      style={{ animationDelay: `${120 + index * 60}ms` }}
      onClick={() => select(project.id)}
      aria-label={`Open ${host}`}
    >
      <div className={styles.cardMedia}>
        {loaded ? (
          <BrowserShot src={shot} address={host} alt="" ratio={featured ? 16 / 10 : 16 / 9.5} emptyText={checked ? 'No picture yet' : 'Not checked yet'} size={featured ? 'lg' : 'md'} />
        ) : (
          <span className={`${styles.mediaSkeleton} skeleton`} />
        )}
        {copy && (
          <div className={styles.copyInset}>
            <BrowserShot src={copy} alt="" ratio={16 / 11} size="sm" />
            <span className={styles.insetLabel}>The copy</span>
          </div>
        )}
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <SiteIcon project={project} host={host} size={featured ? 36 : 30} />
          <div className={styles.cardTitles}>
            <span className={styles.cardName}>{host}</span>
            <span className={styles.cardStatus}>{loaded ? statusLine(data) : 'Loading…'}</span>
          </div>
          <ArrowUpRight size={18} className={styles.go} aria-hidden="true" />
        </div>

        {loaded && checked && (
          <div className={styles.scores}>
            {SCORE_KEYS.map(([field, label]) => (
              <MiniScore key={field} label={label} before={before?.[field] ?? null} after={after?.[field] ?? null} />
            ))}
          </div>
        )}
        {loaded && !checked && <p className={styles.cardNote}>Open it and run the first check to see its health.</p>}

        <div className={styles.cardFoot}>
          <StageDots stages={stages} showLabels={featured} />
          {featured && counts && (
            <span className={styles.footFacts}>
              <strong>{counts.better}</strong> better · <strong>{counts.open}</strong> to do
              {counts.regressed > 0 && (
                <>
                  {' '}
                  · <strong data-tone="bad">{counts.regressed}</strong> worse
                </>
              )}
            </span>
          )}
          {!featured && <span className={styles.footFacts}>{result ? stackById(result.stack ?? project.stack).short : platform?.name ?? ''}</span>}
        </div>
        {featured && (platform || result) && (
          <p className={styles.featuredNote}>
            {platform && <>Built with {platform.name}. </>}
            {result && <>Copy in {stackById(result.stack ?? project.stack).name}{result.fidelity?.score != null && `, ${result.fidelity.score}/100 match with the original`}.</>}
          </p>
        )}
      </div>
    </button>
  );
}

/** Totals across every website, for the welcome band. */
function useTotals(projects) {
  const overviews = useProjects((s) => s.overviews);
  let checked = 0;
  let copies = 0;
  let pages = 0;
  let better = 0;
  for (const p of projects) {
    const o = overviews[p.id];
    if (isReal(o?.audit)) checked += 1;
    const r = o?.recreate?.result;
    if (r) {
      copies += 1;
      pages += r.pages?.length ?? 0;
    }
    better += outcomeCounts(o?.audit)?.better ?? 0;
  }
  return { checked, copies, pages, better, loaded: projects.every((p) => overviews[p.id]?.loaded) };
}

/** Most recent work first; a website with a copy leads (it gets the large card). */
function byActivity(projects, overviews) {
  const hasCopy = (p) => (overviews[p.id]?.recreate?.result ? 1 : 0);
  const when = (p) => {
    const o = overviews[p.id];
    return Math.max(new Date(o?.recreate?.result?.createdAt ?? 0).getTime(), new Date(isReal(o?.audit) ? o.audit.analyzedAt : 0).getTime(), new Date(p.updated_at ?? 0).getTime());
  };
  return [...projects].sort((a, b) => hasCopy(b) - hasCopy(a) || when(b) - when(a));
}

/** Home: every website at a glance, and how the app works. */
export default function Home({ onNewProject }) {
  const projects = useProjects((s) => s.projects);
  const loading = useProjects((s) => s.loading);
  const overviews = useProjects((s) => s.overviews);
  const totals = useTotals(projects);
  const ordered = byActivity(projects, overviews);

  const kpis = [
    ['Websites', projects.length],
    ['Checked', totals.checked],
    ['Pages copied', totals.pages],
    ['Things fixed', totals.better],
  ];

  return (
    <div className={`${styles.home} scroll`} data-shot-scroll>
      <section className={styles.hero}>
        <div className={styles.heroText}>
          <span className="eyebrow">Overview</span>
          <h1 className={styles.title}>
            Every company website,
            <br />
            checked and rebuilt better.
          </h1>
          <p className={styles.lead}>
            Check how healthy a site is, make a clean copy that fixes what can be fixed, and compare the two before you download it.
          </p>
          <div className={styles.heroActions}>
            <Button variant="primary" size="lg" icon={Plus} onClick={onNewProject}>
              Add a website
            </Button>
          </div>
        </div>
        <dl className={styles.kpis}>
          {kpis.map(([label, value]) => (
            <div key={label} className={styles.kpi}>
              <dt className="eyebrow">{label}</dt>
              <dd className="tabular">{totals.loaded || label === 'Websites' ? <CountUp value={value} /> : <span className={`${styles.kpiSkeleton} skeleton`} />}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="home-sites">
        <header className={styles.sectionHead}>
          <h2 id="home-sites" className={styles.sectionTitle}>
            Your websites
          </h2>
          <span className={styles.sectionMeta}>Scores on phones · the copy’s when there is one, with the change against the original</span>
        </header>

        {loading && (
          <div className={styles.grid}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={styles.cardSkeleton} data-featured={i === 0 || undefined}>
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && (
          <div className={styles.empty}>
            <EmptySiteArt className={styles.emptyArt} />
            <h3>No websites yet</h3>
            <p>Add the address of one of your company’s websites. The first check takes a minute or two.</p>
            <Button variant="primary" icon={Plus} onClick={onNewProject}>
              Add a website
            </Button>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className={styles.grid}>
            {ordered.map((p, i) => (
              <SiteCard key={p.id} project={p} featured={i === 0 && projects.length > 2} index={i} />
            ))}
            <button type="button" className={styles.addCard} onClick={onNewProject} style={{ animationDelay: `${120 + ordered.length * 60}ms` }}>
              <span className={styles.addIcon}>
                <Plus size={20} aria-hidden="true" />
              </span>
              <span className={styles.addTitle}>Add a website</span>
              <span className={styles.addText}>Company-owned or authorized sites only.</span>
            </button>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="home-how">
        <header className={styles.sectionHead}>
          <h2 id="home-how" className={styles.sectionTitle}>
            How it works
          </h2>
          <span className={styles.sectionMeta}>Four steps for every website; the original is never changed</span>
        </header>
        <ol className={styles.how}>
          {HOW.map(({ n, art: Art, title, text }, i) => (
            <li key={n} style={{ animationDelay: `${200 + i * 80}ms` }}>
              <div className={styles.howArt}>
                <Art />
              </div>
              <div className={styles.howText}>
                <span className={`${styles.howNum} tabular`}>{n}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
              {i < HOW.length - 1 && <ArrowRight size={16} className={styles.howArrow} aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </section>

      <footer className={styles.foot}>
        <span>Site Audit Studio · internal tool</span>
        <span>Speed, Google, accessibility and safety scores are measured with Google’s Lighthouse.</span>
      </footer>
    </div>
  );
}
