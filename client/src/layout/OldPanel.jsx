import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Globe, Info, Loader2, Play, Settings2, Sparkles, ShieldAlert } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame, { Wireframe } from '../components/preview/PreviewFrame.jsx';
import SitePreview, { liveAvailability, ModeToggle } from '../components/preview/SitePreview.jsx';
import MetricsBar from '../components/audit/MetricsBar.jsx';
import AuditReport from '../components/audit/AuditReport.jsx';
import AnalyzeProgress from '../components/audit/AnalyzeProgress.jsx';
import { stackById } from '../constants.js';
import { isAnalysisActive, useProjects } from '../store/useProjects.js';
import styles from './Panel.module.css';

const Spinner = (props) => <Loader2 {...props} className={styles.spin} />;

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// The preview viewport and the metrics device follow each other (tablet has no Lighthouse run).
const DEVICE_OF = { 1440: 'desktop', 375: 'mobile' };
const VIEWPORT_OF = { desktop: 1440, mobile: 375 };

function previewOverlay({ audit, mode, slow }) {
  if (!audit) return null;
  if (audit.isDummy) {
    return (
      <>
        <Info size={13} aria-hidden="true" />
        <span>Sample preview — run Analyze to load the real site</span>
      </>
    );
  }
  if (mode === 'live' && slow) {
    return (
      <>
        <Clock size={13} color="var(--warn)" aria-hidden="true" />
        <span>Still loading — switch to “Shot” if the page stays blank</span>
      </>
    );
  }
  if (mode === 'live' && audit.frame.confidence === 'uncertain') {
    return (
      <>
        <AlertTriangle size={13} color="var(--warn)" aria-hidden="true" />
        <span title={audit.frame.notes.join(' ')}>May render blank when framed · try “Shot”</span>
      </>
    );
  }
  if (!audit.frame.frameable) {
    return (
      <>
        <ShieldAlert size={13} color="var(--warn)" aria-hidden="true" />
        <span>
          Iframe blocked · <span className="mono">{audit.frame.reason}</span>
        </span>
      </>
    );
  }
  return null;
}

export default function OldPanel({ project, audit, loading, onOpenStack }) {
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
  const previewUrl = audit?.url ?? project.url;
  const live = liveAvailability(audit, previewUrl);
  const hasScreens = Boolean(audit?.screenshots);
  const [mode, setMode] = useState('screenshot');
  // A new analysis (or project) picks its default: live when the site can be framed.
  useEffect(() => {
    setMode(live.ok ? 'live' : 'screenshot');
  }, [audit?.analysisId, audit?.isDummy, previewUrl, live.ok]);

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
    <section className={`${styles.panel} ${styles.old}`} aria-label="Original website">
      <header className={styles.header}>
        <span className={styles.chip}>OLD</span>
        <span className={styles.headerSub}>Original site</span>
        <span className={styles.headerRight}>
          {audit?.isDummy && <Badge tone="warn">Dummy data</Badge>}
        </span>
      </header>

      <div className={`${styles.body} scroll`}>
        <form className={styles.urlRow} onSubmit={onSubmit}>
          <label className={styles.urlInput}>
            <Globe size={14} aria-hidden="true" />
            <input
              className="mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Website URL"
              disabled={running}
            />
          </label>
          <label className={styles.pagesInput} title="Maximum pages to crawl (1–100)">
            <span>Pages</span>
            <input
              className="mono"
              type="number"
              min={1}
              max={100}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              onBlur={saveMaxPages}
              aria-label="Maximum pages to crawl"
              disabled={running}
            />
          </label>
          <Button type="submit" variant={audit?.isDummy ? 'primary' : 'secondary'} icon={running ? Spinner : Play} disabled={running}>
            {running ? 'Analyzing…' : 'Analyze'}
          </Button>
        </form>

        {analysis && analysis.status !== 'done' && (
          <AnalyzeProgress analysis={analysis} onDismiss={() => dismissAnalysis(project.id)} />
        )}

        <PreviewFrame
          address={previewUrl}
          tone="old"
          viewport={viewport}
          onViewportChange={changeViewport}
          fit={Boolean(realPreview)}
          toolbar={realPreview && <ModeToggle mode={mode} onChange={setMode} live={live} hasScreens={hasScreens} />}
          overlay={previewOverlay({ audit, mode, slow })}
        >
          {realPreview ? (
            <SitePreview url={previewUrl} audit={audit} mode={mode} viewport={viewport} onSlow={setSlow} />
          ) : (
            <Wireframe />
          )}
        </PreviewFrame>
        {realPreview && audit.blockedHosts?.length > 0 && (
          <p className={styles.dummyNote}>
            <ShieldAlert size={13} aria-hidden="true" />
            Requests to private network addresses were blocked during Analyze: {audit.blockedHosts.join(', ')}
          </p>
        )}

        {loading && <p className={styles.dummyNote}>Loading audit…</p>}

        {audit && (
          <>
            <div className={styles.sectionTitle}>
              <span>Performance</span>
              {!audit.isDummy && audit.metrics?.device && <span className={styles.sectionMeta}>Lighthouse · homepage</span>}
            </div>
            <MetricsBar
              metrics={audit.metrics}
              metricsByDevice={audit.metricsByDevice}
              scores={audit.scores}
              device={device}
              onDeviceChange={changeDevice}
            />

            <div className={styles.sectionTitle}>
              <span>Audit report</span>
              {!audit.isDummy && (
                <span className={styles.sectionMeta}>
                  Analyzed {timeAgo(audit.analyzedAt)} · {audit.pagesCrawled} {audit.pagesCrawled === 1 ? 'page' : 'pages'}
                </span>
              )}
            </div>
            {audit.isDummy && (
              <p className={styles.dummyNote}>
                <Info size={13} aria-hidden="true" />
                Sample report — click “Analyze” to run the real audit.
              </p>
            )}
            {audit.errors?.length > 0 && (
              <div className={styles.stepErrors} role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <div>
                  <strong>Some checks did not complete; the report is partial.</strong>
                  <ul>
                    {audit.errors.map((e, i) => (
                      <li key={i}>
                        <span className="mono">{e.step}</span> — {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <AuditReport audit={audit} />
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <Button variant="primary" icon={Sparkles} disabled title="Available in Phase 4">
          Recreate
        </Button>
        <Button icon={Settings2} iconOnly onClick={onOpenStack} title="Output stack settings">
          Output stack settings
        </Button>
        <span className={styles.footerNote}>
          Output: <strong>{stackById(project.stack).name}</strong>
        </span>
      </footer>
    </section>
  );
}
