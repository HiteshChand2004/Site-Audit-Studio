import { Bot, Gauge, ListChecks, Search, ShieldCheck, Users } from 'lucide-react';
import { CheckArt } from '../common/Illustrations.jsx';
import { hostOf } from '../../constants.js';
import { AEO, HEALTH } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './NotChecked.module.css';

// What a check reports, in the words the report itself uses (no numbers: nothing has been measured yet).
const PARTS = [
  { icon: Gauge, title: HEALTH.performance.title, text: HEALTH.performance.question },
  { icon: Search, title: HEALTH.seo.title, text: HEALTH.seo.question },
  { icon: Users, title: HEALTH.accessibility.title, text: HEALTH.accessibility.question },
  { icon: ShieldCheck, title: HEALTH['best-practices'].title, text: HEALTH['best-practices'].question },
  { icon: Bot, title: AEO.title, text: 'Can AI assistants quote it correctly?' },
  { icon: ListChecks, title: 'What needs fixing', text: 'Every problem found, most important first, with how to fix it.' },
];

/** The Check step of a website that has never been checked: what the check does and what its report will show. */
export default function NotChecked({ project, pages }) {
  const reads = project.page_url ? 'reads that one page' : `reads up to ${plural(pages, 'page')}`;
  return (
    <section className={styles.wrap} aria-labelledby="not-checked-title">
      <div className={styles.head}>
        <CheckArt className={styles.art} />
        <div className={styles.headText}>
          <span className="eyebrow">Not checked yet</span>
          <h3 id="not-checked-title" className={styles.title}>
            No report for {hostOf(project.url)} yet
          </h3>
          <p className={styles.text}>
            Click “Check now” above. The check opens the site in a real browser, {reads} and measures how it loads on a phone and a
            computer. It takes a few minutes, and the site is only read, never changed.
          </p>
        </div>
      </div>
      <div className={styles.parts}>
        <span className="eyebrow">What the report will show</span>
        <ul>
          {PARTS.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <span className={styles.partIcon} aria-hidden="true">
                <Icon size={16} />
              </span>
              <span className={styles.partText}>
                <strong>{title}</strong>
                <span>{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
