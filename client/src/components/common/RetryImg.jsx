import { useEffect, useRef, useState } from 'react';

/**
 * An image the server may still be making (a picture of an as-is copy's page is taken on first request and answered "ask
 * again" meanwhile): on an error it asks again every `delay` ms, up to `tries` times, then calls `onGiveUp`. While it waits
 * it is hidden, so the browser's broken-image mark never shows; the box around it shows its own placeholder.
 */
export default function RetryImg({ src, tries = 36, delay = 5000, onGiveUp, onLoad, style, ...rest }) {
  const [n, setN] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    setN(0);
    setWaiting(false);
    return () => clearTimeout(timer.current);
  }, [src]);
  const url = n ? `${src}${src.includes('?') ? '&' : '?'}try=${n}` : src;
  const onError = () => {
    setWaiting(true);
    if (n >= tries) {
      onGiveUp?.();
      return;
    }
    timer.current = setTimeout(() => setN((x) => x + 1), delay);
  };
  return (
    <img
      {...rest}
      src={url}
      style={waiting ? { ...style, visibility: 'hidden' } : style}
      onLoad={(e) => {
        setWaiting(false);
        onLoad?.(e);
      }}
      onError={onError}
    />
  );
}
