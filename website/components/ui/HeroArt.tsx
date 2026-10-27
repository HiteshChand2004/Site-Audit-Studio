import Image from 'next/image';
import type { ReactNode } from 'react';
import '@/app/hero-art.css';

/*
 * The picture beside an inner page's heading (PageHero `art`): a main piece, an optional smaller one overlapping its
 * lower-left corner, and a soft accent glow behind both. The same arrangement as the Features hero.
 */
export function HeroArt({ main, overlay, className = '' }: { main: ReactNode; overlay?: ReactNode; className?: string }) {
  return (
    <div className={`hart ${className}`.trim()} aria-hidden="true">
      <span className="hart__glow" />
      <div className="hart__main">{main}</div>
      {overlay && <div className="hart__over">{overlay}</div>}
    </div>
  );
}

/*
 * A framed picture: an optional window bar with a label, then the image. `zoom` shows the left part of a wide screen larger.
 * `priority` is for the main piece of a page hero: it is above the fold on every screen, so it is fetched at once and
 * preloaded instead of lazy-loaded (next/image's default), which otherwise delays the largest paint on a phone.
 */
export function HeroShot({ src, w, h, bar, chip, zoom, height, trim, priority = false }: { src: string; w: number; h: number; bar?: string; chip?: ReactNode; zoom?: number; height?: number; trim?: boolean; priority?: boolean }) {
  return (
    <figure className={`hshot${trim ? ' hshot--trim' : ''}`}>
      {bar && (
        <figcaption className="hshot__bar">
          <span className="hshot__dots">
            <i />
            <i />
            <i />
          </span>
          <span>{bar}</span>
          {chip}
        </figcaption>
      )}
      <div className="hshot__img" style={height ? { height } : undefined}>
        <Image src={src} width={w} height={h} alt="" unoptimized priority={priority} style={zoom ? { width: `${zoom * 100}%`, maxWidth: 'none' } : undefined} />
      </div>
    </figure>
  );
}
