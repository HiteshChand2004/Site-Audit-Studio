import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk, Newsreader } from 'next/font/google';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import RevealObserver from '@/components/RevealObserver';
import ScrollManager from '@/components/ScrollManager';
import { InViewPlay, PointerEffects } from '@/components/ui';
import { ACCENT } from '@/lib/accent';
import { DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';
import './theme.css';
import './site.css';
import './pages.css';
import './home.css';
import './system.css';

// Two families only, the same as panscience.xyz: Newsreader (weight 500) for headlines, Hanken Grotesk for everything else.
const display = Newsreader({ subsets: ['latin'], weight: '500', variable: '--font-display', display: 'swap' });
const sans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken', display: 'swap' });

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
    <html lang="en" data-scroll-behavior="smooth" className={`${display.variable} ${sans.variable}`} style={{ ['--accent' as string]: ACCENT }} suppressHydrationWarning>
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
        <ScrollManager />
        <RevealObserver />
        <PointerEffects />
        <InViewPlay />
      </body>
    </html>
  );
}
