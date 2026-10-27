'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FrameBar } from '@/components/ui';
import { showRuns } from '@/lib/content';
import LighthouseReport from './LighthouseReport';

/*
 * The example runs (lib/content.ts showRuns): one framed screenshot of the copy on the left, the Lighthouse report of that
 * run on the right. Every few seconds the picture swipes left to the next site and the
 * dials change to that site's run (the track holds a copy of the first slide at its end, so the
 * swipe is always leftwards, then snaps back unseen). It keeps going by itself and stands still only while the visitor is
 * pointing at a ring of the report (hover, touch or focus), or when the picture is off screen, the tab is hidden, or the
 * visitor prefers reduced motion (then the dots move it by hand). Every number is exactly the stored one.
 */

const N = showRuns.length;
const SLIDES = [...showRuns, showRuns[0]];
const EVERY = 3800;
const HOLD_AFTER_TOUCH = 15000;

export default function ExampleRun() {
  const [index, setIndex] = useState(0);
  const [snap, setSnap] = useState(false); // no transition while the track jumps back from the copy of the first slide
  const [near, setNear] = useState(false); // the section has been close to the screen: load the other pictures
  const root = useRef<HTMLDivElement>(null);
  const hold = useRef({ hover: false, until: 0, visible: false, reduce: false });
  const slide = index % N;
  const run = showRuns[slide];

  const hovering = useCallback((on: boolean) => {
    hold.current.hover = on;
    hold.current.until = Math.max(hold.current.until, Date.now() + (on ? HOLD_AFTER_TOUCH : 1200));
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    hold.current.reduce = reduce.matches;
    const onReduce = () => (hold.current.reduce = reduce.matches);
    reduce.addEventListener('change', onReduce);
    const nearIo = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '400px 0px' });
    nearIo.observe(el);
    const visIo = new IntersectionObserver(([e]) => (hold.current.visible = e.isIntersecting));
    visIo.observe(el.querySelector('.xr__img') ?? el);
    const timer = window.setInterval(() => {
      const h = hold.current;
      if (h.reduce || h.hover || !h.visible || document.hidden || Date.now() < h.until) return;
      setIndex((i) => (i >= N ? i : i + 1));
    }, EVERY);
    return () => {
      reduce.removeEventListener('change', onReduce);
      nearIo.disconnect();
      visIo.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  // after the swipe onto the copy of the first slide, jump back to the real first slide without a transition
  const onEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform' || index < N) return;
    setSnap(true);
    setIndex(0);
    requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)));
  };

  const go = (i: number) => {
    hold.current.until = Date.now() + HOLD_AFTER_TOUCH;
    setIndex(i);
  };

  return (
    <div className="xr" data-reveal ref={root}>
      <p className="xr__tag">
        <strong>{run.site}</strong> · {run.pages} {run.pages === 1 ? 'page' : 'pages'}
      </p>

      <div className="xr__cmp">
        <figure className="xr__shot">
          <div className="frame">
            <FrameBar addr={run.site} />
            <div className="xr__img">
              <div className="xr__track" data-snap={snap || undefined} style={{ transform: `translateX(-${index * 100}%)` }} onTransitionEnd={onEnd}>
                {SLIDES.map((s, i) => (
                  <div key={`${s.site}-${i}`} className="xr__slide" aria-hidden={i % N !== slide || i >= N || undefined}>
                    <Image src={s.image} alt={`${s.alt}, ${s.caption.toLowerCase()}`} fill sizes="(min-width: 1000px) 600px, 100vw" loading={i === 0 ? 'lazy' : near ? 'eager' : 'lazy'} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <figcaption>{run.caption}. The copy looks the same on purpose; what changed is underneath.</figcaption>
          <div className="xr__dots" role="group" aria-label="Choose a site">
            {showRuns.map((s, i) => (
              <button key={s.site} type="button" className="xr__dot" aria-label={s.site} aria-current={i === slide || undefined} onClick={() => go(i)} />
            ))}
          </div>
        </figure>
        <LighthouseReport run={run} onHold={hovering} />
      </div>
    </div>
  );
}
