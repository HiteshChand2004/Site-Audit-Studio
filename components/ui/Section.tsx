import type { ReactNode } from 'react';

/** A page section with the standard vertical rhythm. `tint` gives a warm band (never dark). */
export function Section({
  id,
  labelledBy,
  label,
  tone = 'plain',
  size = 'md',
  className = '',
  children,
}: {
  id?: string;
  labelledBy?: string;
  label?: string;
  tone?: 'plain' | 'tint';
  size?: 'sm' | 'md';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} aria-label={label} className={['section', `section--${tone}`, size === 'sm' && 'section--sm', className].filter(Boolean).join(' ')}>
      <div className="container">{children}</div>
    </section>
  );
}

/** Small label, serif title with one emphasised word (wrap it in <em>), one short line. */
export function SectionHead({ id, label, title, lead, center = false, children }: { id: string; label?: string; title: ReactNode; lead?: ReactNode; center?: boolean; children?: ReactNode }) {
  return (
    <header className={`shead${center ? ' shead--center' : ''}`} data-reveal>
      {label && <p className="label">{label}</p>}
      <h2 id={id} className="display d2 shead__title">
        {title}
      </h2>
      {lead && <p className="lead shead__lead">{lead}</p>}
      {children}
    </header>
  );
}

/** The opening block of an inner page. */
export function PageHero({ label, title, lead, children }: { label: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="phero">
      <div className="phero__glow" aria-hidden="true" />
      <div className="container phero__inner">
        <p className="label">{label}</p>
        <h1 className="display d1 phero__title">{title}</h1>
        {lead && <p className="lead phero__lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}
