import Image from 'next/image';
import logo from '@/public/logo.png';
import logoDark from '@/public/logo-dark.png';

/** The Remastly logo: black brand name on light backgrounds, off-white on dark ones. */
export default function Logo({ dark = false, className, priority = false }: { dark?: boolean; className?: string; priority?: boolean }) {
  return <Image src={dark ? logoDark : logo} alt="Remastly" className={className} priority={priority} sizes="180px" />;
}
