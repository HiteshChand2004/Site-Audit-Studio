import Image from 'next/image';
import { Eyebrow, TwoTone } from '@/components/ui';
import { HEADS, ownSites } from '@/lib/content';

/*
 * The own-sites band: a heading, one line that says what these marks are (our own sites, rebuilt with this tool, never
 * customers) with the real count from the tool's database, and the strip: each site's stored favicon in its own colours,
 * drifting slowly and looping seamlessly (the list is shown twice and the track moves by exactly half its width).
 * Pauses on hover and while off screen (data-loop + InViewPlay); a static, wrapping row under reduced motion. The second
 * copy of the list is hidden from assistive technology, so each site is announced once.
 */
export default function LogoStrip() {
  const twice = [...ownSites.logos, ...ownSites.logos];
  return (
    <section className="section section--plain logos" aria-labelledby="sites-title">
      <div className="container logos__head" data-reveal data-dir="near">
        <Eyebrow>{HEADS.sites.eyebrow}</Eyebrow>
        <TwoTone id="sites-title" line1={HEADS.sites.l1} line2={HEADS.sites.l2} className="logos__title" />
        <p className="logos__line">
          {ownSites.line} <strong>{ownSites.countLine}</strong>
        </p>
      </div>
      <div className="logos__view">
        <ul className="logos__track" data-loop>
          {twice.map((l, i) => (
            <li key={`${l.file}-${i}`} className="logos__item" aria-hidden={i >= ownSites.logos.length || undefined}>
              <Image src={`/favicons/${l.file}.webp`} alt="" width={40} height={40} unoptimized />
              <span>{l.site}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
