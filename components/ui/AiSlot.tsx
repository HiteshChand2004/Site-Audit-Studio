import fs from 'node:fs';
import path from 'node:path';
import Image from 'next/image';

/**
 * A place for an AI-generated image (see docs/image-prompts.md). The slot has a fixed aspect ratio and a neutral fill.
 * When the file exists in /public it is drawn inside the slot; until then the slot stays empty. Either way the slot's
 * size is the same, so dropping the file in moves nothing.
 */
export function AiSlot({ src, ratio, alt, sizes, className = '' }: { src: string; ratio: string; alt: string; sizes: string; className?: string }) {
  const has = fs.existsSync(path.join(process.cwd(), 'public', src));
  return (
    <div className={`aislot ${className}`.trim()} style={{ aspectRatio: ratio }} role={has ? undefined : 'presentation'}>
      {has && <Image src={src} alt={alt} fill sizes={sizes} />}
    </div>
  );
}
