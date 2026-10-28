import type { ReactNode } from 'react';

/** A browser window around a mockup: traffic dots, an address and an optional tag. */
export function BrowserFrame({ addr, tag, tagInk = false, className = '', children }: { addr: string; tag?: string; tagInk?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`frame ${className}`}>
      <FrameBar addr={addr} tag={tag} tagInk={tagInk} />
      {children}
    </div>
  );
}

export function FrameBar({ addr, tag, tagInk = false }: { addr: string; tag?: string; tagInk?: boolean }) {
  return (
    <div className="frame__bar">
      <span className="frame__dots">
        <i />
        <i />
        <i />
      </span>
      <span className="frame__addr">{addr}</span>
      {tag && <span className={`frame__tag${tagInk ? ' frame__tag--ink' : ''}`}>{tag}</span>}
    </div>
  );
}
