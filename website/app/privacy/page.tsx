import LegalPage from '@/components/LegalPage';
import { LEGAL } from '@/lib/content';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta('/privacy', 'Privacy', 'How Remastly handles personal data on this website and in the product.');

export default function Privacy() {
  return <LegalPage label="Legal" line1="Privacy" line2="policy." doc={LEGAL.privacy} />;
}
