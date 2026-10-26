import { useEffect, useState } from 'react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import form from '../common/Form.module.css';

// The four stacks of "Copy my site" (docs/COPY-MY-SITE.md §7), each with one line of what it is.
export const COPY_STACKS = [
  { id: 'html', name: 'Plain HTML', line: 'Plain files that run on any web host. The best choice for most sites.' },
  { id: 'react-vite', name: 'React + Vite', line: 'A React project. Visitors download a little app code; the pages are ready for search engines.' },
  { id: 'nextjs', name: 'Next.js', line: 'A Next.js (React) project for Vercel or Netlify, with static pages.' },
  { id: 'mern', name: 'MERN', line: 'React pages plus a small Express server that can store contact-form submissions in MongoDB.' },
];

// The most pages one as-is copy takes: the server keeps the first this many of the list it is sent (AS_IS_MAX_PAGES in
// server/src/recreate/behavior/preserve/asis.js; AsIsChoice lists the same number).
const AS_IS_MAX_PAGES = 40;

/** The address must be a web address with a host (https is asked for; http is accepted and upgraded when it works). */
export function validAddress(value) {
  try {
    const u = new URL(value.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The one short panel of "Copy my site": the stack, the new-site address, the authorisation, and the pages (every page
 * by default). Nothing runs until it is confirmed.
 */
export default function CopyPanel({ open, onClose, project, pageCount, onStart }) {
  const [stack, setStack] = useState('html');
  const [address, setAddress] = useState(project.target_domain ?? '');
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStack('html');
      setAddress(project.target_domain ?? '');
      setAllowed(false);
      setError(null);
    }
  }, [open, project.target_domain]);

  const submit = async () => {
    // The address is optional: an empty one means the copy names no address of its own (see the note under the field).
    if (address.trim() && !validAddress(address)) return setError('The address must be a web address, for example https://new.example.com — or leave it empty.');
    if (!allowed) return setError('Confirm that you may copy this site before it starts.');
    if (!project.authorized) return setError('This website is not marked as authorised. Only authorised websites can be copied.');
    setBusy(true);
    try {
      await onStart({ stack, address: address.trim() });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title="Copy my site"
      description="A ready copy of every page, as it is, with the problems fixed where that is safe. Pick the technology and confirm."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Starting…' : 'Copy my site'}</Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Technology of the copy" style={{ display: 'grid', gap: 8 }}>
        {COPY_STACKS.map((s) => (
          <label key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="radio" name="copy-stack" checked={stack === s.id} onChange={() => setStack(s.id)} />
            <span>
              <strong>{s.name}</strong>
              <span style={{ display: 'block', color: 'var(--muted)' }}>{s.line}</span>
            </span>
          </label>
        ))}
      </div>

      <label className={form.field} style={{ marginTop: 16 }}>
        <span className={form.label}>
          Address of the new site <span className={form.optional}>optional</span>
        </span>
        <input
          className={`${form.input} mono`}
          placeholder="https://new.example.com"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        {/* What the copy does with it is in copy/fixAsIs.js (address fixes) and copy/address.js; this says the same in plain words. */}
        <span style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 13 }}>
          Where the new site will live. With it, the copy’s canonical links, link previews (og:url), robots.txt, sitemap.xml and
          structured data name the new site. Leave it empty and the copy keeps the original’s own canonical links and robots.txt
          as they are (they still name the original site), writes no sitemap.xml, and lists “new-site address” as an open
          item to settle before you publish. You can add it later and make the copy again.
        </span>
      </label>

      <p style={{ marginTop: 12, color: 'var(--muted)' }}>
        Pages: {!pageCount
          ? 'every page of the site'
          : pageCount > AS_IS_MAX_PAGES
            ? `the first ${AS_IS_MAX_PAGES} of the ${pageCount} pages found so far`
            : `every page of the site (${pageCount} found so far)`}.
      </p>

      <label className={form.check} style={{ marginTop: 12 }}>
        <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
        <span>I am allowed to copy this site (it is my own site, or a client’s who has asked me to).</span>
      </label>

      {error && <p role="alert" style={{ marginTop: 12, color: 'var(--bad, #b42318)' }}>{error}</p>}
    </Modal>
  );
}
