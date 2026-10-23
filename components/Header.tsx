'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Menu, X } from 'lucide-react';
import Logo from './Logo';
import { ButtonLink } from '@/components/ui';
import { NAV } from '@/lib/site';

const PILL_BASE = 100; // px width the nav pill is drawn at; it is scaled to each link

export default function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Mobile menu: focus the first link, close on Escape (focus back on the button), lock page scroll.
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuBtn.current?.focus();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // One soft pill glides between nav links, following the hovered or focused one (transform only).
  const movePill = (a: HTMLElement) => {
    const n = nav.current;
    if (!n) return;
    n.style.setProperty('--pill-x', `${a.offsetLeft}px`);
    n.style.setProperty('--pill-s', String(a.offsetWidth / PILL_BASE));
    n.dataset.pill = n.dataset.pill ? 'move' : 'show';
  };
  const hidePill = () => {
    if (nav.current) delete nav.current.dataset.pill;
  };

  const current = (href: string) => (pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined);

  return (
    <header className="header" data-scrolled={scrolled || open}>
      <div className="container header__inner">
        <Link href="/" className="header__brand" aria-label="Remastly home">
          <Logo />
        </Link>

        <nav
          ref={nav}
          className="header__nav"
          aria-label="Main"
          onMouseLeave={hidePill}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) hidePill();
          }}
        >
          <span className="header__pill" aria-hidden="true" />
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current(item.href)}
              onMouseEnter={(e) => movePill(e.currentTarget)}
              onFocus={(e) => movePill(e.currentTarget)}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="header__actions">
          <ButtonLink href="/auth?mode=signup" size="sm" arrow>
            Get started
          </ButtonLink>
        </div>

        <button
          ref={menuBtn}
          type="button"
          className="header__menu-btn"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </div>

      <div ref={panel} id="mobile-nav" className="mobile-nav" hidden={!open}>
        <nav aria-label="Mobile">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} aria-current={current(item.href)} onClick={() => setOpen(false)}>
              {item.label}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          ))}
        </nav>
        <div className="mobile-nav__actions">
          <ButtonLink href="/auth?mode=signup" block arrow onClick={() => setOpen(false)}>
            Get started
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}
