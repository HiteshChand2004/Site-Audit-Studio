'use client';

import { useState, type ReactNode } from 'react';

/**
 * The only interactive part of the Input platforms section: the row of kinds. The chosen kind goes on the wrapper as
 * data-kind, and CSS (system.css, ".plat[data-kind=…]") lets the marks of every other kind recede. The marks themselves
 * are rendered on the server (Platforms.tsx) and passed in as children, so the ~170 repeated items are never hydrated.
 */
export default function PlatformsFilter({ kinds, children }: { kinds: { label: string; slug: string }[]; children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="plat" data-kind={active ?? undefined}>
      <div className="plat__kinds" role="group" aria-label="Kinds of site">
        <button type="button" aria-pressed={active === null} onClick={() => setActive(null)}>
          All
        </button>
        {kinds.map((k) => (
          <button key={k.slug} type="button" aria-pressed={active === k.slug} onClick={() => setActive(active === k.slug ? null : k.slug)}>
            {k.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
