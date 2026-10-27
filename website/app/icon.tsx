import { ImageResponse } from 'next/og';
import { ACCENT } from '@/lib/accent';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/** The favicon: the Remastly mark, its tallest bar in the accent colour (lib/accent.ts). */
export default function Icon() {
  const bar = (left: number, top: number, w: number, h: number, color: string) => <div style={{ position: 'absolute', left, top, width: w, height: h, borderRadius: w / 2, background: color }} />;
  return new ImageResponse(
    (
      <div style={{ display: 'flex', position: 'relative', width: 32, height: 32, borderRadius: 8, background: '#111111' }}>
        {bar(7, 16, 3.2, 9, '#f3f0ea')}
        {bar(12.2, 11, 3.2, 14, '#f3f0ea')}
        {bar(17.4, 14, 3.2, 11, '#f3f0ea')}
        {bar(22.6, 6, 3.4, 19, ACCENT)}
      </div>
    ),
    size,
  );
}
