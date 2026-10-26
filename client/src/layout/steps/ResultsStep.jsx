import { useEffect, useState } from 'react';
import { Download, FileText, ListChecks, Loader2, RotateCw, Ruler, Trophy } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Alert, Card, EmptyState } from '../../components/common/Surface.jsx';
import FixReport from '../../components/recreate/FixReport.jsx';
import RecreateReport from '../../components/recreate/RecreateReport.jsx';
import Outcome from '../../components/recreate/Outcome.jsx';
import CopyPages from '../../components/recreate/CopyPages.jsx';
import PageGallery from '../../components/recreate/PageGallery.jsx';
import AsIsReport from '../../components/recreate/AsIsReport.jsx';
import SectionCard from '../../components/common/SectionCard.jsx';
import AnalyzeProgress from '../../components/audit/AnalyzeProgress.jsx';
import { stackById } from '../../constants.js';
import { api } from '../../api/client.js';
import { outputsOf, outputState } from '../../stacks.js';
import { isJobActive, useProjects } from '../../store/useProjects.js';
import styles from '../Panel.module.css';
import { pathOf } from '../../components/project/PageScope.jsx';
import ws from '../Workspace.module.css';

/** Step 4: what got better, what still needs work, and the download. */
export default function ResultsStep({ project, audit, onGoCreate, onOpenReport, onOpenPage }) {
  const job = useProjects((s) => s.recreates[project.id]);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const startReaudit = useProjects((s) => s.reaudit);
  const dismissJob = useProjects((s) => s.dismissJob);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  const recreate = useProjects((s) => s.recreate);
  // One job at a time on the server: no new comparison while a copy or comparison of this project runs.
  const busy = isJobActive(job) || isJobActive(reauditJob);
  const outputs = outputsOf(result);
  // The download is the copy's own technology: the one chosen before it was made (the clean copy's settings, or the
  // "Copy my site" panel). Another technology means another copy, made with that choice; nothing is built from here.
  const copyStack = result?.asIs?.stack ?? result?.stack ?? project.stack ?? 'html';
  const copyState = outputState(result, copyStack);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  useEffect(() => {
    setDownloadError(null);
  }, [result?.recreateId, project.id]);

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

  const zipReady = copyState === 'ready' && (copyStack === 'html' || outputs[copyStack]?.status === 'ready');
  const canDownload = Boolean(result.recreateId && result.safety?.safe && !busy && zipReady);
  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const problem = await api.checkDownload(project.id, result.recreateId, copyStack);
      if (problem) setDownloadError(problem);
      else window.location.assign(api.downloadUrl(project.id, result.recreateId, copyStack));
    } catch (err) {
      setDownloadError(err.message || 'Cannot reach the server.');
      await reloadRecreate(project.id).catch(() => {});
    } finally {
      setDownloading(false);
    }
  }
  const copyName = stackById(copyStack).name;
  const notReadyText = copyState === 'building'
    ? `The ${copyName} version is still being built from the saved copy; it will be ready for download in a few minutes.`
    : copyState === 'failed'
      ? `The ${copyName} build of this copy did not finish. The reason is in “Create the copy”; make the copy again to get a download.`
      : `This copy has no ${copyName} build to download. Make the copy again.`;
  // Why a finished copy cannot be downloaded although it is built: its safety result (the server refuses the zip too).
  const unsafeText = result.safety?.safe
    ? null
    : !result.safety
      ? 'This copy has no safety check result, so it cannot be downloaded. Make the copy again.'
      : result.safety.mode === 'as-is'
        ? 'The copy loads something from another website, so it cannot be downloaded until that is fixed. “Checks, per page” above shows which page.'
        : 'The copy did not pass its safety check, so it cannot be downloaded.';

  const comparison = audit && !audit.isDummy && audit.recreate && !audit.recreate.isDummy ? audit.recreate : null;
  const canCompare = audit?.recreate?.recreateId && !isJobActive(reauditJob);
  // The latest comparison of this copy failed (with or without an earlier one to show): said once, at the top, in red. The
  // progress box already shows a failure that just happened.
  const compareError = audit && !audit.isDummy ? audit.recreate?.lastError ?? null : null;
  const showCompareError = Boolean(compareError) && reauditJob?.status !== 'failed';

  return (
    <div className={ws.stepBody}>
      {reauditJob && reauditJob.status !== 'done' && <AnalyzeProgress analysis={reauditJob} kind="reaudit" onDismiss={() => dismissJob('reaudit', project.id)} />}

      {/* Not only inside the closed "Every check, before and after", or below the results. */}
      {showCompareError && (
        <Alert
          tone="bad"
          title="The latest comparison failed"
          action={
            <Button size="sm" icon={RotateCw} disabled={!canCompare || busy} onClick={() => startReaudit(project.id)}>
              Compare again
            </Button>
          }
        >
          {compareError} {comparison ? 'The results below are from the previous comparison.' : 'The copy has not been compared with the original yet.'}
        </Alert>
      )}

      {result.asIs && (
        <AsIsReport
          asIs={result.asIs}
          outputs={[result.asIs.stack]}
          projectId={project.id}
          asIsOutputs={latest?.asIsOutputs ?? {}}
          onPackage={(stack) => recreate(project.id, { mode: 'as-is', confirmed: true, stack, reuseAsIs: true })}
        />
      )}

      {result.singlePage && (
        <p className={ws.hint}>
          Results for one page only: <span className="mono">{result.singlePage.path ?? pathOf(result.singlePage.url)}</span> (checked and copied on its own; the rest of the website is not part of these results).
        </p>
      )}
      <Outcome result={result} comparison={comparison} />
      {result.copy && <CopyPages copy={result.copy} />}

      {!comparison && canCompare && !showCompareError && (
        <Alert
          tone={audit.recreate.lastError ? 'bad' : 'info'}
          title="The copy has not been compared with the original yet"
          action={
            <Button variant="primary" size="sm" icon={RotateCw} disabled={busy} onClick={() => startReaudit(project.id)}>
              Compare now
            </Button>
          }
        >
          {audit.recreate.lastError ? `The last comparison failed: ${audit.recreate.lastError}` : 'Runs the same check on the copy and shows what got better. Takes a few minutes.'}
        </Alert>
      )}

      <PageGallery projectId={project.id} result={result} onOpenPage={onOpenPage} />

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
          <p className={ws.hint} style={{ margin: 0 }}>
            Your copy: <strong>{copyName}</strong>. To get it in another technology, make a new copy with that choice.
          </p>
          <Button
            variant="primary"
            icon={downloading ? (p) => <Loader2 {...p} className={styles.spin} /> : Download}
            disabled={!canDownload || downloading}
            onClick={download}
            title={canDownload ? undefined : !zipReady ? notReadyText : unsafeText ?? 'Wait until the running job has finished'}
          >
            Download .zip
          </Button>
        </div>
        {!zipReady && <p className={ws.hint}>{notReadyText}</p>}
        {zipReady && unsafeText && (
          <Alert tone="bad" title="The download is held back">
            {unsafeText}
          </Alert>
        )}
        {downloadError && (
          <Alert tone="bad" title="The download did not work">
            {downloadError}
          </Alert>
        )}
      </Card>

      {comparison && (
        <SectionCard icon={ListChecks} title="Every check, before and after" meta="For a closer look" defaultOpen={false}>
          <FixReport data={comparison} busy={busy} onReaudit={() => startReaudit(project.id)} />
        </SectionCard>
      )}
      {(result.fidelity || result.verify) && (
        <SectionCard icon={Ruler} title="Match per page and other measurements" meta="For a closer look" defaultOpen={false}>
          <RecreateReport result={result} projectId={project.id} />
        </SectionCard>
      )}
    </div>
  );
}
