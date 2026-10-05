import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { StepTabs } from '../components/common/Tabs.jsx';
import { STEPS } from '../copy.js';
import { hostOf } from '../constants.js';
import { plural, timeAgo } from '../format.js';
import { api } from '../api/client.js';
import { outputsOf, outputState } from '../stacks.js';
import { isJobActive, useProjects } from '../store/useProjects.js';
import CheckStep from './steps/CheckStep.jsx';
import CompareStep from './steps/CompareStep.jsx';
import CreateStep from './steps/CreateStep.jsx';
import ResultsStep from './steps/ResultsStep.jsx';
import styles from './Workspace.module.css';

const ORDER = ['check', 'create', 'compare', 'results'];
const pct = (job) => (Number.isFinite(job?.pct) ? ` · ${job.pct} %` : '');

/** Status line and mark of each step tab, from what the project has and what is running. */
function stepStates({ audit, analysis, job, result, reauditJob }) {
  const checked = audit && !audit.isDummy;
  const summary = audit && !audit.isDummy && audit.recreate && !audit.recreate.isDummy ? audit.recreate.summary : null;
  return {
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

/** The step a project opens on: where its work stands. */
function startStep({ audit, job, result }) {
  if (isJobActive(job)) return 'create';
  if (!audit || audit.isDummy) return 'check';
  if (!result) return 'create';
  return 'results';
}

/** One website: its name, the four steps, and the selected step's content. */
export default function Workspace({ project, audit, auditLoading, onOpenSettings, onOpenReport }) {
  const analysis = useProjects((s) => s.analyses[project.id]);
  const job = useProjects((s) => s.recreates[project.id]);
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  const result = latest?.result;
  const [step, setStep] = useState(() => startStep({ audit, job, result }));
  const [chosen, setChosen] = useState(false);
  // Until the user picks a tab, the project opens where its work stands (the audit and the copy load after the project).
  useEffect(() => {
    if (!chosen) setStep(startStep({ audit, job, result }));
  }, [audit?.analysisId, audit?.isDummy, result?.recreateId, chosen]);
  const choose = (id) => {
    setChosen(true);
    setStep(id);
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

  const states = stepStates({ audit, analysis, job, result, reauditJob });
  const tabs = ORDER.map((id) => ({ id, n: STEPS[id].n, title: STEPS[id].title, ...states[id] }));
  const props = { project, audit, onGoCreate: () => choose('create') };

  return (
    <div className={styles.workspace}>
      <header className={styles.head}>
        <div className={styles.titles}>
          <h1 className={styles.name}>{project.name}</h1>
          <a className={`${styles.url} mono`} href={project.url} target="_blank" rel="noopener noreferrer">
            {hostOf(project.url)}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
        <StepTabs tabs={tabs} value={step} onChange={choose} label="Steps" />
      </header>

      <div className={`${styles.content} scroll`}>
        <div role="tabpanel" id={`panel-${step}`} aria-labelledby={`tab-${step}`} key={step} className={styles.panel}>
          <p className={styles.explain}>{STEPS[step].explain}</p>
          {step === 'check' && <CheckStep project={project} audit={audit} loading={auditLoading} />}
          {step === 'create' && <CreateStep project={project} audit={audit} onOpenSettings={onOpenSettings} />}
          {step === 'compare' && <CompareStep {...props} />}
          {step === 'results' && <ResultsStep {...props} onOpenReport={onOpenReport} />}
        </div>
      </div>
    </div>
  );
}
