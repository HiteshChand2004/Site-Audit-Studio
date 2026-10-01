import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Info, ListChecks, RotateCw, Sparkles } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame from '../components/preview/PreviewFrame.jsx';
import { FullPageFrame, LiveFrame } from '../components/preview/SitePreview.jsx';
import { VIEWPORTS } from '../components/preview/PreviewFrame.jsx';
import FixChecklist from '../components/recreate/FixChecklist.jsx';
import FixReport from '../components/recreate/FixReport.jsx';
import RecreateReport from '../components/recreate/RecreateReport.jsx';
import AnalyzeProgress from '../components/audit/AnalyzeProgress.jsx';
import { STACKS, stackById } from '../constants.js';
import StackOutput from '../components/recreate/StackOutput.jsx';
import { outputsOf, outputState, pageOf, shownStack } from '../stacks.js';
import { api } from '../api/client.js';
import { isJobActive, useProjects } from '../store/useProjects.js';
import styles from './Panel.module.css';
import own from './NewPanel.module.css';

const STALE_DAYS = 7;

function ageDays(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0;
}

// "services/index.html" → "services/": the URL the preview server answers for a page file.
const pageUrl = (outPath) => outPath.replace(/(^|\/)index\.html$/, '$1');

// A plain-HTML site is framed without scripts, forms, popups or top navigation. A stack with JavaScript (React)
// may run its own bundles: the preview server sends script-src 'self' for it and says so (preview.scripts).
const sandboxFor = (preview) => (preview?.scripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin');

function PreviewEmpty({ icon: Icon = Sparkles, title, children }) {
  return (
    <div className={own.empty}>
      <Icon size={18} aria-hidden="true" />
      <p className={own.emptyTitle}>{title}</p>
      <div className={own.emptyText}>{children}</div>
    </div>
  );
}

export default function NewPanel({ project, audit, syncScroll = false, onFrameScroller, onPageChange }) {
  const stack = stackById(project.stack);
  const job = useProjects((s) => s.recreates[project.id]);
  const dismissJob = useProjects((s) => s.dismissJob);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const staleDays = audit && !audit.isDummy ? ageDays(audit.analyzedAt) : 0;
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const startReaudit = useProjects((s) => s.reaudit);
  // One job at a time on the server: no re-audit while a recreate or re-audit of this project runs.
  const busy = isJobActive(job) || isJobActive(reauditJob);
  const preview = useProjects((s) => s.previews[project.id]);
  const ensurePreview = useProjects((s) => s.ensurePreview);
  const [downloadError, setDownloadError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  // The stack the zip is for (default: the project's); a build that does not exist yet is made on demand.
  const [zipStack, setZipStack] = useState(project.stack);
  const [building, setBuilding] = useState(false);
  const reloadRecreate = useProjects((s) => s.reloadRecreate);
  const reloadAudit = useProjects((s) => s.reloadAudit);
  const [viewport, setViewport] = useState(1440);
  const [page, setPage] = useState('index.html');
  const pages = result?.preview?.pages ?? result?.pages?.map((p) => p.outPath) ?? [];
  // A new recreate opens on its homepage.
  useEffect(() => setPage(pages[0] ?? 'index.html'), [result?.recreateId]);
  // The OLD panel shows the same page of the original.
  useEffect(() => onPageChange?.(page), [page, onPageChange]);
  const outputs = outputsOf(result);
  const stackState = outputState(result, project.stack);
  const shown = shownStack(result, project.stack);
  const shownOutput = outputs[shown];
  useEffect(() => {
    setDownloadError(null);
    setZipStack(project.stack);
  }, [result?.recreateId, project.id, project.stack]);

  // The app stack's build is made right after the recreate; follow it until it is ready (or failed), then move the preview onto it.
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

  // A preview of another build than the one shown (the stack was changed, or its build just finished): start the right one.
  const previewStale = Boolean(result && preview?.url && preview.recreateId === result.recreateId && !preview.loading && (preview.stack ?? 'html') !== shown);
  useEffect(() => {
    if (previewStale) ensurePreview(project.id);
  }, [previewStale, project.id, ensurePreview]);

  const zipReady = outputs[zipStack]?.status === 'ready';
  const canDownload = Boolean(result?.recreateId && result.safety?.safe && !busy && !building);
  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      if (!zipReady) {
        // Built from the saved recreate (no new capture); it waits for any running job.
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
      setDownloadError(err.message || 'Cannot reach the API server.');
      await reloadRecreate(project.id).catch(() => {});
    } finally {
      setDownloading(false);
    }
  }
  const live = Boolean(result && preview?.url && preview.recreateId === result.recreateId);
  const src = live ? `${preview.url}${pageUrl(pageOf(result, shown, page).file)}` : null;
  // Sync scroll needs the page drawn at full height (the app cannot scroll a frame from another
  // origin); the height of each page and width comes from the recreate report.
  const view = VIEWPORTS.find((v) => v.id === viewport)?.view;
  const pageHeight = result?.fidelity?.pages?.find((p) => p.outPath === page)?.views?.[view]?.height?.generated ?? null;
  const fullPage = syncScroll && live && pageHeight > 0;

  return (
    <section className={`${styles.panel} ${styles.new}`} aria-label="Recreated website">
      <header className={styles.header}>
        <span className={styles.chip}>NEW</span>
        <span className={styles.headerSub}>Recreated site</span>
        <span className={styles.headerRight}>
          {stackState === 'building' && (
            <span title="The build of this stack is being made; the plain-HTML build is shown until it is ready">
              <Badge tone="neutral">Building…</Badge>
            </span>
          )}
          <span
            title={shown !== project.stack && result
              ? `Showing the plain-HTML build: the ${stack.name} build is ${stackState === 'failed' ? 'not available (it failed)' : 'not ready'}`
              : `Output stack: ${stack.name}`}
          >
            <Badge tone={shown !== project.stack && result ? 'warn' : 'accent'}>{stackById(result ? shown : project.stack).name}</Badge>
          </span>
        </span>
      </header>

      <div className={`${styles.body} scroll`}>
        {staleDays > STALE_DAYS && (
          <p className={own.warn} role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            The latest analysis is {Math.floor(staleDays)} days old. Run Analyze again before recreating if the site
            has changed.
          </p>
        )}

        {job && job.status !== 'done' && (
          <AnalyzeProgress analysis={job} kind="recreate" onDismiss={() => dismissJob('recreate', project.id)} />
        )}

        {result && (
          <p className={styles.dummyNote}>
            <CheckCircle2 size={13} aria-hidden="true" />
            Last recreated {new Date(result.createdAt).toLocaleString()} · {result.pages.length}{' '}
            {result.pages.length === 1 ? 'page' : 'pages'} · base URL <span className="mono">{result.baseUrl}</span>
          </p>
        )}

        <PreviewFrame
          address={src ? src.replace(/^https?:\/\//, '') : result ? '127.0.0.1:51xx · starting…' : '127.0.0.1:51xx · not started'}
          tone="new"
          viewport={viewport}
          onViewportChange={setViewport}
          fit={live}
          toolbar={
            live && pages.length > 1 && (
              <select className={`${own.pageSelect} mono`} value={page} onChange={(e) => setPage(e.target.value)} aria-label="Page to preview">
                {pages.map((p) => (
                  <option key={p} value={p}>
                    {pageOf(result, shown, p).path}
                  </option>
                ))}
              </select>
            )
          }
        >
          {fullPage ? (
            <FullPageFrame
              key={`${preview.recreateId}-${page}-${viewport}`}
              url={src}
              width={viewport}
              height={pageHeight}
              scrollRef={onFrameScroller}
              sandbox={sandboxFor(preview)}
              title="Preview of the recreated site"
              loadingText="Loading preview…"
            />
          ) : live ? (
            <LiveFrame
              key={preview.recreateId}
              url={src}
              width={viewport}
              sandbox={sandboxFor(preview)}
              title="Preview of the recreated site"
              loadingText="Loading preview…"
            />
          ) : result && preview?.error ? (
            <PreviewEmpty icon={AlertTriangle} title="Preview not available">
              <p>{preview.error}</p>
              <Button icon={RotateCw} onClick={() => ensurePreview(project.id)}>
                Try again
              </Button>
            </PreviewEmpty>
          ) : result ? (
            <PreviewEmpty title="Starting preview…">
              <p>Serving the production build on its own local port.</p>
            </PreviewEmpty>
          ) : (
            <PreviewEmpty title="No recreated version yet">
              <p>Run “Recreate” from the OLD panel and a live preview of the new site will appear here.</p>
            </PreviewEmpty>
          )}
        </PreviewFrame>

        {live && shownOutput?.forms?.stored?.length > 0 && (
          <p className={styles.dummyNote} role="note">
            <Info size={13} aria-hidden="true" />
            <span>
              Forms need the server: this preview shows the client only. Run <span className="mono">npm start</span> in the downloaded
              project (see its README) to try them.
            </span>
          </p>
        )}

        {result && (result.fidelity || result.verify) && (
          <>
            <div className={styles.sectionTitle}>
              <span>Recreate report</span>
            </div>
            <RecreateReport result={result} />
          </>
        )}

        {result && project.stack !== 'html' && (
          <StackOutput
            stack={project.stack}
            state={stackState}
            output={outputs[project.stack]}
            busy={busy || building}
            onBuild={() => {
              setZipStack(project.stack);
              setBuilding(true);
              setDownloadError(null);
              api.exportStack(project.id, result.recreateId, project.stack)
                .catch((err) => setDownloadError(err.message))
                .finally(async () => {
                  await reloadRecreate(project.id);
                  await reloadAudit(project.id);
                  setBuilding(false);
                });
            }}
          />
        )}

        {audit && (
          <>
            <div className={styles.sectionTitle}>
              <span>{audit.recreate.isDummy ? 'What gets fixed' : 'Fix checklist'}</span>
            </div>
            {reauditJob && reauditJob.status !== 'done' && (
              <AnalyzeProgress analysis={reauditJob} kind="reaudit" onDismiss={() => dismissJob('reaudit', project.id)} />
            )}
            {audit.recreate.isDummy ? (
              <>
                {audit.recreate.recreateId && !isJobActive(reauditJob) && (
                  <div className={own.cta}>
                    <ListChecks size={16} aria-hidden="true" />
                    <div className={own.ctaText}>
                      <strong>No fix checklist for this recreate yet</strong>
                      <span>
                        {audit.recreate.lastError
                          ? `The last re-audit failed: ${audit.recreate.lastError}`
                          : 'Audit the recreated site and compare it with the original analysis.'}
                      </span>
                    </div>
                    <Button variant="primary" size="sm" icon={RotateCw} disabled={busy} onClick={() => startReaudit(project.id)}>
                      Re-audit now
                    </Button>
                  </div>
                )}
                <p className={styles.dummyNote}>
                  <Info size={13} aria-hidden="true" />
                  Sample checklist — real results come from re-auditing the recreated site.
                </p>
                <FixChecklist items={audit.recreate.checklist} />
              </>
            ) : (
              <FixReport data={audit.recreate} busy={busy} onReaudit={() => startReaudit(project.id)} />
            )}
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <select
          className={`${own.stackSelect} mono`}
          value={zipStack}
          onChange={(e) => setZipStack(e.target.value)}
          disabled={!result || building}
          aria-label="Stack to download"
        >
          {STACKS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {outputs[x.id]?.status === 'ready' ? '' : ' — build first'}
            </option>
          ))}
        </select>
        <Button
          icon={building ? RotateCw : Download}
          disabled={!canDownload || downloading}
          onClick={download}
          title={canDownload ? (zipReady ? 'Download the recreated site as a .zip' : `Build the ${stackById(zipStack).name} version, then download it`) : 'Run Recreate first'}
        >
          {building ? 'Building…' : zipReady ? 'Download .zip' : 'Build & download'}
        </Button>
        <span className={styles.footerNote} role={downloadError ? 'alert' : undefined}>
          {downloadError ?? (building ? 'Building from the saved recreate; this can take a couple of minutes.' : 'Preview runs on the production build.')}
        </span>
      </footer>
    </section>
  );
}
