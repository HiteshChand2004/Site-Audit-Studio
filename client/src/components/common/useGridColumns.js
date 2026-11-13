import { useLayoutEffect, useState } from 'react';
import { columnsOf } from '../../gridRows.js';

/**
 * Columns of the CSS grid in `ref`, kept up to date when its width changes (window resize, the sidebar folding).
 * @param {{ current: Element | null }} ref
 * @param {boolean} [mounted]  whether the grid is drawn now (a component that draws it only sometimes measures it when it appears)
 * @param {number} [initial]  until the grid is measured
 */
export function useGridColumns(ref, mounted = true, initial = 3) {
  const [columns, setColumns] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setColumns(columnsOf(el));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, mounted]);
  return columns;
}
