import { Lock, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';
import styles from './PreviewFrame.module.css';

const VIEWPORTS = [
  { id: 1440, icon: Monitor, label: 'Desktop 1440' },
  { id: 768, icon: Tablet, label: 'Tablet 768' },
  { id: 375, icon: Smartphone, label: 'Phone 375' },
];

// Browser-chrome frame. Phase 1 me content placeholder hai; Phase 3/5 me iframe/screenshot aayega.
export default function PreviewFrame({ address, tone = 'old', overlay, children }) {
  const [viewport, setViewport] = useState(1440);

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
        <span className={styles.viewports} role="group" aria-label="Viewport">
          {VIEWPORTS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={viewport === id}
              title={label}
              onClick={() => setViewport(id)}
            >
              <Icon size={13} aria-hidden="true" />
              <span className="visually-hidden">{label}</span>
            </button>
          ))}
        </span>
      </div>
      <div className={styles.stage}>
        <div className={styles.page} style={{ maxWidth: viewport === 1440 ? '100%' : viewport === 768 ? 300 : 150 }}>
          {children}
        </div>
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
