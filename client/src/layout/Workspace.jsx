import { useEffect, useRef, useState } from 'react';
import { SectionTabs } from '../components/common/Tabs.jsx';
import { STEPS } from '../copy.js';
import { plural, timeAgo } from '../format.js';
import { api } from '../api/client.js';
import { outputsOf, outputState } from '../stacks.js';
import { isJobActive, useProjects } from '../store/useProjects.js';
import SiteHero from './SiteHero.jsx';
import OverviewStep from './steps/OverviewStep.jsx';
import CheckStep from './steps/CheckStep.jsx';
import CompareStep from './steps/CompareStep.jsx';
import CreateStep from './steps/CreateStep.jsx';
import ResultsStep from './steps/ResultsStep.jsx';
import styles from './Workspace.module.css';

const ORDER = ['overview', 'check', 'create', 'compare', 'results'];
const pct = (job) => (Number.isFinite(job?.pct) ? ` · ${job.pct} %` : '');

/** Status line and mark of each section tab, from what the project has and what is running. */
function stepStates({ audit, analysis, job, result, reauditJob }) {
  const checked = audit && !audit.isDummy;
  const summary = audit && !audit.isDummy && audit.recreate && !audit.recreate.isDummy ? audit.recreate.summary : null;
  return {
    overview: { status: checked ? 'Everything at a glance' : 'Start here' },
    check: isJobActive(analysis)
      ? { tone: 'running', status: `Checking${pct(analysis)}` }
      : analysis?.status === 'failed'
        ? { tone: 'bad', status: 'The check failed' }
        : checked
          ? { tone: 'done', status: `Checked ${timeAgo(audit.analyzedAt)}` }
          : { status: 'Not checked yet' },
    create: isJobActive(job)
      ? { tone: 'running', status: `Working${pct(job)}` }
      : job?.status === 'failed'
        ? { tone: 'bad', status: 'Did not finish' }
        : result
          ? { tone: 'done', status: `${plural(result.pages.length, 'page')} copied` }
          : { status: checked ? 'Ready to start' : 'Check the site first' },
    compare: result ? { status: `${plural(result.pages.length, 'page')} side by side` } : { status: 'After the copy' },
    results: isJobActive(reauditJob)
      ? { tone: 'running', status: `Comparing${pct(reauditJob)}` }
      : summary
        ? summary.regressed > 0
          ? { tone: 'warn', status: `${summary.fixed ?? 0} fixed · ${summary.regressed} got worse` }
          : { tone: 'done', status: `${summary.fixed ?? 0} fixed · ${summary.open ?? 0} still open` }
        : { status: result ? 'Not compared yet' : 'After the copy' },
  };
}

/** The section a project opens on: a running job's, else the overview. */
function startStep({ analysis, job }) {
  if (isJobActive(job)) return 'create';
  if (isJobActive(analysis)) return 'check';
  return 'overview';
}

const TAB_TITLES = { overview: 'Overview', check: 'Check', create: 'Copy', compare: 'Compare', results: 'Results' };

/** One website: the dashboard hero, the section tabs (sticky) and the selected section. */
export default function Workspace({ project, audit, auditLoading, onOpenSettings, onOpenReport }) {
  const analysis = useProjects((s) => s.analyses[project.id]);
  const job = useProjects((s) => s.recreates[project.id]);
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  const result = latest?.result;
  const [step, setStep] = useState(() => startStep({ analysis, job }));
  const [chosen, setChosen] = useState(false);
  // A page picked elsewhere (Results' page pictures) that Compare opens on.
  const [comparePage, setComparePage] = useState(null);
  // Until the user picks a tab, the project opens where its work stands (jobs are found after the project loads).
  useEffect(() => {
    if (!chosen) setStep(startStep({ analysis, job }));
  }, [isJobActive(analysis), isJobActive(job), chosen]);

  const scroller = useRef(null);
  const tabsRef = useRef(null);
  const choose = (id) => {
    setChosen(true);
    setStep(id);
    // Bring the section into view below the sticky tabs when it was scrolled past the hero.
    const el = scroller.current;
    const bar = tabsRef.current;
    if (el && bar && el.scrollTop > bar.offsetTop) el.scrollTo({ top: bar.offsetTop, behavior: 'smooth' });
  };

  const openPage = (outPath) => {
    setComparePage(outPath);
    choose('compare');
  };

  // The app stack's build is made right after the copy; follow it until it is ready (or failed).
  const stackState = outputState(result, project.stack);
  useEffect(() => {
    if (stackState !== 'building') return undefined;
    let stopped = false;
    const timer = setInterval(async () => {
      const data = await api.getRecreate(project.id).catch(() => null);
      if (stopped || !data?.result || !outputsOf(data.result)[project.stack]) return;
      await reloadRecreate(project.id);
      await reloadAudit(project.id);
    }, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [stackState, project.id, project.stack, reloadRecreate, reloadAudit]);

  // The tab bar casts a shadow once it sticks to the top.
  const [stuck, setStuck] = useState(false);
  const onScroll = (e) => {
    const bar = tabsRef.current;
    if (bar) setStuck(e.currentTarget.scrollTop >= bar.offsetTop - 1);
  };

  const states = stepStates({ audit, analysis, job, result, reauditJob });
  const tabs = ORDER.map((id) => ({ id, title: TAB_TITLES[id], ...states[id] }));
  const props = { project, audit, onGoCreate: () => choose('create') };
  const intro = step === 'overview' ? null : STEPS[step];

  return (
    <div className={`${styles.workspace} scroll`} ref={scroller} onScroll={onScroll} data-shot-scroll>
      <div className={styles.heroWrap}>
        {auditLoading && !audit ? <HeroSkeleton /> : <SiteHero project={project} audit={audit} onGo={choose} compact={step !== 'overview'} />}
      </div>

      <div className={styles.tabsBar} ref={tabsRef} data-stuck={stuck || undefined}>
        <div className={styles.tabsInner}>
          <SectionTabs tabs={tabs} value={step} onChange={choose} label="Sections of this website" />
        </div>
      </div>

      <div role="tabpanel" id={`panel-${step}`} aria-labelledby={`tab-${step}`} key={step} className={styles.panel}>
        {intro && (
          <header className={styles.intro}>
            <h2 className={styles.introTitle}>{intro.title}</h2>
            <p className={styles.introText}>{intro.explain}</p>
          </header>
        )}
        {step === 'overview' && <OverviewStep project={project} audit={audit} loading={auditLoading} onGo={choose} />}
        {step === 'check' && <CheckStep project={project} audit={audit} loading={auditLoading} />}
        {step === 'create' && <CreateStep project={project} audit={audit} onOpenSettings={onOpenSettings} onGo={choose} />}
        {step === 'compare' && <CompareStep {...props} focusPage={comparePage} />}
        {step === 'results' && <ResultsStep {...props} onOpenReport={onOpenReport} onOpenPage={openPage} />}
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div className={styles.heroSkeleton} aria-hidden="true">
      <div>
        <span className="skeleton" />
        <span className="skeleton" />
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
      <span className="skeleton" />
    </div>
  );
}
