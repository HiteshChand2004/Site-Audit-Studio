/** A four-point sparkle, drawn here: the separator between marquee items. */
export function Sparkle() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2C12.8 7.5 16.5 11.2 22 12C16.5 12.8 12.8 16.5 12 22C11.2 16.5 7.5 12.8 2 12C7.5 11.2 11.2 7.5 12 2Z" />
    </svg>
  );
}

/**
 * A full-width band in the accent colour with white text that scrolls slowly and loops seamlessly (the list is shown
 * twice, the track moves by exactly half its width). The second copy is hidden from assistive technology. Under reduced
 * motion it stands still and wraps. The band clips its own overflow, so it never causes a horizontal scroll.
 */
export function Marquee({ items, label }: { items: readonly string[]; label: string }) {
  const twice = [...items, ...items];
  return (
    <div className="mq" role="region" aria-label={label}>
      <div className="mq__track" data-loop>
        {twice.map((t, i) => (
          <span key={`${t}-${i}`} className="mq__item" aria-hidden={i >= items.length || undefined}>
            {t}
            <Sparkle />
          </span>
        ))}
      </div>
    </div>
  );
}
