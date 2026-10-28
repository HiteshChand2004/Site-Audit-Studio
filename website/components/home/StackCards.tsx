import { Fragment } from 'react';
import { Download, Terminal } from 'lucide-react';
import { LOGO_COLORS, LOGO_DIM, LOGO_PLATED, STACK_CARDS } from '@/lib/content';

/*
 * The four output stacks as four plain columns (no boxes): the stack's marks set on the background, its name and one
 * line, the top of its real download and the command that runs it. The columns rise in one after another on scroll and
 * each file name appears line by line (CSS, played once). Marks are muted until hovered, then take their brand colour.
 * Each command of the run line stays on one line. Under the columns, the plain-words limits of the generated stacks.
 */
export default function StackCards() {
  return (
    <>
      <ul className="stk" data-stagger>
        {STACK_CARDS.items.map((s) => (
          <li key={s.id} className="stk__col">
            <ul className="marks marks--stack" aria-label={s.logos.map((l) => l.name).join(', ')}>
              {s.logos.map((l) => (
                <li key={l.logo} className="mark" data-plate={LOGO_PLATED.includes(l.logo) || undefined} style={{ ['--brand' as string]: LOGO_COLORS[l.logo], ['--w' as string]: LOGO_DIM[l.logo][0], ['--h' as string]: LOGO_DIM[l.logo][1] }}>
                  <span className="mark__ico">
                    <svg aria-hidden="true">
                      <use href={`/platforms/sprite.svg#${l.logo}`} />
                    </svg>
                  </span>
                </li>
              ))}
            </ul>
            <h3 className="stk__name">{s.name}</h3>
            <p className="stk__tag">{s.tag}</p>
            <ul className="stk__tree">
              {s.tree.map((t, j) => (
                <li key={t} style={{ ['--j' as string]: j }}>
                  {t}
                </li>
              ))}
            </ul>
            <p className="stk__run">
              <Terminal size={13} aria-hidden="true" />{' '}
              <code>
                {s.run.split(' · ').map((c, k, all) => (
                  <Fragment key={c}>
                    <span>{k < all.length - 1 ? `${c} ·` : c}</span>
                    {k < all.length - 1 && ' '}
                  </Fragment>
                ))}
              </code>
            </p>
            <p className="stk__zip">
              <Download size={14} aria-hidden="true" /> <span>your-site-{s.id}.zip</span>
            </p>
          </li>
        ))}
      </ul>
      <ul className="stk__limits">
        {STACK_CARDS.limits.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
}
