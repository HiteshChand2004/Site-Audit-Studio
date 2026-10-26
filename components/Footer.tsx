import Link from 'next/link';
import Logo from './Logo';
import { FOOTER_NAV, TAGLINE } from '@/lib/site';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__brand">
            <Link href="/" aria-label="Remastly home" className="header__brand">
              <Logo />
            </Link>
            <p className="display footer__tagline">{TAGLINE}</p>
          </div>
          {FOOTER_NAV.map((col) => (
            <nav key={col.title} aria-labelledby={`footer-${col.title}`}>
              <h2 id={`footer-${col.title}`} className="footer__title">
                {col.title}
              </h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="footer__bottom">
          <span>© {new Date().getFullYear()} Remastly. For websites your company owns or may use.</span>
        </div>
      </div>
    </footer>
  );
}
