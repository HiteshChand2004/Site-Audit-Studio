import Link from 'next/link';
import { MessageCircle, Plus } from 'lucide-react';
import { ButtonLink } from './Button';

export type FaqEntry = { q: string; a: string };

/**
 * The FAQ: an accordion on the left (native <details>, one open at a time through the shared name, the open item filled
 * with the accent colour) and two small support cards on the right. Works without JavaScript.
 */
export function FaqPanel({ items, name = 'faq', side = true }: { items: readonly FaqEntry[]; name?: string; side?: boolean }) {
  return (
    <div className="acc2" data-reveal>
      <div className="acc2__list">
        {items.map((f, i) => (
          <details key={f.q} name={name} open={i === 0}>
            <summary>
              {f.q}
              <Plus size={20} aria-hidden="true" />
            </summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
      {side && (
        <aside className="acc2__side">
          <div className="scard scard--dark">
            <MessageCircle size={26} aria-hidden="true" />
            <h3>Something not covered here?</h3>
            <p>Tell us what you want to rebuild and we will point you to the right plan.</p>
            <ButtonLink href="/contact" size="sm">
              Contact us
            </ButtonLink>
          </div>
          <div className="scard">
            <h3>Read every answer</h3>
            <p>The full list covers limits, formats, timing and hosting.</p>
            <Link href="/faq" className="link-arrow">
              All questions
            </Link>
          </div>
        </aside>
      )}
    </div>
  );
}
