import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { useProjects } from '../../store/useProjects.js';
import { STACKS } from '../../constants.js';
import styles from './StackModal.module.css';
import form from '../common/Form.module.css';

// Pages besides the homepage when a limit is set; -1 = every page of the site (the default, up to the server's safety cap).
const MAX_PAGES = 300;
const ALL_PAGES = -1;
const isAll = (v) => v == null || v === ALL_PAGES;

export default function StackModal({ open, onClose, project, askAddress = false }) {
  const update = useProjects((s) => s.update);
  const recreate = useProjects((s) => s.recreate);
  // The technology of a clean copy. Saved on the project, so the build, the preview, the comparison and the download all
  // follow it. (The as-is copy has its own choice in the "Copy my site" panel, which saves the same field.)
  const [choice, setChoice] = useState(project?.stack ?? 'html');
  const [all, setAll] = useState(isAll(project?.recreate_pages));
  const [pages, setPages] = useState(String(isAll(project?.recreate_pages) ? 5 : project.recreate_pages));
  const [domain, setDomain] = useState(project?.target_domain ?? '');
  const [exact, setExact] = useState(Boolean(project?.exact_mode));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setChoice(project?.stack ?? 'html');
      setAll(isAll(project?.recreate_pages));
      setPages(String(isAll(project?.recreate_pages) ? 5 : project.recreate_pages));
      setDomain(project?.target_domain ?? '');
      setExact(Boolean(project?.exact_mode));
      setError(null);
    }
  }, [open, project?.stack, project?.recreate_pages, project?.target_domain, project?.exact_mode]);

  const save = async () => {
    const n = all ? ALL_PAGES : Number(pages);
    if (!all && (!Number.isInteger(n) || n < 0 || n > MAX_PAGES)) {
      setError(`Pages must be a whole number from 0 to ${MAX_PAGES}.`);
      return;
    }
    // The address is optional (what an empty one means is said under the field); a value given must be a web address.
    setSaving(true);
    try {
      await update(project.id, {
        stack: choice,
        recreate_pages: exact ? ALL_PAGES : n,
        target_domain: domain.trim() || null,
        exact_mode: exact,
      });
      onClose();
      if (askAddress) recreate(project.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={askAddress ? 'Where will the new site live?' : 'Settings for the copy'}
      description={
        askAddress
          ? 'With its own address, the copy names it in search-engine tags, the sitemap, link previews and structured data, so nothing points back to the original site. It is optional and saved for this website; you can add it later and make the copy again.'
          : 'Which technology the new site is built with, which pages are copied, and its future address. Saved for this website.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : askAddress ? (domain.trim() ? 'Save and create the copy' : 'Create the copy without an address') : 'Save'}
          </Button>
        </>
      }
    >
      <div className={styles.grid} role="radiogroup" aria-label="Technology of the new site">
        {STACKS.map((stack) => {
          const selected = choice === stack.id;
          return (
            <button
              key={stack.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={styles.option}
              data-selected={selected}
              onClick={() => setChoice(stack.id)}
            >
              <span className={styles.radio} aria-hidden="true">
                {selected && <Check size={11} strokeWidth={3} />}
              </span>
              <span className={styles.name}>{stack.name}</span>
              <span className={styles.detail}>{stack.detail}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.settings}>
        <div className={form.field}>
          <span className={form.label}>How exact</span>
          <label className={form.check}>
            <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} />
            <span>
              Exact copy. Every page is checked against the original at every screen size and what looks different is
              corrected, so the copy takes hours instead of minutes. The site is copied as it is: colours and pictures are left untouched, which
              means the original’s own contrast and picture problems are kept rather than fixed.
            </span>
          </label>
        </div>
        <div className={form.field}>
          <span className={form.label}>Pages</span>
          <label className={form.check}>
            <input type="checkbox" checked={all || exact} disabled={exact} onChange={(e) => setAll(e.target.checked)} />
            <span>
              Every page of the site. Every link in the new site then opens a page of the new site; the time limit grows with
              the number of pages.{exact ? ' An exact copy always takes every page.' : ''}
            </span>
          </label>
          {!all && !exact && (
            <>
              <input
                className={`${form.input} mono`}
                type="number"
                min={0}
                max={MAX_PAGES}
                aria-label="Pages besides the homepage"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              />
              <span className={styles.hint}>The homepage plus this many pages (0–{MAX_PAGES}).</span>
            </>
          )}
        </div>
        <label className={form.field}>
          <span className={form.label}>
            Address of the new site <span className={form.optional}>optional</span>
          </span>
          <input
            className={`${form.input} mono`}
            placeholder="https://new.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          {/* The clean copy's rule is recreate/index.js (baseUrl = this address, else the original's); the as-is copy's is copy/fixAsIs.js. */}
          <span className={styles.hint}>
            Where the new site will live. With it, the copy’s canonical links, sitemap.xml, robots.txt, link previews and structured data
            name the new site. Left empty, a clean copy writes those with the original site’s address and the report says so; an
            original as-is copy keeps the original’s own canonical links and robots.txt, writes no sitemap.xml, and lists the
            address as an open item to settle before publishing.
          </span>
        </label>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </Modal>
  );
}
