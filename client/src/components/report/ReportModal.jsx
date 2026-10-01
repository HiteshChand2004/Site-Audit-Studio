import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FileDown, FileJson, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { api } from '../../api/client.js';
import styles from './ReportModal.module.css';

const STEPS = [
  'Collecting the audit of the original site',
  'Reading the recreated site and its screenshots',
  'Comparing the original with the recreate',
  'Writing the report',
];
const STEP_MS = 650;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return 'site';
  }
};
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Saves text (or a Blob) as a file through a temporary link. */
function save(content, mime, name) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * "Generate report": builds the complete report (OLD panel, NEW panel, fix checklist) on the server, shows it, and
 * offers it as HTML (opens anywhere, prints to PDF) or JSON (the raw data).
 */
export default function ReportModal({ open, onClose, project }) {
  const [phase, setPhase] = useState('idle'); // idle | working | ready | error
  const [step, setStep] = useState(0);
  const [html, setHtml] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'pdf' | 'json' while that file is being prepared
  const run = useRef(0);

  const generate = useCallback(async () => {
    const token = ++run.current;
    setPhase('working');
    setStep(0);
    setError(null);
    const tick = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), STEP_MS);
    const started = Date.now();
    try {
      const text = await api.getReportHtml(project.id);
      // Show the steps for a moment even when the server is fast: it is what tells the user something was built.
      const wait = Math.max(0, STEP_MS * STEPS.length - (Date.now() - started));
      await new Promise((r) => setTimeout(r, Math.min(wait, 1200)));
      if (token !== run.current) return;
      setHtml(text);
      setPhase('ready');
    } catch (err) {
      if (token !== run.current) return;
      setError(err.message);
      setPhase('error');
    } finally {
      clearInterval(tick);
    }
  }, [project.id]);

  useEffect(() => {
    if (open) generate();
    else run.current++;
  }, [open, generate]);

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${hostOf(project.url)}-audit-report-${stamp}`;

  const download = async (kind) => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'pdf') save(await api.getReportPdf(project.id), 'application/pdf', `${base}.pdf`);
      else save(await api.getReportJson(project.id), 'application/json', `${base}.json`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={1040}
      title="Complete report"
      description={`${project.name} · original site, recreated site and fix checklist in one file.`}
    >
      <div className={styles.wrap}>
        {phase === 'working' && (
          <div className={styles.working} role="status" aria-live="polite">
            <div className={styles.orb} aria-hidden="true">
              <Sparkles size={26} />
            </div>
            <h3>Building your report…</h3>
            <ol className={styles.steps}>
              {STEPS.map((label, i) => (
                <li key={label} data-state={i < step ? 'done' : i === step ? 'active' : 'todo'} style={{ '--i': i }}>
                  <span className={styles.mark}>{i < step ? <Check size={12} strokeWidth={3} /> : i === step ? <Loader2 size={12} className={styles.spin} /> : null}</span>
                  {label}
                </li>
              ))}
            </ol>
            <div className={styles.bar} aria-hidden="true">
              <span style={{ width: `${((step + 1) / STEPS.length) * 92}%` }} />
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.error} role="alert">
            <AlertTriangle size={22} />
            <p>The report could not be built: {error}</p>
            <Button variant="primary" icon={RefreshCw} onClick={generate}>
              Try again
            </Button>
          </div>
        )}

        {phase === 'ready' && (
          <>
            <div className={styles.actions}>
              <span className={styles.ok}>
                <Check size={14} strokeWidth={3} /> Report ready · {kb(html.length)}
              </span>
              <div className={styles.buttons}>
                <Button variant="primary" icon={busy === 'pdf' ? Loader2 : FileDown} onClick={() => download('pdf')} disabled={busy !== null}>
                  {busy === 'pdf' ? 'Building PDF…' : 'Download PDF'}
                </Button>
                <Button icon={FileText} onClick={() => save(html, 'text/html', `${base}.html`)}>
                  HTML
                </Button>
                <Button icon={FileJson} onClick={() => download('json')} disabled={busy !== null}>
                  {busy === 'json' ? 'Preparing…' : 'JSON'}
                </Button>
                <Button variant="ghost" icon={RefreshCw} onClick={generate}>
                  Regenerate
                </Button>
              </div>
            </div>
            {error && <p className={styles.inlineError}>{error}</p>}
            <iframe className={styles.preview} title="Report preview" srcDoc={html} sandbox="allow-same-origin" />
            <p className={styles.hint}>The PDF is built on the server and downloads directly. The HTML file is self-contained (it opens offline); the JSON holds the complete data.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
