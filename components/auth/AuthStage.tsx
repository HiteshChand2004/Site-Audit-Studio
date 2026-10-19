import type { ReactNode } from 'react';

/**
 * The cinematic light stage behind the auth card: slowly drifting aurora light (warm off-white with a faint touch
 * of Remastly orange; transform-only drift), a very subtle film grain and a soft vignette. Calm, never busy.
 */
export default function AuthStage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`astage ${className}`}>
      <div className="astage__bg" aria-hidden="true">
        <i className="astage__light astage__light--a" />
        <i className="astage__light astage__light--b" />
        <i className="astage__light astage__light--c" />
        <span className="astage__grain" />
        <span className="astage__vignette" />
      </div>
      <div className="astage__center">{children}</div>
    </div>
  );
}
