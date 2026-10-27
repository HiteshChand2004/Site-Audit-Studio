import LogoMark from './LogoMark';

/** The Remastly logo: the mark (its tallest bar takes the accent colour) and the name. `dark` is for dark bands. */
export default function Logo({ dark = false, className = '' }: { dark?: boolean; className?: string; priority?: boolean }) {
  return (
    <span className={`logo${dark ? ' logo--dark' : ''} ${className}`.trim()} aria-label="Remastly" role="img">
      <LogoMark size={30} />
      <span className="logo__name" aria-hidden="true">
        Remastly
      </span>
    </span>
  );
}
