import type { ReactNode } from 'react';

/**
 * A full-width band. `tone`: 'plain' (the page colour), 'soft' or 'tint' (a warm grey) or 'dark' (the ink, edge to edge).
 * `ghost` puts a very low-contrast watermark word behind the content, cropped by the band's edges.
 */
export function Section({
  id,
  labelledBy,
  label,
  tone = 'plain',
  size = 'md',
  ghost,
  className = '',
  children,
}: {
  id?: string;
  labelledBy?: string;
  label?: string;
  tone?: 'plain' | 'soft' | 'tint' | 'dark';
  size?: 'sm' | 'md';
  ghost?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} aria-label={label} className={['section', `section--${tone}`, size === 'sm' && 'section--sm', className].filter(Boolean).join(' ')}>
      {ghost && (
        <span className="ghost" aria-hidden="true">
          {ghost}
        </span>
      )}
      <div className="container">{children}</div>
    </section>
  );
}

/** The small label above a heading: a double slash in the accent colour, then the words. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="eyebrow">
      <span aria-hidden="true">//</span>
      {children}
    </p>
  );
}

/** A heading in two tones: the first line in ink, the second in the accent colour. */
export function TwoTone({ id, line1, line2, as: Tag = 'h2', size, className = '' }: { id?: string; line1: ReactNode; line2: ReactNode; as?: 'h1' | 'h2' | 'h3'; size?: 'xl'; className?: string }) {
  return (
    <Tag id={id} className={`tt${size ? ` tt--${size}` : ''} ${className}`.trim()}>
      <span>{line1}</span>
      <span className="tt__2">{line2}</span>
    </Tag>
  );
}

/** Eyebrow, two-tone heading and an optional line, with an optional action (a link or button) on the right. */
export function SectionHead({
  id,
  label,
  line1,
  line2,
  lead,
  center = false,
  action,
  children,
}: {
  id: string;
  label: string;
  line1: ReactNode;
  line2: ReactNode;
  lead?: ReactNode;
  center?: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={`shead${center ? ' shead--center' : ''}`} data-reveal>
      <div className={action ? 'shead__row' : undefined}>
        <div>
          <Eyebrow>{label}</Eyebrow>
          <TwoTone id={id} line1={line1} line2={line2} className="shead__title" />
          {lead && <p className="lead shead__lead">{lead}</p>}
        </div>
        {action}
      </div>
      {children}
    </header>
  );
}

/** The opening block of an inner page: eyebrow, two-tone heading, an optional line. With `art`, a picture sits beside the words. */
export function PageHero({ label, line1, line2, lead, ghost, art, children }: { label: string; line1: ReactNode; line2: ReactNode; lead?: ReactNode; ghost?: string; art?: ReactNode; children?: ReactNode }) {
  const words = (
    <>
      <Eyebrow>{label}</Eyebrow>
      <TwoTone as="h1" line1={line1} line2={line2} className="phero__title" />
      {lead && <p className="lead phero__lead">{lead}</p>}
      {children}
    </>
  );
  return (
    <section className="phero section--plain">
      {ghost && (
        <span className="ghost" aria-hidden="true">
          {ghost}
        </span>
      )}
      {art ? (
        <div className="container phero-split">
          <div className="phero__inner">{words}</div>
          {art}
        </div>
      ) : (
        <div className="container phero__inner">{words}</div>
      )}
    </section>
  );
}
