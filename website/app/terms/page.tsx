import LegalPage from '@/components/LegalPage';
import { LEGAL } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/terms', 'Terms', 'The terms for using Remastly.');

export default function Terms() {
  return <LegalPage label="Legal" line1="Terms" line2="of use." doc={LEGAL.terms} />;
}
