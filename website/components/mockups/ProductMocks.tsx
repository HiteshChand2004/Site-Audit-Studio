import Image from 'next/image';
import { exampleRun, exampleScores } from '@/lib/content';
import '@/app/visuals.css';

/* The two A4 pages of the shareable report, built in HTML/CSS (used on /report only). */

function Ring({ value, label, tone }: { value: number | null; label: string; tone: 'old' | 'new' }) {
  const n = value ?? 0; // no verified example run: an empty ring and a dash
  const c = 2 * Math.PI * 42;
  return (
    <div className={`rp-ring rp-ring--${tone}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="42" className="rp-ring__track" />
        <circle cx="50" cy="50" r="42" className="rp-ring__arc" strokeDasharray={c} strokeDashoffset={c * (1 - n / 100)} />
      </svg>
      <strong>{value ?? '–'}</strong>
      <span>{label}</span>
    </div>
  );
}

/** The two A4 pages of the Full report. Only the example run's numbers (exampleRun) are shown; the rest is skeleton. */
export function ReportPagesMock() {
  return (
    <div className="viz rp" aria-hidden="true">
      <div className="rp__page">
        <div className="rp__head">
          <strong>Full report</strong>
          <span>Page 1 · The answer</span>
        </div>
        <span className="rp__line rp__line--lg" />
        <span className="rp__line" />
        <div className="rp__rings">
          <Ring value={exampleScores?.from ?? null} label="Original" tone="old" />
          <Ring value={exampleScores?.to ?? null} label="Copy" tone="new" />
        </div>
        <p className="rp__caption">{exampleScores ? `Lighthouse performance, phone · example run on ${exampleRun.site}` : 'Lighthouse'}</p>
        <div className="rp__tiles">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="rp__shots">
          <Image src="/shots/collateral-original.webp" alt="" width={1000} height={625} sizes="160px" />
          <Image src="/shots/collateral-copy.webp" alt="" width={1000} height={625} sizes="160px" />
        </div>
      </div>
      <div className="rp__page rp__page--2">
        <div className="rp__head">
          <strong>Full report</strong>
          <span>Page 2 · The numbers</span>
        </div>
        <div className="rp__bars">
          {[72, 88, 64, 94, 80].map((w, i) => (
            <span key={i} style={{ ['--w' as string]: `${w}%` }} />
          ))}
        </div>
        <div className="rp__donut" />
        <div className="rp__table">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
