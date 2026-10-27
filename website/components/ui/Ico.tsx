import { Copy, Download, Flag, Gauge, Layers, Link2, ListChecks, ScanSearch, Wrench, type LucideProps } from 'lucide-react';

const ICONS = { scan: ScanSearch, copy: Copy, layers: Layers, link: Link2, wrench: Wrench, gauge: Gauge, flag: Flag, list: ListChecks, download: Download } as const;
export type IcoName = keyof typeof ICONS;

/** One of the site's small set of icons, by name (content files refer to icons by name). */
export function Ico({ name, ...rest }: { name: IcoName } & LucideProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" {...rest} />;
}
