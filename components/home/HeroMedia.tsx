import Image from 'next/image';
import { FrameBar } from '@/components/ui';
import { heroMedia } from '@/lib/content';
import HeroVideo from './HeroVideo';

/*
 * The hero's visual slot: a browser frame holding one fixed 16:9 box (.hmedia__slot), so whatever fills it never
 * changes its size and nothing shifts. It supports the headline; it does not lead the page. heroMedia in
 * lib/content.ts picks the fill:
 *   'stage' : one screenshot, framed (the copy of a real site), with a one-line figure under it
 *   'video' : the poster frame, which is always rendered and is the LCP image (priority, sized to the slot), with
 *             HeroVideo laid over it on wide screens once the page has loaded
 */
export default function HeroMedia() {
  const m = heroMedia;
  const isVideo = m.type === 'video' && Boolean(m.mp4);
  const image = isVideo ? m.poster : m.stage.image;
  const alt = isVideo ? m.alt : m.stage.alt;

  return (
    <figure className="hmedia">
      <div className="frame hmedia__frame">
        <FrameBar addr={m.stage.site} />
        <div className="hmedia__slot">
          <Image src={image} alt={alt} fill fetchPriority="high" loading="eager" sizes="(min-width: 1000px) 540px, calc(100vw - 40px)" className="hmedia__fill" />
          {isVideo && <HeroVideo />}
        </div>
      </div>
      {!isVideo && <figcaption className="hmedia__cap">{m.stage.caption}</figcaption>}
    </figure>
  );
}
