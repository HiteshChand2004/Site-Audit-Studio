import { useEffect, useState } from 'react';
import { Contrast, Download, FileText, ListChecks, Loader2, RotateCw, Ruler, Trophy } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Alert, Card, EmptyState } from '../../components/common/Surface.jsx';
import FixReport from '../../components/recreate/FixReport.jsx';
import RecreateReport from '../../components/recreate/RecreateReport.jsx';
import Outcome from '../../components/recreate/Outcome.jsx';
import CopyPages from '../../components/recreate/CopyPages.jsx';
import PageGallery from '../../components/recreate/PageGallery.jsx';
import AsIsReport from '../../components/recreate/AsIsReport.jsx';
import AddressDialog from '../../components/recreate/AddressDialog.jsx';
import FixModeDialog, { groupProposals } from '../../components/recreate/FixModeDialog.jsx';
import { ADDRESS_DIALOG, FIX_MODE } from '../../copy.js';
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
  // The download dialog (Step 6): a "Copy my site" copy made without a new-site address asks for one at download. `pending` is
  // the job writing it; its copy is downloaded once it is the latest result.
  const addAddress = useProjects((s) => s.addAddress);
  const [askAddress, setAskAddress] = useState(false);
  const [pending, setPending] = useState(null);
  const needsAddress = Boolean(result?.asIs && !result.asIs.address?.used && !result.asIs.addressedFrom);
  const pendingFailed = pending && job?.id === pending && job.status === 'failed' ? job.error ?? '' : null;
  // Fix mode: changes that make the copy pass checks the original fails (faint text, skipped headings), made only when the user
  // approves each one. Proposed from the comparison of THIS copy; `fixing` is the job writing the approved ones.
  const applyFixes = useProjects((s) => s.applyFixes);
  const [fixes, setFixes] = useState(null);
  const [askFixes, setAskFixes] = useState(false);
  const [fixing, setFixing] = useState(null);
  const fixFailed = fixing && job?.id === fixing && job.status === 'failed' ? job.error ?? '' : null;
  const comparedId = audit && !audit.isDummy && audit.recreate && !audit.recreate.isDummy ? audit.recreate.recreateId : null;
  const comparedAt = audit?.recreate?.reauditId ?? audit?.recreate?.finishedAt ?? null;
  useEffect(() => {
    setFixes(null);
    if (!result?.asIs || !result.recreateId || comparedId !== result.recreateId) return undefined;
    let gone = false;
    api.getFixProposals(project.id, result.recreateId).then((d) => { if (!gone) setFixes(d); }, () => {});
    return () => {
      gone = true;
    };
  }, [project.id, result?.recreateId, result?.asIs, comparedId, comparedAt]);
  useEffect(() => {
    if (fixing && result?.recreateId === fixing) setFixing(null);
  }, [fixing, result?.recreateId]);
  useEffect(() => {
    if (!pending || result?.recreateId !== pending) return;
    setPending(null);
    // The addressed copy is the latest result now: download it (the re-check it queued only reads the copy).
    if (result.safety?.safe && outputState(result, copyStack) === 'ready') startDownload(result.recreateId);
  }, [pending, result?.recreateId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (needsAddress) return setAskAddress(true);
    return startDownload(result.recreateId);
  }
  async function useAddress(address) {
    const id = await addAddress(project.id, result.recreateId, address);
    setPending(id);
    setAskAddress(false);
  }
  function downloadAsItIs() {
    setAskAddress(false);
    startDownload(result.recreateId);
  }
  async function startDownload(recreateId) {
    setDownloading(true);
    setDownloadError(null);
    try {
      const problem = await api.checkDownload(project.id, recreateId, copyStack);
      if (problem) setDownloadError(problem);
      else window.location.assign(api.downloadUrl(project.id, recreateId, copyStack));
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

  const comparison = audit && !audit.isDummy && audit.recreate && !audit.recreate.isDummy ? audit.recreate : null;
  const canCompare = audit?.recreate?.recreateId && !isJobActive(reauditJob);
  const proposals = fixes?.proposals ?? [];
  const contrastCount = proposals.filter((p) => p.kind === 'contrast').length;
  const headingCount = proposals.length - contrastCount;
  const changeCount = groupProposals(proposals).length;
  const approvedBefore = result.asIs?.changedOnPurpose?.length ?? 0;
  const showFixes = Boolean(result.asIs && (proposals.length || approvedBefore || fixing));
  async function approveFixes(ids) {
    const id = await applyFixes(project.id, result.recreateId, ids);
    setFixing(id);
    setAskFixes(false);
  }

  return (
    <div className={ws.stepBody}>
      {reauditJob && reauditJob.status !== 'done' && <AnalyzeProgress analysis={reauditJob} kind="reaudit" onDismiss={() => dismissJob('reaudit', project.id)} />}

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

      {showFixes && (
        <Card
          icon={Contrast}
          title={FIX_MODE.title}
          sub={proposals.length ? FIX_MODE.sub(contrastCount, headingCount) : FIX_MODE.done(approvedBefore)}
          actions={proposals.length > 0 && (
            <Button variant="primary" disabled={busy || Boolean(fixing && fixFailed == null)} onClick={() => setAskFixes(true)}>
              {FIX_MODE.review(changeCount)}
            </Button>
          )}
        >
          {proposals.length > 0 && approvedBefore > 0 && <p className={ws.hint} style={{ margin: 0 }}>{FIX_MODE.done(approvedBefore)}</p>}
          {fixing && fixFailed == null && <p className={ws.hint} style={{ margin: 0 }}>{FIX_MODE.applying}</p>}
          {fixFailed != null && (
            <Alert tone="bad" title={FIX_MODE.failedTitle}>
              {fixFailed} {FIX_MODE.failedText}
            </Alert>
          )}
        </Card>
      )}
      {result.asIs && result.recreateId && (
        <FixModeDialog open={askFixes} projectId={project.id} recreateId={result.recreateId} onApply={approveFixes} onClose={() => setAskFixes(false)} />
      )}

      {!comparison && canCompare && (
        <Alert
          tone="info"
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
            title={canDownload ? undefined : zipReady ? 'Wait until the running job has finished' : notReadyText}
          >
            Download .zip
          </Button>
        </div>
        {!zipReady && <p className={ws.hint}>{notReadyText}</p>}
        {pending && pendingFailed == null && <p className={ws.hint}>{ADDRESS_DIALOG.writing}</p>}
        {pendingFailed != null && (
          <Alert tone="bad" title={ADDRESS_DIALOG.failedTitle}>
            {pendingFailed} {ADDRESS_DIALOG.failedText}
          </Alert>
        )}
        {downloadError && (
          <Alert tone="bad" title="The download did not work">
            {downloadError}
          </Alert>
        )}
      </Card>
      <AddressDialog open={askAddress} initial={project.target_domain ?? ''} onUse={useAddress} onLater={downloadAsItIs} onClose={() => setAskAddress(false)} />

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
