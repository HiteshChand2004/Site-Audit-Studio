import { Plus } from 'lucide-react';

export type FaqItem = { q: string; a: string };

/** Native <details> accordion: keyboard accessible and works without JavaScript. */
export function FaqList({ items, openFirst = false }: { items: readonly FaqItem[]; openFirst?: boolean }) {
  return (
    <div className="faq">
      {items.map((f, i) => (
        <details key={f.q} open={openFirst && i === 0}>
          <summary>
            {f.q}
            <Plus size={20} aria-hidden="true" />
          </summary>
          <p className="faq__answer">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
