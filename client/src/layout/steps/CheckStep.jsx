import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Globe, Info, Loader2, Play, ShieldAlert } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import PreviewFrame, { Wireframe } from '../../components/preview/PreviewFrame.jsx';
import SitePreview, { liveAvailability, ModeToggle } from '../../components/preview/SitePreview.jsx';
import HealthOverview, { summarize } from '../../components/audit/HealthOverview.jsx';
import FixList, { problemsOf } from '../../components/audit/FixList.jsx';
import Details from '../../components/common/Details.jsx';
import { Alert } from '../../components/common/Surface.jsx';
import AuditReport from '../../components/audit/AuditReport.jsx';
import AnalyzeProgress from '../../components/audit/AnalyzeProgress.jsx';
import PageScope, { pathOf } from '../../components/project/PageScope.jsx';
import { isAnalysisActive, selectIsOwner, useProjects } from '../../store/useProjects.js';
import { plural, timeAgo } from '../../format.js';
import styles from '../Panel.module.css';
import ws from '../Workspace.module.css';

const Spinner = (props) => <Loader2 {...props} className={styles.spin} />;

// The preview viewport and the metrics device follow each other (tablet has no Lighthouse run).
const DEVICE_OF = { 1440: 'desktop', 375: 'mobile' };
const VIEWPORT_OF = { desktop: 1440, mobile: 375 };

function previewOverlay({ audit, mode, slow }) {
  if (!audit) return null;
  if (audit.isDummy) {
    return (
      <>
        <Info size={13} aria-hidden="true" />
        <span>Example picture — check the site to load the real one</span>
      </>
    );
  }
  if (mode === 'live' && slow) {
    return (
      <>
        <Clock size={13} color="var(--warn)" aria-hidden="true" />
        <span>Still loading — switch to “Picture” if the page stays blank</span>
      </>
    );
  }
  if (mode === 'live' && audit.frame.confidence === 'uncertain') {
    return (
      <>
        <AlertTriangle size={13} color="var(--warn)" aria-hidden="true" />
        <span title={audit.frame.notes.join(' ')}>This site may not show here · try “Picture”</span>
      </>
    );
  }
  if (!audit.frame.frameable) {
    return (
      <>
        <ShieldAlert size={13} color="var(--warn)" aria-hidden="true" />
        <span title={audit.frame.reason}>This site doesn’t allow being shown here, so you see a picture taken during the check</span>
      </>
    );
  }
  return null;
}

// Jump links of the report (the side column stays in view while the report scrolls).
const TOC = [
  ['check-glance', 'At a glance & speed'],
  ['check-fix', 'What needs fixing'],
  ['check-experts', 'Details'],
];

/** Step 1: check the original site (Analyze) and read its report. */
export default function CheckStep({ project, audit, loading }) {
  const [url, setUrl] = useState(project.url);
  const [maxPages, setMaxPages] = useState(String(project.max_pages ?? 25));
  useEffect(() => setUrl(project.url), [project.url]);
  useEffect(() => setMaxPages(String(project.max_pages ?? 25)), [project.max_pages]);

  const analysis = useProjects((s) => s.analyses[project.id]);
  const analyze = useProjects((s) => s.analyze);
  const update = useProjects((s) => s.update);
  const dismissAnalysis = useProjects((s) => s.dismissAnalysis);
  // Checking one page instead of the whole website is the owner's option (under "Advanced options"); the server refuses it to
  // anyone else and checks the whole website for them, whatever page an older setting saved.
  const isOwner = useProjects(selectIsOwner);
  const pageUrl = isOwner ? project.page_url ?? null : null;
  const running = isAnalysisActive(analysis);

  const [viewport, setViewport] = useState(375);
  const [device, setDevice] = useState('mobile');
  const [slow, setSlow] = useState(false);
  const siteUrl = audit?.url ?? project.url;
  const live = liveAvailability(audit, siteUrl);
  const hasScreens = Boolean(audit?.screenshots);
  const [mode, setMode] = useState('screenshot');
  // A new analysis (or project) picks its default: live when the site can be framed.
  useEffect(() => {
    setMode(live.ok ? 'live' : 'screenshot');
  }, [audit?.analysisId, audit?.isDummy, siteUrl, live.ok]);

  const changeViewport = (v) => {
    setViewport(v);
    if (DEVICE_OF[v]) setDevice(DEVICE_OF[v]);
  };
  const changeDevice = (d) => {
    setDevice(d);
    setViewport(VIEWPORT_OF[d]);
  };
  const realPreview = audit && !audit.isDummy;
  // The one-line answer: how fast it is on phones, and how many things to fix (how many of them important).
  const problems = realPreview ? problemsOf(audit).rows : [];
  const important = problems.filter((r) => r.severity === 'high').length;
  const answer = realPreview
    ? [summarize(audit, 'mobile')[0], problems.length ? `${plural(problems.length, 'thing')} to fix${important ? `, ${important} of them important` : ''}.` : 'Nothing important to fix.'].filter(Boolean).join(' ')
    : null;

  const saveMaxPages = () => {
    const n = Number(maxPages);
    if (Number.isInteger(n) && n >= 1 && n <= 100) {
      if (n !== project.max_pages) update(project.id, { max_pages: n }).catch(() => {});
    } else {
      setMaxPages(String(project.max_pages ?? 25));
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!running) analyze(project.id, url);
  };

  return (
    <div className={ws.stepBody}>
      <form className={styles.urlRow} onSubmit={onSubmit}>
        <label className={styles.urlInput}>
          <Globe size={14} aria-hidden="true" />
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Website address" disabled={running} />
        </label>
        <Button type="submit" variant={audit?.isDummy ? 'primary' : 'secondary'} icon={running ? Spinner : Play} disabled={running}>
          {running ? 'Checking…' : audit?.isDummy ? 'Check now' : 'Check again'}
        </Button>
      </form>

      {!pageUrl && (
        <Details label="settings">
          <label className={styles.pagesInput} title="How many pages the check reads (1–100)">
            <span>Pages to check</span>
            <input
              className="mono"
              type="number"
              min={1}
              max={100}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              onBlur={saveMaxPages}
              aria-label="How many pages the check reads"
              disabled={running}
            />
          </label>
        </Details>
      )}

      {isOwner && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced options</summary>
          <PageScope project={project} disabled={running} />
        </details>
      )}

      {analysis && analysis.status !== 'done' && <AnalyzeProgress analysis={analysis} onDismiss={() => dismissAnalysis(project.id)} />}

      <div className={ws.split}>
        <div className={ws.splitMain}>
          {loading && <p className={styles.dummyNote}>Loading the report…</p>}
          {audit && (
            <>
              {audit.isDummy && (
                <p className={styles.dummyNote}>
                  <Info size={13} aria-hidden="true" />
                  Example report — click “Check now” to check the real site.
                </p>
              )}
              {!audit.isDummy && audit.scope?.kind === 'page' && (
                <p className={ws.hint}>
                  Checked {timeAgo(audit.analyzedAt)} · one page only: <span className="mono">{pathOf(audit.scope.url)}</span> · speed measured on this page
                </p>
              )}
              {!audit.isDummy && audit.scope?.kind !== 'page' && (
                <p className={ws.hint}>
                  Checked {timeAgo(audit.analyzedAt)} · {audit.pagesCrawled} {audit.pagesCrawled === 1 ? 'page' : 'pages'} read
                  {' '}· speed measured on the homepage
                </p>
              )}
              {!audit.isDummy && pageUrl !== (audit.scope?.url ?? null) && (
                <Alert tone="info" title={pageUrl ? `This report is not for ${pathOf(pageUrl)} yet` : 'This report is for one page only'}>
                  {pageUrl ? 'Click “Check again” to check only that page.' : 'Click “Check again” to check the whole website.'}
                </Alert>
              )}
              {audit.errors?.length > 0 && (
                <Alert tone="warn" title="Some checks did not finish, so this report is incomplete">
                  Check again: it usually completes them.
                  <Details label="what stopped">
                    <ul className={ws.plainList}>
                      {audit.errors.map((e, i) => (
                        <li key={i}>{e.message}</li>
                      ))}
                    </ul>
                  </Details>
                </Alert>
              )}
              {answer && (
                <p className={ws.answer}>
                  <strong>{answer}</strong>
                </p>
              )}
              <div id="check-glance" className={ws.anchor}>
                <HealthOverview audit={audit} device={device} onDeviceChange={changeDevice} />
              </div>
              <div id="check-fix" className={ws.anchor}>
                <FixList audit={audit} />
              </div>
              <div id="check-experts" className={ws.anchor}>
                <Details label="details for experts (technology, every check, links, accessibility rules)">
                  {audit.pageVariants > 0 && (
                    <p className={ws.hint}>
                      {plural(audit.pageVariants, 'more address', 'more addresses')} with “?…” at the end counted as the same page.
                    </p>
                  )}
                  {realPreview && audit.blockedHosts?.length > 0 && (
                    <p className={ws.hint}>Some requests to private network addresses were blocked for safety: {audit.blockedHosts.join(', ')}</p>
                  )}
                  <AuditReport audit={audit} />
                </Details>
              </div>
            </>
          )}
        </div>

        <aside className={ws.splitSide} aria-label="The original site">
          {audit && !loading && (
            <nav className={ws.toc} aria-label="On this page">
              <span className="eyebrow">On this page</span>
              {TOC.map(([id, label]) => (
                <button key={id} type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {label}
                </button>
              ))}
            </nav>
          )}
          <div className={styles.sectionTitle}>
            <span>The original site</span>
          </div>
          <PreviewFrame
            address={siteUrl}
            tone="old"
            viewport={viewport}
            onViewportChange={changeViewport}
            fit={Boolean(realPreview)}
            toolbar={realPreview && <ModeToggle mode={mode} onChange={setMode} live={live} hasScreens={hasScreens} />}
            overlay={previewOverlay({ audit, mode, slow })}
          >
            {realPreview ? <SitePreview url={siteUrl} audit={audit} mode={mode} viewport={viewport} onSlow={setSlow} /> : <Wireframe />}
          </PreviewFrame>
        </aside>
      </div>
    </div>
  );
}
