import Image from 'next/image';
import { TrendingDown } from 'lucide-react';
import { RESULT_IMAGES, resultCards } from '@/lib/content';

/*
 * Result cards, one per own site: favicon in the avatar slot, the measured result as the large line, more figures from
 * the same run, anything that went down, and a name line. The cards drift slowly sideways in a seamless loop (the list is
 * shown six times and the track moves by exactly half its width, so it is wider than any screen), edge to edge with soft fades at both ends. It pauses on
 * hover or keyboard focus and while off screen (data-loop + InViewPlay); under reduced motion it is a plain row you scroll
 * by hand. The second copy is hidden from assistive technology. No quotes anywhere: these are figures. Server-rendered.
 */
export default function ResultCards() {
  const set = resultCards.cards;
  const twice = [...set, ...set, ...set, ...set, ...set, ...set];
  return (
    <div className="rcm" data-loop role="region" aria-label={resultCards.label} tabIndex={0}>
      <ul className="rcm__track">
        {twice.map((c, i) => (
          <li key={`${c.site}-${i}`} className="rc__card" aria-hidden={i >= set.length || undefined}>
            <article>
              <div className="rc__banner" aria-hidden="true">
                {RESULT_IMAGES[c.icon] && <Image src={RESULT_IMAGES[c.icon]} alt="" fill sizes="270px" />}
              </div>
              <header className="rc__head">
                <span className="rc__avatar">
                  <Image src={`/favicons/${c.icon}.webp`} alt="" width={32} height={32} unoptimized />
                </span>
                <span className="rc__name">{c.site}</span>
              </header>
              <p className="rc__headline display">{c.headline}</p>
              <ul className="rc__figs">
                {c.figures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {c.wentDown && (
                <p className="rc__down">
                  <TrendingDown size={13} aria-hidden="true" /> <span>Went down: {c.wentDown}</span>
                </p>
              )}
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
