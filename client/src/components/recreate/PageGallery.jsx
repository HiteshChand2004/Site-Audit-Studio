import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Columns2 } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import Button from '../common/Button.jsx';
import { matchRating, TERMS } from '../../copy.js';
import { captureShot, copyShot } from '../../siteData.js';
import { fidelityPages } from '../../fidelity.js';
import RetryImg from '../common/RetryImg.jsx';
import { useGridColumns } from '../common/useGridColumns.js';
import { FIRST_ROWS, ROWS_PER_CLICK, hasMore, shownCount } from '../../gridRows.js';
import styles from './PageGallery.module.css';

/**
 * Every copied page as a pair of pictures (original, copy) with its match; a click opens it in Compare. Whole rows only: the
 * number of cards follows the columns the grid has at this width (gridRows.js), so no row is left half empty.
 */
export default function PageGallery({ projectId, result, onOpenPage }) {
  const gridRef = useRef(null);
  // Rows shown, not cards: when the window is resized the grid still ends on a full row.
  const [rows, setRows] = useState(FIRST_ROWS);
  const fid = new Map(fidelityPages(result).map((p) => [p.outPath, p]));
  const pages = (result.pages ?? []).filter((p) => p.slug);
  const columns = useGridColumns(gridRef, pages.length > 0);
  if (!pages.length) return null;
  const total = pages.length;
  const more = hasMore({ total, columns, rows });
  const cut = hasMore({ total, columns, rows: FIRST_ROWS });
  const shown = pages.slice(0, shownCount({ total, columns, rows }));
  const left = total - shown.length;

  return (
    <Card
      icon={Columns2}
      title="Every page, original and copy"
      sub="The first screen of each page on a computer. Click a page to compare it closely."
      tip={TERMS.fidelity.explain}
    >
      <ul className={styles.grid} ref={gridRef}>
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
                    {/* An as-is copy's picture is made on first request: asked again until it is there. */}
                    {after && <RetryImg src={after} alt="" loading="lazy" decoding="async" />}
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
      {/* No button when every page fits in the first rows; each "Show more" adds whole rows; "Show fewer" once all are out. */}
      {cut && (
        <div className={styles.more}>
          {more ? (
            <Button size="sm" variant="ghost" icon={ChevronDown} aria-expanded={false} onClick={() => setRows((r) => r + ROWS_PER_CLICK)}>
              {`Show more pages (${left} more)`}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={ChevronUp} aria-expanded onClick={() => setRows(FIRST_ROWS)}>
              Show fewer pages
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
