import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Globe, Info, Loader2, Play, ShieldAlert } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import PreviewFrame, { Wireframe } from '../../components/preview/PreviewFrame.jsx';
import SitePreview, { liveAvailability, ModeToggle } from '../../components/preview/SitePreview.jsx';
import MetricsBar from '../../components/audit/MetricsBar.jsx';
import AuditReport from '../../components/audit/AuditReport.jsx';
import AnalyzeProgress from '../../components/audit/AnalyzeProgress.jsx';
import { isAnalysisActive, useProjects } from '../../store/useProjects.js';
import { timeAgo } from '../../format.js';
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
        <span title={audit.frame.reason}>This site does not allow being shown inside another app · showing a picture</span>
      </>
    );
  }
  return null;
}

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
  const running = isAnalysisActive(analysis);

  const [viewport, setViewport] = useState(1440);
  const [device, setDevice] = useState('desktop');
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
        <Button type="submit" variant={audit?.isDummy ? 'primary' : 'secondary'} icon={running ? Spinner : Play} disabled={running}>
          {running ? 'Checking…' : audit?.isDummy ? 'Check now' : 'Check again'}
        </Button>
      </form>

      {analysis && analysis.status !== 'done' && <AnalyzeProgress analysis={analysis} onDismiss={() => dismissAnalysis(project.id)} />}

      <div className={ws.split}>
        <div className={ws.splitMain}>
          {loading && <p className={styles.dummyNote}>Loading the report…</p>}
          {audit && (
            <>
              <div className={styles.sectionTitle}>
                <span>Speed</span>
                {!audit.isDummy && audit.metrics?.device && <span className={styles.sectionMeta}>Homepage, measured with Google Lighthouse</span>}
              </div>
              <MetricsBar metrics={audit.metrics} metricsByDevice={audit.metricsByDevice} scores={audit.scores} device={device} onDeviceChange={changeDevice} />

              <div className={styles.sectionTitle}>
                <span>Report</span>
                {!audit.isDummy && (
                  <span className={styles.sectionMeta}>
                    Checked {timeAgo(audit.analyzedAt)} · {audit.pagesCrawled} {audit.pagesCrawled === 1 ? 'page' : 'pages'}
                  </span>
                )}
              </div>
              {audit.isDummy && (
                <p className={styles.dummyNote}>
                  <Info size={13} aria-hidden="true" />
                  Example report — click “Check now” to check the real site.
                </p>
              )}
              {audit.errors?.length > 0 && (
                <div className={styles.stepErrors} role="status">
                  <AlertTriangle size={13} aria-hidden="true" />
                  <div>
                    <strong>Some checks did not finish, so the report is incomplete.</strong>
                    <ul>
                      {audit.errors.map((e, i) => (
                        <li key={i}>{e.message}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <AuditReport audit={audit} />
            </>
          )}
        </div>

        <aside className={ws.splitSide} aria-label="The original site">
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
          {realPreview && audit.blockedHosts?.length > 0 && (
            <p className={styles.dummyNote}>
              <ShieldAlert size={13} aria-hidden="true" />
              Some requests to private network addresses were blocked for safety: {audit.blockedHosts.join(', ')}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
