import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const cls = (variant: Variant, size: Size, block?: boolean, extra?: string) =>
  ['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', extra].filter(Boolean).join(' ');

type Common = { variant?: Variant; size?: Size; block?: boolean; arrow?: boolean; children: ReactNode };

/** Effect layers of every button: the sheen band and the soft fill (see .btn__fx in theme.css). */
const Fx = () => <span className="btn__fx" aria-hidden="true" />;

/** A link styled as a button. `arrow` adds a trailing arrow that nudges on hover. */
export function ButtonLink({ variant = 'primary', size = 'md', block, arrow, className, children, ...rest }: Common & Omit<ComponentProps<typeof Link>, 'children'>) {
  return (
    <Link className={cls(variant, size, block, className)} {...rest}>
      <Fx />
      {children}
      {arrow && <ArrowRight size={size === 'sm' ? 15 : 17} className="nudge" aria-hidden="true" />}
    </Link>
  );
}

export function Button({ variant = 'primary', size = 'md', block, arrow, className, children, type = 'button', ...rest }: Common & Omit<ComponentProps<'button'>, 'children'>) {
  return (
    <button type={type} className={cls(variant, size, block, className)} {...rest}>
      <Fx />
      {children}
      {arrow && <ArrowRight size={size === 'sm' ? 15 : 17} className="nudge" aria-hidden="true" />}
    </button>
  );
}
