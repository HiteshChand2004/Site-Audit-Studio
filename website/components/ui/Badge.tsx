import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info' | 'ink';

export function Badge({ tone = 'neutral', className = '', children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={`badge${tone === 'neutral' ? '' : ` badge--${tone}`}${className ? ` ${className}` : ''}`}>{children}</span>;
}
