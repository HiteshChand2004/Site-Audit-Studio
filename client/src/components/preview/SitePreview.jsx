import { useEffect, useLayoutEffect, useState } from 'react';
import { Camera, Globe, ImageOff } from 'lucide-react';
import { VIEWPORTS } from './PreviewFrame.jsx';
import styles from './SitePreview.module.css';

const LOAD_HINT_MS = 15000;

// Framing our own app would let the page script this UI (allow-scripts + allow-same-origin).
const APP_PORTS = new Set(['5173', '4000']);
export function isAppOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin === window.location.origin || (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && APP_PORTS.has(u.port));
  } catch {
    return true;
  }
}

/** Whether the live iframe may be used for this audit, and why not. */
export function liveAvailability(audit, url) {
  if (!audit || audit.isDummy) return { ok: false, why: 'Run Analyze to load the real site.' };
  if (isAppOrigin(url)) return { ok: false, why: 'This app cannot frame itself.' };
  if (!audit.frame?.frameable) return { ok: false, why: `The site blocks framing (${audit.frame?.reason}).` };
  return { ok: true, why: null };
}

export function ModeToggle({ mode, onChange, live, hasScreens }) {
  return (
    <span className={styles.modes} role="group" aria-label="Preview mode">
      <button type="button" aria-pressed={mode === 'live'} disabled={!live.ok} title={live.why ?? 'Live page in an iframe'} onClick={() => onChange('live')}>
        <Globe size={12} aria-hidden="true" />
        Live
      </button>
      <button
        type="button"
        aria-pressed={mode === 'screenshot'}
        disabled={!hasScreens}
        title={hasScreens ? 'Rendered screenshot' : 'No screenshots for this analysis'}
        onClick={() => onChange('screenshot')}
      >
        <Camera size={12} aria-hidden="true" />
        Shot
      </button>
    </span>
  );
}

// Size of the stage, tracked so the page can be rendered at its real width and scaled.
// A callback ref, because the measured element can mount after the component does.
function useStageSize() {
  const [el, setEl] = useState(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

function LiveFrame({ url, width, onSlow }) {
  const [ref, stage] = useStageSize();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    const t = setTimeout(() => onSlow(true), LOAD_HINT_MS);
    return () => {
      clearTimeout(t);
      onSlow(false);
    };
  }, [url, onSlow]);

  const scale = stage.width ? Math.min(1, stage.width / width) : 0;
  return (
    <div ref={ref} className={styles.stage}>
      {scale > 0 && (
        <div className={styles.scaled} style={{ width: width * scale, height: stage.height }}>
          {!loaded && <div className={styles.loading}>Loading live page…</div>}
          <iframe
            className={styles.iframe}
            src={url}
            title={`Live preview of ${url}`}
            // No allow-top-navigation (defeats frame-busting), no forms or popups, no device permissions.
            sandbox="allow-scripts allow-same-origin"
            allow=""
            referrerPolicy="no-referrer"
            style={{ width, height: stage.height / scale, transform: `scale(${scale})` }}
            onLoad={() => {
              setLoaded(true);
              onSlow(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function Screenshot({ shot, viewport, url }) {
  const [ref, stage] = useStageSize();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [shot?.full.url]);

  if (!shot) {
    return (
      <Empty icon={ImageOff} title="No screenshot for this width">
        The {viewport.label.toLowerCase()} capture failed during Analyze. See the report errors.
      </Empty>
    );
  }
  if (failed) {
    return (
      <Empty icon={ImageOff} title="Screenshot not available">
        Only the latest 3 analyses keep their screenshots. Run Analyze again to capture new ones.
      </Empty>
    );
  }
  const width = Math.min(stage.width, shot.viewport.width);
  return (
    <div ref={ref} className={`${styles.stage} ${styles.scroll} scroll`} tabIndex={0} aria-label="Screenshot, scrollable">
      {width > 0 && (
        <img
          className={styles.shot}
          src={shot.full.url}
          alt={`Screenshot of ${url} at ${shot.viewport.width}px`}
          width={shot.full.width}
          height={shot.full.height}
          style={{ width, height: 'auto' }}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {shot.truncated && width > 0 && (
        <p className={styles.truncated} style={{ width }}>
          Page continues — capture is capped at 8,000px of {shot.pageHeight.toLocaleString()}px.
        </p>
      )}
    </div>
  );
}

function Empty({ icon: Icon, title, children }) {
  return (
    <div className={styles.empty}>
      <Icon size={18} aria-hidden="true" />
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyText}>{children}</p>
    </div>
  );
}

/**
 * The OLD site preview: the live page in a sandboxed iframe when the site allows framing, else the
 * screenshot taken during Analyze. Rendered at the real viewport width and scaled to the panel.
 */
export default function SitePreview({ url, audit, mode, viewport, onSlow }) {
  const vp = VIEWPORTS.find((v) => v.id === viewport) ?? VIEWPORTS[0];
  if (mode === 'live') return <LiveFrame url={url} width={vp.id} onSlow={onSlow} />;
  if (!audit?.screenshots) {
    return (
      <Empty icon={Camera} title="No screenshots yet">
        This analysis has no screenshots. Run Analyze again to capture desktop, tablet and phone views.
      </Empty>
    );
  }
  return <Screenshot shot={audit.screenshots.views[vp.view]} viewport={vp} url={url} />;
}
