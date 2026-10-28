'use client';

import { useEffect, useRef, useState } from 'react';
import { heroMedia } from '@/lib/content';

type Source = { src: string; type: string };

/**
 * The video branch of the hero slot. The poster (the real first frame, drawn by HeroMedia as the page's LCP image) is
 * always there; this component only lays a muted, looping, inline <video> over it once the page has loaded, so the video
 * can never compete with the LCP image. It requests nothing at all (no element is rendered) on a screen under 1000 px,
 * under reduced motion, or when the visitor has asked to save data: those visitors keep the poster. From 1200 px up the
 * WebM goes first, then the MP4; between 1000 and 1199 px the lighter 960 × 540 MP4 is used. The video fades in nothing:
 * its first frame is the poster, so it is shown the moment it plays, and it pauses while it is off screen.
 */
export default function HeroVideo() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const m = heroMedia;
    const wide = window.matchMedia('(min-width: 1000px)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (!wide.matches || reduce.matches || saveData || !m.mp4) return;

    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      const list: Source[] = [];
      if (window.innerWidth < 1200 && m.light) list.push({ src: m.light, type: 'video/mp4' });
      else {
        if (m.webm) list.push({ src: m.webm, type: 'video/webm' });
        list.push({ src: m.mp4!, type: 'video/mp4' });
      }
      setSources(list);
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const later = () => (idle ? idle(start, { timeout: 2500 }) : setTimeout(start, 600));
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener('load', later);
    };
  }, []);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onReduce = () => {
      if (reduce.matches) {
        el.pause();
        setPlaying(false);
      }
    };
    reduce.addEventListener('change', onReduce);
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !reduce.matches) el.play().catch(() => {});
      else el.pause();
    });
    io.observe(el);
    return () => {
      reduce.removeEventListener('change', onReduce);
      io.disconnect();
    };
  }, [sources]);

  if (!sources) return null;
  return (
    <video ref={video} className="hmedia__fill hmedia__video" data-playing={playing || undefined} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1} onPlaying={() => setPlaying(true)}>
      {sources.map((s) => (
        <source key={s.src} src={s.src} type={s.type} />
      ))}
    </video>
  );
}
