import { useState } from 'react';
import { ChevronDown, Columns2 } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import Button from '../common/Button.jsx';
import { matchRating, TERMS } from '../../copy.js';
import { captureShot, copyShot } from '../../siteData.js';
import styles from './PageGallery.module.css';

const SHOWN = 6;

/** Every copied page as a pair of pictures (original, copy) with its match; a click opens it in Compare. */
export default function PageGallery({ projectId, result, onOpenPage }) {
  const [all, setAll] = useState(false);
  const fid = new Map((result.fidelity?.pages ?? []).map((p) => [p.outPath, p]));
  const pages = (result.pages ?? []).filter((p) => p.slug);
  if (!pages.length) return null;
  const shown = all ? pages : pages.slice(0, SHOWN);

  return (
    <Card
      icon={Columns2}
      title="Every page, original and copy"
      sub="The first screen of each page on a computer. Click a page to compare it closely."
      tip={TERMS.fidelity.explain}
    >
      <ul className={styles.grid}>
        {shown.map((p, i) => {
          const score = fid.get(p.outPath)?.score ?? null;
          const r = matchRating(score);
          const before = captureShot(projectId, result, p, 'desktop', 'fold');
          const after = copyShot(projectId, result, p);
          return (
            <li key={p.outPath} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
              <button type="button" className={styles.tile} onClick={() => onOpenPage?.(p.outPath)} aria-label={`Compare ${p.path}${score != null ? `, match ${score} of 100` : ''}`}>
                <span className={styles.pair}>
                  <span className={styles.shot} data-side="old">
                    {before && <img src={before} alt="" loading="lazy" decoding="async" />}
                  </span>
                  <span className={styles.shot} data-side="new">
                    {after && <img src={after} alt="" loading="lazy" decoding="async" />}
                  </span>
                </span>
                <span className={styles.meta}>
                  <span className={`${styles.path} mono`}>{p.path}</span>
                  {score != null && (
                    <span className={styles.score} data-tone={r.tone} title={r.label}>
                      {score}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {pages.length > SHOWN && (
        <div className={styles.more}>
          <Button size="sm" variant="ghost" icon={ChevronDown} aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer pages' : `Show all ${pages.length} pages`}
          </Button>
        </div>
      )}
    </Card>
  );
}
