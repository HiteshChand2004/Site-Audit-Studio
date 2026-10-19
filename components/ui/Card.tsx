import type { CSSProperties, ElementType, ReactNode } from 'react';

/**
 * White card with a soft border and shadow. `hover` adds the lift, the shadow layer and a glow that follows the
 * cursor (moved by PointerEffects); `pad` adds the default padding.
 */
export function Card({
  as: Tag = 'div',
  hover = false,
  pad = true,
  reveal = true,
  delay,
  className = '',
  children,
  ...rest
}: { as?: ElementType; hover?: boolean; pad?: boolean; reveal?: boolean; delay?: number; className?: string; children: ReactNode; id?: string; style?: CSSProperties }) {
  const style = { ...(delay ? { ['--d' as string]: `${delay}ms` } : {}), ...rest.style };
  return (
    <Tag {...rest} style={style} data-reveal={reveal || undefined} className={['card', pad && 'card--pad', hover && 'card--hover', className].filter(Boolean).join(' ')}>
      {hover && (
        <span className="card__glow" aria-hidden="true">
          <i />
        </span>
      )}
      {children}
    </Tag>
  );
}
