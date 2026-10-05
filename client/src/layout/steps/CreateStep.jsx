import { useState } from 'react';
import { CheckCircle2, Loader2, Settings2, Sparkles } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Alert, Card } from '../../components/common/Surface.jsx';
import AnalyzeProgress from '../../components/audit/AnalyzeProgress.jsx';
import StackOutput from '../../components/recreate/StackOutput.jsx';
import { RECREATE_STACKS, stackById } from '../../constants.js';
import { TERMS } from '../../copy.js';
import { ageDays, plural } from '../../format.js';
import { api } from '../../api/client.js';
import { outputsOf, outputState } from '../../stacks.js';
import { isAnalysisActive, isJobActive, useProjects } from '../../store/useProjects.js';
import styles from '../Panel.module.css';
import ws from '../Workspace.module.css';

const STALE_DAYS = 7;
const ALL_PAGES = -1;

// Why the copy can't be made right now, or null when it can.
function blockerOf({ audit, project, analyzing }) {
  if (!audit || audit.isDummy) return 'Check the site first (step 1): the copy is built from what the check found.';
  if (analyzing) return 'Wait until the check has finished.';
  if (!RECREATE_STACKS.includes(project.stack)) return 'This technology cannot be used yet. Choose another one in the settings.';
  return null;
}

// The four stages of making a copy, in plain words (the live progress shows the detailed steps).
const STAGES = [
  ['Visit every page', 'Each page is opened like a visitor on a computer would see it; its layout, text, hover effects and animations are recorded.'],
  ['Save images and files', 'Images, fonts, videos and documents are downloaded, so the copy never depends on the old site.'],
  ['Build the new pages', 'Clean pages are written and the problems the check found are fixed where that can be done automatically.'],
  ['Check the result', 'Safety, broken links and how closely every page matches the original; then a private preview opens.'],
];

const pagesText = (n) => (n == null || n === ALL_PAGES ? 'Every page of the site' : n === 0 ? 'Only the homepage' : `The homepage + ${plural(n, 'page')}`);

/** Step 2: make the copy (Recreate). */
export default function CreateStep({ project, audit, onOpenSettings }) {
  const stack = stackById(project.stack);
  const analysis = useProjects((s) => s.analyses[project.id]);
  const job = useProjects((s) => s.recreates[project.id]);
  const recreate = useProjects((s) => s.recreate);
  const dismissJob = useProjects((s) => s.dismissJob);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const result = latest?.result;
  const running = isJobActive(job);
  const blocker = blockerOf({ audit, project, analyzing: isAnalysisActive(analysis) });
  const staleDays = audit && !audit.isDummy ? ageDays(audit.analyzedAt) : 0;
  const outputs = outputsOf(result);
  const stackState = outputState(result, project.stack);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(null);

  return (
    <div className={ws.stepBody}>
      <Card
        icon={Sparkles}
        title="Make a clean copy of this site"
        sub="Every page is visited, its layout, text, images, hover effects and animations are recorded, and a new site is built that fixes the problems the check found. The original site is never changed."
      >
        <dl className={ws.settings}>
          <div>
            <dt>{TERMS.stack.title}</dt>
            <dd>{stack.name}</dd>
          </div>
          <div>
            <dt>Pages</dt>
            <dd>{pagesText(project.recreate_pages)}</dd>
          </div>
          <div>
            <dt>Future address</dt>
            <dd className="mono">{project.target_domain || 'Not set yet (asked when you create the copy)'}</dd>
          </div>
        </dl>
        <div className={ws.actions}>
          <Button
            variant="primary"
            size="lg"
            icon={running ? (p) => <Loader2 {...p} className={styles.spin} /> : Sparkles}
            disabled={Boolean(blocker) || running}
            title={blocker ?? undefined}
            // Every full address in the copy (canonical, sitemap, link previews, structured data) uses the new site's address,
            // never the original: it is asked once before the first copy.
            onClick={() => (project.target_domain ? recreate(project.id) : onOpenSettings('before-create'))}
          >
            {running ? 'Creating the copy…' : result ? 'Create the copy again' : 'Create the copy'}
          </Button>
          <Button icon={Settings2} onClick={() => onOpenSettings('settings')} disabled={running}>
            Change settings
          </Button>
        </div>
        {blocker && !running && <p className={ws.hint}>{blocker}</p>}
        {!blocker && !running && (
          <p className={ws.hint}>
            This can take a while for a large site (several minutes per page on a slow computer). The computer is kept awake while it works; keep the
            laptop plugged in and its lid open.
          </p>
        )}
      </Card>

      {!running && (
        <Card title="What happens when you click">
          <ol className={ws.stages}>
            {STAGES.map(([title, text], i) => (
              <li key={title}>
                <span className={ws.stageNum}>{i + 1}</span>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {staleDays > STALE_DAYS && !running && (
        <Alert tone="warn" title={`The check is ${Math.floor(staleDays)} days old`}>
          If the site has changed since then, check it again (step 1) before making the copy.
        </Alert>
      )}

      {job && job.status !== 'done' && <AnalyzeProgress analysis={job} kind="recreate" onDismiss={() => dismissJob('recreate', project.id)} />}

      {result && (
        <Alert tone="ok" title="Last copy">
          Made {new Date(result.createdAt).toLocaleString()} · {plural(result.pages.length, 'page')}. See it in step 3, the results in step 4.
        </Alert>
      )}

      {result && project.stack !== 'html' && (
        <>
          <StackOutput
            stack={project.stack}
            state={stackState}
            output={outputs[project.stack]}
            busy={running || isJobActive(reauditJob) || building}
            onBuild={() => {
              setBuilding(true);
              setBuildError(null);
              api
                .exportStack(project.id, result.recreateId, project.stack)
                .catch((err) => setBuildError(err.message))
                .finally(async () => {
                  await reloadRecreate(project.id);
                  await reloadAudit(project.id);
                  setBuilding(false);
                });
            }}
          />
          {buildError && <Alert tone="bad" title="The build did not finish">{buildError}</Alert>}
        </>
      )}

      {!result && !running && !blocker && (
        <p className={ws.hint}>
          <CheckCircle2 size={14} aria-hidden="true" /> Ready: the check of the site has finished.
        </p>
      )}
    </div>
  );
}
