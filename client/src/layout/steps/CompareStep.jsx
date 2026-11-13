import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpDown, ChevronLeft, ChevronRight, Columns2, Info, Monitor, RotateCw, ShieldAlert, Smartphone, Tablet } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { EmptyState } from '../../components/common/Surface.jsx';
import { Segmented } from '../../components/common/Tabs.jsx';
import InfoTip from '../../components/common/InfoTip.jsx';
import PreviewFrame, { VIEWPORTS } from '../../components/preview/PreviewFrame.jsx';
import { api } from '../../api/client.js';
import { apiUrl } from '../../api/base.js';
import SitePreview, { FullPageFrame, LIVE_SANDBOX, liveAvailability, LiveFrame, ModeToggle } from '../../components/preview/SitePreview.jsx';
import { compareSides, defaultPreviewMode, unavailableNote } from '../../components/preview/framing.js';
import { useLiveAnswer } from '../../components/preview/useLiveAnswer.js';
import { Pill } from '../../components/common/Score.jsx';
import { matchRating, TERMS, VIEWPORT_NAMES } from '../../copy.js';
import { pageOf, shownStack, outputsOf } from '../../stacks.js';
import { useProjects } from '../../store/useProjects.js';
import { useSyncScroll } from '../useSyncScroll.js';
import { captureShot } from '../../siteData.js';
import { fidelityPages } from '../../fidelity.js';
import styles from '../Panel.module.css';
import ws from '../Workspace.module.css';

// "services/index.html" → "services/": the URL the preview server answers for a page file.
const pageUrl = (outPath) => outPath.replace(/(^|\/)index\.html$/, '$1');

// Every copy is framed WITHOUT allow-same-origin: the preview is served under the app's own address (/preview/<token>/,
// server/src/recreate/previewRoute.js), so a copy's script must never get the app's origin — not its cookies, storage or
// API. The server sandboxes each document by header as well; this attribute is the frame's own half of the same rule.
// A plain-HTML site runs no script at all; a stack with JavaScript (React, an as-is copy) runs its own bundles only.
const sandboxFor = (preview) => (preview?.scripts ? 'allow-scripts' : '');

const PREVIEW_TOKEN = /^\/preview\/([A-Za-z0-9_-]{24})\//;

/**
 * Plain words for what the copy's own script could not do inside the preview's sealed frame (reported by the shim the
 * preview serves first, as counts); null when nothing is amiss. The downloaded copy is never affected: the frame is the limit.
 */
function previewLimitNote(r) {
  if (!r || (!r.blank && !r.failed)) return null;
  const files = r.failed ? `${r.failed} file${r.failed === 1 ? '' : 's'} its script asked for could not be loaded here` : null;
  const errors = r.errors ? `its script stopped with ${r.errors === 1 ? 'an error' : `${r.errors} errors`}` : null;
  const why = [files, errors].filter(Boolean).join(' and ');
  const what = r.blank
    ? `The copy did not draw this page inside the preview's sealed frame${why ? ` (${why})` : ''}.`
    : `Some parts of this page may not run inside the preview's sealed frame: ${why}.`;
  return `${what} The downloaded copy is not affected: on a host of its own it runs normally.`;
}

/** A strip of every copied page (a small picture of its first screen and its match), to jump between pages. */
function PageStrip({ project, result, pages, page, onPick, fidByPage, label }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [page]);
  return (
    <div className={ws.strip} ref={ref} role="group" aria-label="Pages of the copy">
      {pages.map((p) => {
        const info = result.pages?.find((x) => x.outPath === p);
        const src = captureShot(project.id, result, info, 'desktop', 'fold');
        const score = fidByPage.get(p)?.score;
        const tone = matchRating(score).tone;
        return (
          <button key={p} type="button" aria-pressed={p === page} onClick={() => onPick(p)} title={label(p)}>
            <span className={ws.stripShot}>{src ? <img src={src} alt="" loading="lazy" decoding="async" /> : null}</span>
            <span className={ws.stripText}>
              <span className="mono">{label(p)}</span>
              {score != null && (
                <span className={ws.stripScore} data-tone={tone}>
                  {score}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const SIZES = [
  { value: 1440, label: 'Computer', icon: Monitor },
  { value: 768, label: 'Tablet', icon: Tablet },
  { value: 375, label: 'Phone', icon: Smartphone },
];

/** How closely the selected page matches the original: one score and one plain verdict, plus the screen size shown. */
function PageMatch({ fid, view }) {
  if (!fid || fid.score == null) {
    return <p className={ws.hint}>How closely this page matches was not measured for this copy.</p>;
  }
  const r = matchRating(fid.score);
  const here = fid.views?.[view]?.score;
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
      {here != null && (
        <span className={ws.hint}>
          On this screen size ({VIEWPORT_NAMES[view] ?? view}): {here}/100
        </span>
      )}
    </div>
  );
}

/** Step 3: the original and the copy side by side, the same page and screen size on both. */
export default function CompareStep({ project, audit, onGoCreate, focusPage }) {
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const preview = useProjects((s) => s.previews[project.id]);
  const ensurePreview = useProjects((s) => s.ensurePreview);
  const [viewport, setViewport] = useState(1440);
  const [page, setPage] = useState('index.html');
  const [sync, setSync] = useState(false);
  const [oldScroller, setOldScroller] = useState(null);
  const [newScroller, setNewScroller] = useState(null);
  // An original as-is copy is shown from its own address (its preview server, behavior/preserve/asisPreview.js).
  const asIsCopy = Boolean(result?.asIs);
  const [asIsUrl, setAsIsUrl] = useState(null);
  useEffect(() => {
    if (!asIsCopy || !result?.recreateId) return undefined;
    let alive = true;
    api.startAsIsPreview(project.id, result.recreateId).then((r) => alive && setAsIsUrl(r.url)).catch(() => alive && setAsIsUrl(null));
    return () => { alive = false; };
  }, [asIsCopy, project.id, result?.recreateId]);
  useSyncScroll(oldScroller, newScroller, sync);
  // What the copy's own script could not do inside the preview's sealed frame: the shim the preview serves first reports
  // counts, with the preview's token, from the sandboxed (origin "null") frame; nothing else is accepted as a report.
  const previewToken = (asIsCopy ? asIsUrl : preview?.url)?.match(PREVIEW_TOKEN)?.[1] ?? null;
  const [frameReport, setFrameReport] = useState(null);
  // The copy's height as its own page reports it (the shim, while the copy is shown in its live frame): what lets
  // "Scrolling together" draw the copy at full height when the run did not measure it. Not taken from the full-height
  // frame itself, whose window is as tall as the page (a "100vh" section would make it grow without end).
  const [reportedHeight, setReportedHeight] = useState(null);
  const takeHeight = useRef(true);
  useEffect(() => {
    setFrameReport(null);
    setReportedHeight(null);
    if (!previewToken) return undefined;
    const onMessage = (e) => {
      const d = e.data;
      if (e.origin !== 'null' || !d || d.sasPreview !== 1 || d.token !== previewToken) return;
      if (typeof d.height === 'number') {
        if (takeHeight.current && Number.isFinite(d.height) && d.height > 0) setReportedHeight((h) => Math.max(h ?? 0, Math.min(Math.round(d.height), 200000)));
        return;
      }
      const count = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 999) : 0);
      setFrameReport({ failed: count(d.failed), errors: count(d.errors), blank: d.blank === true });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewToken, page, viewport]);

  const pages = result?.preview?.pages ?? result?.pages?.map((p) => p.outPath) ?? [];
  // A new copy opens on its homepage.
  useEffect(() => setPage(pages[0] ?? 'index.html'), [result?.recreateId]);
  // …or on the page picked elsewhere (the page pictures in Results).
  useEffect(() => {
    if (focusPage && pages.includes(focusPage)) setPage(focusPage);
  }, [focusPage, result?.recreateId]);
  const shown = shownStack(result, project.stack);
  const shownOutput = outputsOf(result)[shown];

  // A preview of another build than the one shown (the stack was changed, or its build just finished): start the right one.
  const previewStale = Boolean(result && !asIsCopy && preview?.url && preview.recreateId === result.recreateId && !preview.loading && (preview.stack ?? 'html') !== shown);
  useEffect(() => {
    if (previewStale) ensurePreview(project.id);
  }, [previewStale, project.id, ensurePreview]);

  // The original, live or as a picture. The picture is the one the copy step took of this page, the homepage included: it was
  // taken when the copy was made, after its own scroll-through, while the check's picture may be older (one taken before the
  // check paused at each scroll step left the sections that fade in on scroll blank). The homepage falls back to the check's.
  const siteUrl = audit?.url ?? project.url;
  const pageInfo = result?.pages?.find((p) => p.outPath === page) ?? null;
  const otherPage = pageInfo && pageInfo.path !== '/' && pageInfo.url ? pageInfo : null;
  const originalUrl = otherPage?.url ?? siteUrl;
  const capturedViews = pageInfo?.slug ? pageInfo.views ?? [] : [];
  const pageShot = capturedViews.length || otherPage
    ? (vp) => (capturedViews.includes(vp.view)
      ? { viewport: { width: vp.id }, full: { url: apiUrl(`/projects/${project.id}/recreate/${result.recreateId}/captures/${pageInfo.slug}/${vp.view}-full.webp`) } }
      : (!otherPage && audit?.screenshots?.views?.[vp.view]) || null)
    : undefined;
  // Live only when the site can be framed and answers right now (a site that is down would draw a blank frame).
  const live = useLiveAnswer(project.id, originalUrl, liveAvailability(audit, originalUrl));
  const hasScreens = capturedViews.length > 0 || (!otherPage && Boolean(audit?.screenshots));
  // One mode for both sides (compareSides): live on both when the original can be framed, whether or not they scroll
  // together; pictures on both when it cannot. Either side's Live / Picture switch changes both.
  const [mode, setMode] = useState('screenshot');
  useEffect(() => {
    setMode(defaultPreviewMode(live));
  }, [audit?.analysisId, originalUrl, live.ok]);

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

  const copyUrl = asIsCopy ? asIsUrl : preview?.url;
  // An as-is copy runs its own code, sandboxed: nothing of it reaches the app (see sandboxFor).
  const frameSandbox = asIsCopy ? 'allow-scripts' : sandboxFor(preview);
  const ready = Boolean(asIsCopy ? asIsUrl : preview?.url && preview.recreateId === result.recreateId);
  const src = ready ? `${copyUrl}${pageUrl(pageOf(result, shown, page).file)}` : null;
  const view = VIEWPORTS.find((v) => v.id === viewport)?.view;
  const fidPages = fidelityPages(result);
  const measuredHeight = fidPages.find((p) => p.outPath === page)?.views?.[view]?.height?.generated ?? null;
  const pageHeight = measuredHeight ?? reportedHeight;
  const fullPage = sync && ready && pageHeight > 0;
  takeHeight.current = !fullPage;
  const realOriginal = audit && !audit.isDummy;
  // Live not available (the site blocks framing, or this app's own address): say so, and what is shown instead.
  const originalNote = realOriginal ? unavailableNote(live, hasScreens) : null;
  const fidByPage = new Map(fidPages.map((p) => [p.outPath, p]));
  const pageIndex = Math.max(0, pages.indexOf(page));
  // The copy's own pictures (taken when its match was measured), per screen size.
  const copyInfo = result.pages?.find((p) => p.outPath === page) ?? null;
  const copyPageShot = (vp) => {
    const fid = fidByPage.get(page);
    const fv = fid?.views?.[vp.view];
    if (!fv || !copyInfo?.slug) return null;
    // An as-is copy's picture is made by the server on first request: the picture view asks again until it is there.
    return { viewport: { width: vp.id }, retry: Boolean(fid.asIs), full: { url: apiUrl(`/projects/${project.id}/recreate/${result.recreateId}/fidelity/${copyInfo.slug}/${vp.view}-full.webp`) } };
  };
  const copyHasShots = Boolean(copyInfo?.slug && fidByPage.get(page)?.views);
  const sides = compareSides(mode, live, copyHasShots);
  const copyPicture = sides.copy === 'screenshot';
  // Scrolling together with the original live: the app cannot scroll a frame of another site, so the original is drawn at
  // its full height (measured when the copy was made, or by the check for the homepage) in a box the app scrolls.
  const originalHeight = fidByPage.get(page)?.views?.[view]?.height?.original
    ?? (!otherPage ? audit?.screenshots?.views?.[view]?.pageHeight : null) ?? null;
  const originalFull = sync && sides.original === 'live' && originalHeight > 0;
  const frameNote = ready && !copyPicture ? previewLimitNote(frameReport) : null;
  // Scrolling together draws a live page at full height; until its height is known that side cannot follow.
  const syncNote = sync && ready && !copyPicture && !fullPage
    ? (frameSandbox
      ? 'Measuring how tall the copy’s page is, so both sides can scroll together…'
      : 'This copy’s page height was not measured during the run, so it cannot scroll together with the original. Create the copy again to measure it.')
    : sync && sides.original === 'live' && !originalFull
      ? 'How tall the original’s page is was not measured for this screen size, so the original scrolls on its own. Choose Picture to scroll both together.'
      : null;

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
        <Segmented options={SIZES} value={viewport} onChange={setViewport} label="Screen size" />
        <span className={ws.toolbarEnd}>
          <Button icon={ArrowUpDown} variant={sync ? 'primary' : 'secondary'} aria-pressed={sync} onClick={() => setSync((on) => !on)}>
            {sync ? 'Scrolling together' : TERMS.sync.title}
          </Button>
          <InfoTip label={TERMS.sync.title} align="end">
            {TERMS.sync.explain}
          </InfoTip>
        </span>
      </div>

      {pages.length > 1 && <PageStrip project={project} result={result} pages={pages} page={page} onPick={setPage} fidByPage={fidByPage} label={(p) => pageOf(result, shown, p).path} />}

      <PageMatch fid={fidByPage.get(page)} view={view} />

      <div className={ws.compare}>
        <section aria-label={TERMS.original}>
          <p className={ws.compareLabel} data-side="old">
            {TERMS.original}
          </p>
          <PreviewFrame
            address={originalUrl}
            tone="old"
            viewport={viewport}
            onViewportChange={setViewport}
            fit={Boolean(realOriginal)}
            viewportButtons={false}
            overlay={originalNote && (<><ShieldAlert size={13} color="var(--warn)" aria-hidden="true" /><span>{originalNote}</span></>)}
            toolbar={realOriginal && <ModeToggle mode={sides.original} onChange={setMode} live={live} hasScreens={hasScreens} />}
          >
            {realOriginal && (originalFull ? (
              <FullPageFrame
                key={`${originalUrl}-${viewport}`}
                url={originalUrl}
                width={viewport}
                height={originalHeight}
                scrollRef={setOldScroller}
                sandbox={LIVE_SANDBOX}
                title={`Live preview of ${originalUrl}`}
                loadingText="Loading live page…"
              />
            ) : (
              <SitePreview url={originalUrl} audit={audit} mode={sides.original} viewport={viewport} scrollRef={sync ? setOldScroller : undefined} pageShot={pageShot} />
            ))}
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
            onViewportChange={setViewport}
            fit={ready || copyPicture}
            viewportButtons={false}
            toolbar={copyHasShots && <ModeToggle mode={sides.copy} onChange={setMode} live={live} hasScreens={copyHasShots} />}
          >
            {copyPicture ? (
              <SitePreview url={src ?? 'the copy'} audit={audit} mode="screenshot" viewport={viewport} scrollRef={sync ? setNewScroller : undefined} pageShot={copyPageShot} />
            ) : fullPage ? (
              <FullPageFrame
                key={`${preview.recreateId}-${preview.startedAt}-${page}-${viewport}`}
                url={src}
                width={viewport}
                height={pageHeight}
                scrollRef={setNewScroller}
                sandbox={frameSandbox}
                title="The new copy"
                loadingText="Loading the copy…"
              />
            ) : ready ? (
              <LiveFrame key={`${preview.recreateId}-${preview.startedAt}`} url={src} width={viewport} sandbox={frameSandbox} title="The new copy" loadingText="Loading the copy…" />
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
          {syncNote && (
            <p className={styles.dummyNote} role="status">
              <Info size={13} aria-hidden="true" />
              <span>{syncNote}</span>
            </p>
          )}
          {frameNote && (
            <p className={styles.dummyNote} role="status">
              <Info size={13} aria-hidden="true" />
              <span>{frameNote}</span>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
