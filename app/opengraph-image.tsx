import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'Remastly: your site, rebuilt better';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  const logo = await readFile(path.join(process.cwd(), 'public', 'logo.png'));
  const src = `data:image/png;base64,${logo.toString('base64')}`;
  const pills = ['HTML', 'React + Vite', 'Next.js', 'MERN'];
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          background: 'radial-gradient(60% 90% at 50% 0%, rgba(194,65,12,0.12), transparent 60%), #fafaf7',
          color: '#111111',
          fontFamily: 'sans-serif',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} width={364} height={64} alt="" />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 84, fontFamily: 'serif', letterSpacing: -2, lineHeight: 1.02 }}>Your site, rebuilt</div>
          <div style={{ fontSize: 84, fontFamily: 'serif', fontStyle: 'italic', letterSpacing: -2, lineHeight: 1.02, color: '#c2410c' }}>better.</div>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {pills.map((p, i) => (
            <div key={p} style={{ display: 'flex', padding: '10px 22px', borderRadius: 999, border: '2px solid #e8e6e0', background: i === 2 ? '#111111' : '#ffffff', color: i === 2 ? '#ffffff' : '#3d3c38', fontSize: 26 }}>
              {p}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
