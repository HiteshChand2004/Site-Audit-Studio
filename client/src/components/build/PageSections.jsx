import { Trash2, Undo2 } from 'lucide-react';
import Button from '../common/Button.jsx';
import form from '../common/Form.module.css';
import styles from './PageSections.module.css';

// The pages of a plan with the words written for each section, editable in place on the Review step: a section's name and
// text can be changed and a section removed (every page keeps at least one). The edits are the brief that is built; the
// server checks them again (server/src/buildmode/compose.js checkBrief, which these limits mirror).
export const MAX_SECTION_NAME = 200;
export const MAX_SECTION_TEXT = 6000;

const sameSections = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** The first section left without a name or text, as { page, index }, or null. */
export function emptySection(pages) {
  for (const page of pages ?? []) {
    const index = (page.sections ?? []).findIndex((s) => !s.name.trim() || !s.content.trim());
    if (index >= 0) return { page, index };
  }
  return null;
}

/**
 * pages: the brief's pages as edited; original: the plan's own pages (to put a page's text back); nameOf: a page's name for
 * the owner; onChange: the edited pages.
 */
export default function PageSections({ pages, original, nameOf, onChange }) {
  const setSections = (path, sections) => onChange(pages.map((p) => (p.path === path ? { ...p, sections } : p)));

  return (
    <div className={styles.pages}>
      {pages.map((p) => {
        const sections = p.sections ?? [];
        const plan = original?.find((o) => o.path === p.path);
        const changed = plan && !sameSections(plan.sections, sections);
        const name = nameOf(p.path);
        const edit = (i, part) => setSections(p.path, sections.map((s, j) => (j === i ? { ...s, ...part } : s)));
        return (
          <details key={p.path} className={styles.page} open={sections.some((s) => !s.name.trim() || !s.content.trim()) || undefined}>
            <summary>
              <strong>{name}</strong>
              <span className={styles.meta}>{p.purpose}</span>
              {changed && <span className={styles.edited}>Edited</span>}
            </summary>
            <ol className={styles.sections}>
              {sections.map((s, i) => (
                // Sections have no id of their own and their name is editable, so they are keyed by place.
                <li key={i} className={styles.section}>
                  <div className={styles.sectionHead}>
                    <span className={styles.num} aria-hidden="true">{i + 1}</span>
                    <input
                      className={`${form.input} ${styles.name}`}
                      value={s.name}
                      maxLength={MAX_SECTION_NAME}
                      onChange={(e) => edit(i, { name: e.target.value })}
                      aria-label={`Name of section ${i + 1} on ${name}`}
                      aria-invalid={!s.name.trim() ? 'true' : undefined}
                    />
                    <Button size="sm" variant="ghost" icon={Trash2} iconOnly disabled={sections.length === 1} onClick={() => setSections(p.path, sections.filter((_, j) => j !== i))}>
                      Remove the section {s.name || i + 1} from {name}
                    </Button>
                  </div>
                  <textarea
                    className={`${form.input} ${styles.text}`}
                    value={s.content}
                    maxLength={MAX_SECTION_TEXT}
                    rows={3}
                    onChange={(e) => edit(i, { content: e.target.value })}
                    aria-label={`Text of ${s.name || `section ${i + 1}`} on ${name}`}
                    aria-invalid={!s.content.trim() ? 'true' : undefined}
                  />
                </li>
              ))}
            </ol>
            {changed && (
              <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setSections(p.path, plan.sections)}>
                Put back the plan’s text for {name}
              </Button>
            )}
          </details>
        );
      })}
    </div>
  );
}
