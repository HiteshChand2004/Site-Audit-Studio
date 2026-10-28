import { LOGO_COLORS, LOGO_DIM, LOGO_PLATED, PLATFORMS } from '@/lib/content';
import { kindSlug } from '@/lib/kind';
import PlatformsFilter from './PlatformsFilter';

/*
 * Input platforms, compact: every platform the audit recognises as marks set straight on the background (no boxes), in
 * two rows that drift sideways in opposite directions, edge to edge, in a seamless loop (each row is shown six times and
 * moves by exactly half its width). A row of kinds sits above: choosing one brings those marks forward and lets the others
 * recede (opacity and scale only). The rows pause on hover and while off screen (data-loop + InViewPlay); under reduced
 * motion they are static, wrapping rows. The repeated copies are hidden from assistive technology. Only platforms with a
 * detection rule in the tool are shown (lib/content.ts PLATFORMS). Logos are Simple Icons (CC0), in their own brand colours.
 *
 * This is a server component: the ~170 repeated marks are plain HTML and are never hydrated. Each mark carries its kind
 * as data-kind; the chosen kind is set on the wrapper by PlatformsFilter (the only client part), and CSS does the dimming.
 */
const COPIES = 6;

export default function Platforms() {
  const kinds = PLATFORMS.groups.map((g) => ({ label: g.label, slug: kindSlug(g.label) }));
  const all = PLATFORMS.groups.flatMap((g) => g.items.map((it) => ({ ...it, kind: kindSlug(g.label) })));
  const half = Math.ceil(all.length / 2);
  const rows = [all.slice(0, half), all.slice(half)];

  return (
    <PlatformsFilter kinds={kinds}>
      <div className="pm" data-loop>
        {rows.map((row, r) => (
          <div key={r} className="pm__row">
            <ul className={`pm__track${r === 1 ? ' pm__track--rev' : ''}`}>
              {Array.from({ length: COPIES }).flatMap((_, c) =>
                row.map((it) => (
                  <li
                    key={`${it.name}-${c}`}
                    className="mark"
                    aria-hidden={c > 0 || undefined}
                    data-kind={it.kind}
                    data-plate={LOGO_PLATED.includes(it.logo) || undefined}
                    data-copy={c > 0 || undefined}
                    style={{ ['--brand' as string]: LOGO_COLORS[it.logo], ['--w' as string]: LOGO_DIM[it.logo][0], ['--h' as string]: LOGO_DIM[it.logo][1] }}
                  >
                    <span className="mark__ico">
                      <svg aria-hidden="true">
                        <use href={`/platforms/sprite.svg#${it.logo}`} />
                      </svg>
                    </span>
                    <span>{it.name}</span>
                  </li>
                )),
              )}
            </ul>
          </div>
        ))}
      </div>
    </PlatformsFilter>
  );
}
