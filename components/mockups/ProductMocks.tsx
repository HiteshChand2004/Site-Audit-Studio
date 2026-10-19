import SiteMock from '@/components/home/SiteMock';
import { EXAMPLE_RUN } from '@/lib/content';

/* The two A4 pages of the shareable report, built in HTML/CSS (used on /report only). */

function Ring({ value, label, tone }: { value: string; label: string; tone: 'old' | 'new' }) {
  const n = parseInt(value, 10);
  const c = 2 * Math.PI * 42;
  return (
    <div className={`rp-ring rp-ring--${tone}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="42" className="rp-ring__track" />
        <circle cx="50" cy="50" r="42" className="rp-ring__arc" strokeDasharray={c} strokeDashoffset={c * (1 - n / 100)} />
      </svg>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/** The two A4 pages of the Full report. Only the example run's numbers are shown; the rest is skeleton. */
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
          <Ring value={String(EXAMPLE_RUN.lighthouseOriginal)} label="Original" tone="old" />
          <Ring value={EXAMPLE_RUN.lighthouseCopy} label="Copy" tone="new" />
        </div>
        <p className="rp__caption">Lighthouse · example run on {EXAMPLE_RUN.site}</p>
        <div className="rp__tiles">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="rp__shots">
          <SiteMock />
          <SiteMock />
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
