import type { Metadata } from 'next';
import AuthCard from '@/components/auth/AuthCard';
import '@/app/authpage.css';

export const metadata: Metadata = { title: 'Get started', description: 'Sign in to Remastly, or create an account.', alternates: { canonical: '/auth' }, robots: { index: false } };

/** Sign in / sign up as a simple page: just the form, centred and laid out on the page (no card, no pictures). */
export default async function AuthPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { mode, site } = await searchParams;
  return (
    <section className="authpage">
      <div className="container authpage__form">
        <h1 className="visually-hidden">Sign in or create an account</h1>
        <AuthCard initialMode={mode === 'signin' ? 'signin' : 'signup'} site={typeof site === 'string' ? site : undefined} syncUrl plain />
      </div>
    </section>
  );
}
