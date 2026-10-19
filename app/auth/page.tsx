import type { Metadata } from 'next';
import AuthCard from '@/components/auth/AuthCard';
import AuthStage from '@/components/auth/AuthStage';

export const metadata: Metadata = { title: 'Get started', description: 'Sign in to Remastly, or create an account.', alternates: { canonical: '/auth' }, robots: { index: false } };

/** Full-screen sign in / sign up (phones, direct links, and the old /signin and /signup addresses). */
export default async function AuthPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { mode, site } = await searchParams;
  return (
    <AuthStage className="astage--page">
      <h1 className="visually-hidden">Sign in or create an account</h1>
      <AuthCard initialMode={mode === 'signin' ? 'signin' : 'signup'} site={typeof site === 'string' ? site : undefined} syncUrl />
    </AuthStage>
  );
}
