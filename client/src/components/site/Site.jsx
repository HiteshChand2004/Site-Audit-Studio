// Small pieces that show one website the same way everywhere: its icon, a picture of it in a browser frame, and where its
// work stands (three marks: checked, copy made, compared).
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { EmptySiteArt } from '../common/Illustrations.jsx';
import { STAGE_NAMES, stagesLabel } from '../../siteData.js';
import styles from './Site.module.css';

/** The website's own icon (read and kept by the server), or its first letter when it has none or it cannot be loaded. */
export function SiteIcon({ project, host, size = 32 }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.icon} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {failed ? (
        (host || project.name || '?').charAt(0).toUpperCase()
      ) : (
        <img src={`/api/projects/${project.id}/favicon`} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/**
 * A picture of a page inside a light browser frame. Shows a shimmering placeholder while it loads and a drawn empty
 * window when there is no picture (or it cannot be loaded). `ratio` is width / height of the visible area.
 */
export function BrowserShot({ src, address, alt, ratio = 16 / 10, chrome = true, emptyText, className = '', size = 'md', position = 'top' }) {
  const [state, setState] = useState(src ? 'loading' : 'none');
  useEffect(() => setState(src ? 'loading' : 'none'), [src]);
  return (
    <figure className={`${styles.shot} ${className}`} data-size={size}>
      {chrome && (
        <div className={styles.chrome} aria-hidden="true">
          <span className={styles.dots}>
            <i />
            <i />
            <i />
          </span>
          {address && (
            <span className={`${styles.address} mono`}>
              <Lock size={9} />
              <span>{address}</span>
            </span>
          )}
        </div>
      )}
      <div className={styles.viewport} style={{ aspectRatio: ratio }}>
        {state === 'loading' && <span className={`${styles.placeholder} skeleton`} aria-hidden="true" />}
        {src && state !== 'failed' && (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            style={{ objectPosition: position }}
            data-loaded={state === 'ready' || undefined}
            onLoad={() => setState('ready')}
            onError={() => setState('failed')}
          />
        )}
        {(state === 'none' || state === 'failed') && (
          <div className={styles.empty}>
            <EmptySiteArt className={styles.emptyArt} />
            {emptyText && <span>{emptyText}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

/** Three marks: checked, copy made, compared (done, running, failed, warn or not yet). */
export function StageDots({ stages, showLabels = false }) {
  const label = stagesLabel(stages);
  return (
    <span className={styles.stages} data-labels={showLabels || undefined} role="img" aria-label={label} title={label}>
      {Object.keys(STAGE_NAMES).map((k) => (
        <span key={k} className={styles.stage} data-state={stages[k]}>
          <i />
          {showLabels && <span>{STAGE_NAMES[k]}</span>}
        </span>
      ))}
    </span>
  );
}
