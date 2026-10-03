import { useEffect, useState } from 'react';
import { Download, FileText, ListChecks, Loader2, RotateCw, Trophy } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Alert, Card, EmptyState } from '../../components/common/Surface.jsx';
import FixChecklist from '../../components/recreate/FixChecklist.jsx';
import FixReport from '../../components/recreate/FixReport.jsx';
import RecreateReport from '../../components/recreate/RecreateReport.jsx';
import AnalyzeProgress from '../../components/audit/AnalyzeProgress.jsx';
import { STACKS, stackById } from '../../constants.js';
import { api } from '../../api/client.js';
import { outputsOf } from '../../stacks.js';
import { isJobActive, useProjects } from '../../store/useProjects.js';
import styles from '../Panel.module.css';
import ws from '../Workspace.module.css';

/** Step 4: what got better, what still needs work, and the download. */
export default function ResultsStep({ project, audit, onGoCreate, onOpenReport }) {
  const job = useProjects((s) => s.recreates[project.id]);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const startReaudit = useProjects((s) => s.reaudit);
  const dismissJob = useProjects((s) => s.dismissJob);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  // One job at a time on the server: no new comparison while a copy or comparison of this project runs.
  const busy = isJobActive(job) || isJobActive(reauditJob);
  const outputs = outputsOf(result);
  const [zipStack, setZipStack] = useState(project.stack);
  const [building, setBuilding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  useEffect(() => {
    setDownloadError(null);
    setZipStack(project.stack);
  }, [result?.recreateId, project.id, project.stack]);

  if (!result) {
    return (
      <div className={ws.stepBody}>
        <EmptyState
          icon={Trophy}
          title="No results yet"
          action={
            <Button variant="primary" onClick={onGoCreate}>
              Go to “Create the copy”
            </Button>
          }
        >
          After the copy has been made, this shows what got better compared with the original and lets you download the new site.
        </EmptyState>
      </div>
    );
  }

  const zipReady = outputs[zipStack]?.status === 'ready';
  const canDownload = Boolean(result.recreateId && result.safety?.safe && !busy && !building);
  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      if (!zipReady) {
        // Built from the saved copy (the site is not visited again); it waits for any running job.
        setBuilding(true);
        await api.exportStack(project.id, result.recreateId, zipStack);
        await reloadRecreate(project.id);
        await reloadAudit(project.id);
        setBuilding(false);
      }
      const problem = await api.checkDownload(project.id, result.recreateId, zipStack);
      if (problem) setDownloadError(problem);
      else window.location.assign(api.downloadUrl(project.id, result.recreateId, zipStack));
    } catch (err) {
      setBuilding(false);
      setDownloadError(err.message || 'Cannot reach the server.');
      await reloadRecreate(project.id).catch(() => {});
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className={ws.stepBody}>
      <Card
        icon={Download}
        title="Download the new site"
        sub="A .zip with the complete site, ready to put on any web host, plus a short report."
        actions={
          <Button icon={FileText} onClick={onOpenReport}>
            Full report (PDF)
          </Button>
        }
      >
        <div className={ws.actions}>
          <label className={ws.field}>
            <span>Technology</span>
            <select className="mono" value={zipStack} onChange={(e) => setZipStack(e.target.value)} disabled={building} aria-label="Technology of the download">
              {STACKS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {outputs[x.id]?.status === 'ready' ? '' : ' (built when you download)'}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            icon={building || downloading ? (p) => <Loader2 {...p} className={styles.spin} /> : Download}
            disabled={!canDownload || downloading}
            onClick={download}
            title={canDownload ? undefined : 'Wait until the running job has finished'}
          >
            {building ? 'Building…' : zipReady ? 'Download .zip' : `Build ${stackById(zipStack).name} & download`}
          </Button>
        </div>
        {building && <p className={ws.hint}>Building the {stackById(zipStack).name} version from the saved copy; this can take a couple of minutes.</p>}
        {downloadError && (
          <Alert tone="bad" title="The download did not work">
            {downloadError}
          </Alert>
        )}
      </Card>

      {(result.fidelity || result.verify) && (
        <>
          <div className={styles.sectionTitle}>
            <span>How the copy turned out</span>
          </div>
          <RecreateReport result={result} projectId={project.id} />
        </>
      )}

      {audit && (
        <>
          <div className={styles.sectionTitle}>
            <span>{audit.recreate.isDummy ? 'What gets fixed' : 'Original vs copy, check by check'}</span>
          </div>
          {reauditJob && reauditJob.status !== 'done' && <AnalyzeProgress analysis={reauditJob} kind="reaudit" onDismiss={() => dismissJob('reaudit', project.id)} />}
          {audit.recreate.isDummy ? (
            <>
              {audit.recreate.recreateId && !isJobActive(reauditJob) && (
                <Alert
                  tone="info"
                  title="The copy has not been compared with the original yet"
                  action={
                    <Button variant="primary" size="sm" icon={RotateCw} disabled={busy} onClick={() => startReaudit(project.id)}>
                      Compare now
                    </Button>
                  }
                >
                  {audit.recreate.lastError ? `The last comparison failed: ${audit.recreate.lastError}` : 'Runs the same check on the copy and lists what got better.'}
                </Alert>
              )}
              <p className={styles.dummyNote}>
                <ListChecks size={13} aria-hidden="true" />
                Example list — the real one appears once the copy has been compared with the original.
              </p>
              <FixChecklist items={audit.recreate.checklist} />
            </>
          ) : (
            <FixReport data={audit.recreate} busy={busy} onReaudit={() => startReaudit(project.id)} />
          )}
        </>
      )}
    </div>
  );
}
