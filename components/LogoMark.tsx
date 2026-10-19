/** The Remastly mark (same drawing as app/icon.svg), inline so it stays crisp at any size. */
export default function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#111" />
      <rect x="7" y="16" width="3.2" height="9" rx="1.6" fill="#f3f0ea" />
      <rect x="12.2" y="11" width="3.2" height="14" rx="1.6" fill="#f3f0ea" />
      <rect x="17.4" y="14" width="3.2" height="11" rx="1.6" fill="#f3f0ea" />
      <rect x="22.6" y="6" width="3.4" height="19" rx="1.7" fill="#f97316" />
    </svg>
  );
}
