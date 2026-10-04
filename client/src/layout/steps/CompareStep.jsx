import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpDown, ChevronLeft, ChevronRight, Columns2, Info, RotateCw } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { EmptyState } from '../../components/common/Surface.jsx';
import InfoTip from '../../components/common/InfoTip.jsx';
import PreviewFrame, { VIEWPORTS } from '../../components/preview/PreviewFrame.jsx';
import SitePreview, { FullPageFrame, liveAvailability, LiveFrame, ModeToggle } from '../../components/preview/SitePreview.jsx';
import { Pill } from '../../components/common/Score.jsx';
import { matchRating, TERMS } from '../../copy.js';
import { pageOf, shownStack, outputsOf } from '../../stacks.js';
import { useProjects } from '../../store/useProjects.js';
import { useSyncScroll } from '../useSyncScroll.js';
import styles from '../Panel.module.css';
import ws from '../Workspace.module.css';

// "services/index.html" → "services/": the URL the preview server answers for a page file.
const pageUrl = (outPath) => outPath.replace(/(^|\/)index\.html$/, '$1');

// A plain-HTML site is framed without scripts, forms, popups or top navigation. A stack with JavaScript (React)
// may run its own bundles: the preview server sends script-src 'self' for it and says so (preview.scripts).
const sandboxFor = (preview) => (preview?.scripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin');

/** How closely the selected page matches the original: one score and one plain verdict. */
function PageMatch({ fid }) {
  if (!fid || fid.score == null) {
    return <p className={ws.hint}>How closely this page matches was not measured (the copy ran out of time before that check).</p>;
  }
  const r = matchRating(fid.score);
  return (
    <div className={ws.match}>
      <span className={ws.matchLabel}>
        {TERMS.fidelity.title}
        <InfoTip label={TERMS.fidelity.title} align="start">
          {TERMS.fidelity.explain}
        </InfoTip>
      </span>
      <span className={ws.matchScore}>
        {fid.score}
        <small>/100</small>
      </span>
      <Pill tone={r.tone}>{r.label}</Pill>
    </div>
  );
}

/** Step 3: the original and the copy side by side, the same page and screen size on both. */
export default function CompareStep({ project, audit, onGoCreate }) {
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const preview = useProjects((s) => s.previews[project.id]);
  const ensurePreview = useProjects((s) => s.ensurePreview);
  // Desktop only for now (the computer view is the only one captured).
  const viewport = 1440;
  const [page, setPage] = useState('index.html');
  const [sync, setSync] = useState(false);
  const [oldScroller, setOldScroller] = useState(null);
  const [newScroller, setNewScroller] = useState(null);
  useSyncScroll(oldScroller, newScroller, sync);

  const pages = result?.preview?.pages ?? result?.pages?.map((p) => p.outPath) ?? [];
  // A new copy opens on its homepage.
  useEffect(() => setPage(pages[0] ?? 'index.html'), [result?.recreateId]);
  const shown = shownStack(result, project.stack);
  const shownOutput = outputsOf(result)[shown];

  // A preview of another build than the one shown (the stack was changed, or its build just finished): start the right one.
  const previewStale = Boolean(result && preview?.url && preview.recreateId === result.recreateId && !preview.loading && (preview.stack ?? 'html') !== shown);
  useEffect(() => {
    if (previewStale) ensurePreview(project.id);
  }, [previewStale, project.id, ensurePreview]);

  // The original: the homepage from the check; another page as the picture the copy step took of it (or live).
  const siteUrl = audit?.url ?? project.url;
  const pageInfo = result?.pages?.find((p) => p.outPath === page) ?? null;
  const otherPage = pageInfo && pageInfo.path !== '/' && pageInfo.url ? pageInfo : null;
  const originalUrl = otherPage?.url ?? siteUrl;
  const pageShot = otherPage
    ? (vp) => (otherPage.views?.includes(vp.view) && otherPage.slug
      ? { viewport: { width: vp.id }, full: { url: `/api/projects/${project.id}/recreate/${result.recreateId}/captures/${otherPage.slug}/${vp.view}-full.webp` } }
      : null)
    : undefined;
  const live = liveAvailability(audit, originalUrl);
  const hasScreens = otherPage ? (otherPage.views?.length ?? 0) > 0 : Boolean(audit?.screenshots);
  const [mode, setMode] = useState('screenshot');
  useEffect(() => {
    setMode(live.ok ? 'live' : 'screenshot');
  }, [audit?.analysisId, originalUrl, live.ok]);
  // Scrolling together works on the picture of the original (the app cannot scroll a live site of another origin).
  const modeBefore = useRef(null);
  useEffect(() => {
    if (sync && hasScreens) {
      setMode((current) => {
        modeBefore.current = current;
        return 'screenshot';
      });
    } else if (!sync && modeBefore.current) {
      setMode(modeBefore.current);
      modeBefore.current = null;
    }
  }, [sync, hasScreens]);

  if (!result) {
    return (
      <div className={ws.stepBody}>
        <EmptyState
          icon={Columns2}
          title="Nothing to compare yet"
          action={
            <Button variant="primary" onClick={onGoCreate}>
              Go to “Create the copy”
            </Button>
          }
        >
          Once the copy has been made, the original and the copy appear here side by side.
        </EmptyState>
      </div>
    );
  }

  const ready = Boolean(preview?.url && preview.recreateId === result.recreateId);
  const src = ready ? `${preview.url}${pageUrl(pageOf(result, shown, page).file)}` : null;
  const view = VIEWPORTS.find((v) => v.id === viewport)?.view;
  const pageHeight = result?.fidelity?.pages?.find((p) => p.outPath === page)?.views?.[view]?.height?.generated ?? null;
  const fullPage = sync && ready && pageHeight > 0;
  const realOriginal = audit && !audit.isDummy;
  const fidByPage = new Map((result.fidelity?.pages ?? []).map((p) => [p.outPath, p]));
  const pageIndex = Math.max(0, pages.indexOf(page));

  return (
    <div className={ws.stepBody}>
      <div className={ws.toolbar}>
        {pages.length > 1 && (
          <div className={ws.pagePicker}>
            <label className={ws.field}>
              <span>
                Page {pageIndex + 1} of {pages.length}
              </span>
              <select className="mono" value={page} onChange={(e) => setPage(e.target.value)} aria-label="Page to compare">
                {pages.map((p) => {
                  const score = fidByPage.get(p)?.score;
                  return (
                    <option key={p} value={p}>
                      {pageOf(result, shown, p).path}
                      {score != null ? `  ·  ${score}/100` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <Button icon={ChevronLeft} iconOnly disabled={pageIndex <= 0} onClick={() => setPage(pages[pageIndex - 1])}>
              Previous page
            </Button>
            <Button icon={ChevronRight} iconOnly disabled={pageIndex >= pages.length - 1} onClick={() => setPage(pages[pageIndex + 1])}>
              Next page
            </Button>
          </div>
        )}
        <span className={ws.toolbarEnd}>
          <Button icon={ArrowUpDown} variant={sync ? 'primary' : 'secondary'} aria-pressed={sync} onClick={() => setSync((on) => !on)}>
            {sync ? 'Scrolling together' : TERMS.sync.title}
          </Button>
          <InfoTip label={TERMS.sync.title} align="end">
            {TERMS.sync.explain}
          </InfoTip>
        </span>
      </div>

      <PageMatch fid={fidByPage.get(page)} />

      <div className={ws.compare}>
        <section aria-label={TERMS.original}>
          <p className={ws.compareLabel} data-side="old">
            {TERMS.original}
          </p>
          <PreviewFrame
            address={originalUrl}
            tone="old"
            viewport={viewport}
            fit={Boolean(realOriginal)}
            viewportButtons={false}
            toolbar={realOriginal && <ModeToggle mode={mode} onChange={setMode} live={live} hasScreens={hasScreens} />}
          >
            {realOriginal && (
              <SitePreview url={originalUrl} audit={audit} mode={mode} viewport={viewport} scrollRef={sync ? setOldScroller : undefined} pageShot={pageShot} />
            )}
          </PreviewFrame>
        </section>

        <section aria-label={TERMS.copy}>
          <p className={ws.compareLabel} data-side="new">
            {TERMS.copy}
          </p>
          <PreviewFrame
            address={src ? src.replace(/^https?:\/\//, '') : 'starting the preview…'}
            tone="new"
            viewport={viewport}
            fit={ready}
            viewportButtons={false}
          >
            {fullPage ? (
              <FullPageFrame
                key={`${preview.recreateId}-${page}-${viewport}`}
                url={src}
                width={viewport}
                height={pageHeight}
                scrollRef={setNewScroller}
                sandbox={sandboxFor(preview)}
                title="The new copy"
                loadingText="Loading the copy…"
              />
            ) : ready ? (
              <LiveFrame key={preview.recreateId} url={src} width={viewport} sandbox={sandboxFor(preview)} title="The new copy" loadingText="Loading the copy…" />
            ) : preview?.error ? (
              <EmptyState icon={AlertTriangle} title="The preview could not start" action={<Button icon={RotateCw} onClick={() => ensurePreview(project.id)}>Try again</Button>}>
                {preview.error}
              </EmptyState>
            ) : (
              <EmptyState title="Starting the preview…">The new site is being opened privately on this computer.</EmptyState>
            )}
          </PreviewFrame>
          {ready && shownOutput?.forms?.stored?.length > 0 && (
            <p className={styles.dummyNote} role="note">
              <Info size={13} aria-hidden="true" />
              <span>Forms need the server, which this preview does not run. In the downloaded project, run it as its README explains to try them.</span>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
