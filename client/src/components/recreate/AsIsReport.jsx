import { Alert, Card } from '../common/Surface.jsx';
import { AS_IS_EXPLANATION, ASIS_STACK_CHOICES } from './AsIsChoice.jsx';
import styles from './AsIsReport.module.css';

const kb = (bytes) => `${Math.round((bytes ?? 0) / 1024).toLocaleString('en-US')} KB`;
const stackName = (id) => ASIS_STACK_CHOICES.find((s) => s.id === id)?.label ?? id;

/** One page's checks as a row of short facts. */
function PageRow({ page }) {
  const visual = Object.fromEntries((page.visual ?? []).map((v) => [v.width, v.diffPct]));
  const offline = page.offline ?? {};
  const errors = (offline.errors ?? []).length;
  return (
    <tr>
      <td className="mono">{page.path}</td>
      <td>{offline.external?.length ? <span className={styles.bad}>{offline.external.length} off the copy</span> : <span className={styles.good}>none leave the copy</span>}</td>
      <td>{visual[1440] ?? '—'}%</td>
      <td>{visual[390] ?? '—'}%</td>
      <td>{page.hovers ? `${page.hovers.copy.changed} of ${page.hovers.original.changed}` : '—'}</td>
      <td>{page.controls ? `${page.controls.copy.visible} of ${page.controls.original.visible} visible` : '—'}</td>
      <td>{errors ? <span className={styles.bad}>{errors}</span> : '0'}</td>
      <td>{page.forms?.count ?? 0}</td>
    </tr>
  );
}

/**
 * The result of an "Original as-is" copy: the mode, the checks per page, what was excluded by rule, what needs a person, the
 * JavaScript the copy ships, and Lighthouse before and after (desktop).
 */
export default function AsIsReport({ asIs, outputs }) {
  if (!asIs) return null;
  const checks = asIs.checks?.pages ?? [];
  const lh = asIs.lighthouse ?? {};
  const before = lh.before ?? null;
  const after = lh.after ?? null;
  const excluded = asIs.excludedByRule ?? [];
  const gaps = checks.flatMap((p) => (p.controls?.excludedByRule ?? []).map((c) => ({ ...c, page: p.path })));
  return (
    <Card title="Original as-is" sub={`Packaged as ${stackName(asIs.stack)} · ${asIs.pages?.length ?? checks.length} page(s)`}>
      <p className={styles.mode}>
        <strong>Mode used:</strong> Original as-is. {AS_IS_EXPLANATION}
      </p>

      {asIs.safety && !asIs.safety.safe && (
        <Alert tone="warn" title="The copy asks for something off its own server">
          Some request leaves the copy. The download is kept off until this is checked: see the checks below.
        </Alert>
      )}

      <h4 className={styles.h}>Checks, per page</h4>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Page</th>
              <th>Cold first visit</th>
              <th>Visual 1440</th>
              <th>Visual 390</th>
              <th>Hovers (copy / original)</th>
              <th>Controls</th>
              <th>Console errors</th>
              <th>Forms</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((p) => <PageRow key={p.path} page={p} />)}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>Controls: the page is clicked the same way on both sides; “visible” counts the controls the original shows.</p>

      <h4 className={styles.h}>Excluded by rule</h4>
      {excluded.length || gaps.length ? (
        <ul className={styles.list}>
          {excluded.length > 0 && <li>Third-party scripts left out on purpose (trackers, chat widgets, the builder&rsquo;s editor): {excluded.join(', ')}.</li>}
          {gaps.map((g, i) => <li key={`${g.page}-${i}`}>{g.label} on {g.page}: {g.why}.</li>)}
        </ul>
      ) : <p className={styles.note}>Nothing was left out.</p>}

      <h4 className={styles.h}>Needs a person</h4>
      {asIs.needsAPerson?.length ? (
        <Alert tone="warn" title={`${asIs.needsAPerson[0].count} form${asIs.needsAPerson[0].count === 1 ? '' : 's'} need a server`}>
          The form is drawn and checked as on the original, but its data is never sent to the original site. Until a server is connected,
          submitting a form shows “This form is not connected yet, so nothing was sent.” To receive submissions, set <span className="mono">FORM_ENDPOINT</span> in
          <span className="mono"> sas-forms.json</span> (see the README in the download); no rebuild is needed.
        </Alert>
      ) : <p className={styles.note}>No form needs a server.</p>}

      <h4 className={styles.h}>JavaScript shipped</h4>
      <p className={styles.note}>
        {asIs.javascript ? `${asIs.javascript.files} file(s): ${kb(asIs.javascript.bytes)}, ${kb(asIs.javascript.gzipBytes)} compressed. This is the original's own code, kept as it is.` : 'Not measured.'}
      </p>

      <h4 className={styles.h}>Lighthouse, desktop (before and after)</h4>
      {after && !lh.error ? (
        <table className={styles.table}>
          <thead>
            <tr><th /><th>Performance</th><th>SEO</th><th>Accessibility</th><th>Best practices</th></tr>
          </thead>
          <tbody>
            <tr><td>Original</td><td>{before?.performance ?? '—'}</td><td>—</td><td>—</td><td>—</td></tr>
            <tr><td>Copy</td><td>{after.performance}</td><td>{after.seo}</td><td>{after.accessibility}</td><td>{after.bestPractices}</td></tr>
          </tbody>
        </table>
      ) : (
        <p className={styles.note}>{lh.error ? `Not measured: ${lh.error}` : 'Not measured.'}</p>
      )}

      {outputs?.length > 0 && <p className={styles.note}>The download is the {stackName(asIs.stack)} project, with its README (install, run, deploy, FORM_ENDPOINT).</p>}
    </Card>
  );
}

