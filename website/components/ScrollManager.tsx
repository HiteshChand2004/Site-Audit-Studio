'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/*
 * Where a page opens after a link is followed. Next.js keeps the scroll position when the new page is already in
 * view, so a click from halfway down one page used to open the next page halfway down. Here:
 * - a link to another page opens it at the top (its hero);
 * - a link with a #section (e.g. "Check my site" to /#check) opens that section;
 * - Back and Forward keep the browser's own restored position.
 * The jump is instant; smooth scrolling stays for links within the same page.
 */
export default function ScrollManager() {
  const pathname = usePathname();
  const popped = useRef(false);
  const first = useRef(true);

  useEffect(() => {
    const onPop = () => {
      popped.current = true;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false; // a fresh load: the browser handles it (top, or the #section in the address)
      return;
    }
    if (popped.current) {
      popped.current = false;
      return;
    }
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
    else window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname]);

  return null;
}
