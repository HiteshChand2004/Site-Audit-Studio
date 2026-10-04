import { Lock, Monitor } from 'lucide-react';
import { useState } from 'react';
import styles from './PreviewFrame.module.css';

// Desktop only for now (the server captures the computer view only; see server/src/recreate/views.js). The tablet
// (768, Tablet icon) and phone (375, Smartphone icon) sizes are parked; with one size the frame shows no size buttons.
export const VIEWPORTS = [{ id: 1440, view: 'desktop', icon: Monitor, label: 'Computer screen (1440 px wide)' }];

/**
 * Browser-chrome frame. The viewport can be controlled (`viewport` + `onViewportChange`) or left
 * to the frame. With `fit`, children fill the stage and size themselves to the viewport (the real
 * site preview); without it, the placeholder content is squeezed to hint at the width. `viewportButtons={false}` hides
 * the frame's own screen-size buttons when a toolbar outside it controls the size (the Compare step).
 */
export default function PreviewFrame({ address, tone = 'old', overlay, toolbar, viewport, onViewportChange, fit = false, viewportButtons = true, children }) {
  const [ownViewport, setOwnViewport] = useState(1440);
  const current = viewport ?? ownViewport;
  const select = onViewportChange ?? setOwnViewport;

  return (
    <div className={styles.frame} data-tone={tone}>
      <div className={styles.chrome}>
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={`${styles.address} mono`}>
          <Lock size={11} aria-hidden="true" />
          <span>{address}</span>
        </span>
        {toolbar}
        {viewportButtons && VIEWPORTS.length > 1 && (
          <span className={styles.viewports} role="group" aria-label="Screen size">
            {VIEWPORTS.map(({ id, icon: Icon, label }) => (
              <button key={id} type="button" aria-pressed={current === id} title={label} onClick={() => select(id)}>
                <Icon size={13} aria-hidden="true" />
                <span className="visually-hidden">{label}</span>
              </button>
            ))}
          </span>
        )}
      </div>
      <div className={styles.stage} data-fit={fit || undefined}>
        {fit ? (
          children
        ) : (
          <div className={styles.page} style={{ maxWidth: current === 1440 ? '100%' : current === 768 ? 300 : 150 }}>
            {children}
          </div>
        )}
        {overlay && <div className={styles.overlay}>{overlay}</div>}
      </div>
    </div>
  );
}

export function Wireframe() {
  return (
    <div className={styles.wire} aria-hidden="true">
      <div className={styles.wNav}>
        <b />
        <span>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className={styles.wHero}>
        <b />
        <b />
        <i />
      </div>
      <div className={styles.wCards}>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
