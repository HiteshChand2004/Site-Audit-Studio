import Image from 'next/image';
import '@/app/tour.css';

/**
 * A real screenshot of the Remastly app itself (public/tool, taken from the running app: the tool's own screens, not a
 * saved copy of any site), set in a soft frame. `w` and `h` are the file's pixel size. The files are 2x captures, so the
 * frame is at most half of `w` by default (`maxWidth` can set it smaller), so the picture never scales up and stays sharp. It is served as it is
 * (not re-encoded), since recompression blurs small interface text.
 */
export function ToolShot({ src, w, h, alt, caption, priority = false, className = '', maxWidth = w / 2 }: { src: string; w: number; h: number; alt: string; caption?: string; priority?: boolean; className?: string; maxWidth?: number }) {
  return (
    <figure className={`tshot ${className}`.trim()} style={{ maxWidth }}>
      <div className="tshot__frame">
        <Image src={src} width={w} height={h} alt={alt} unoptimized loading={priority ? 'eager' : 'lazy'} />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
