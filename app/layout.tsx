import type { Metadata, Viewport } from 'next';
import { Geist, Instrument_Serif } from 'next/font/google';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import RevealObserver from '@/components/RevealObserver';
import AuthDialog from '@/components/auth/AuthDialog';
import { InViewPlay, PointerEffects } from '@/components/ui';
import { DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';
import './theme.css';
import './site.css';
import './pages.css';
import './visuals.css';

// Two families only: a serif display face for headlines, a clean sans for everything else.
const display = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--font-display', display: 'swap' });
const sans = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Remastly', template: '%s · Remastly' },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en', url: '/', title: 'Remastly', description: DESCRIPTION },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = { themeColor: '#FAFAF7', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      <head>
        {/* Scroll reveals only hide content when JavaScript runs, so nothing stays invisible without it. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
        <RevealObserver />
        <PointerEffects />
        <InViewPlay />
        <AuthDialog />
      </body>
    </html>
  );
}
