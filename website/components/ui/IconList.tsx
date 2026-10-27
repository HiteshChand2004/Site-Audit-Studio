import type { ComponentType, ReactNode } from 'react';

type Item = { Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>; title: ReactNode; text?: ReactNode };

/**
 * Open layout for features, checks and benefits: icon + short label (+ one line), separated by whitespace and
 * hairlines, never boxed. `rows` stacks them (optionally in 2 columns); `cols` puts them side by side.
 */
export function IconList({ items, layout = 'rows', columns = 1, className = '' }: { items: readonly Item[]; layout?: 'rows' | 'cols'; columns?: 1 | 2 | 3 | 4; className?: string }) {
  return (
    <ul className={`olist olist--${layout} olist--c${columns} ${className}`} data-reveal>
      {items.map(({ Icon, title, text }, i) => (
        <li key={i}>
          <span className="olist__ico" aria-hidden="true">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>{title}</strong>
            {text && <p>{text}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
