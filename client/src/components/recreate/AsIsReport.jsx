import { Alert, Card } from '../common/Surface.jsx';
import Button from '../common/Button.jsx';
import { api } from '../../api/client.js';
import { AS_IS_EXPLANATION, ASIS_STACK_CHOICES } from './AsIsChoice.jsx';
import styles from './AsIsReport.module.css';

const kb = (bytes) => `${Math.round((bytes ?? 0) / 1024).toLocaleString('en-US')} KB`;
const stackName = (id) => ASIS_STACK_CHOICES.find((s) => s.id === id)?.label ?? id;

/** One page's checks as a row of short facts. */
function PageRow({ page }) {
  const offline = page.offline ?? {};
  const errors = (offline.errors ?? []).length;
  return (
    <tr>
      <td className="mono">{page.path}</td>
      <td>{offline.external?.length ? <span className={styles.bad}>{offline.external.length} off the copy</span> : <span className={styles.good}>none leave the copy</span>}</td>
      <td>{page.hovers ? `${page.hovers.copy.changed} of ${page.hovers.original?.changed ?? '—'}` : '—'}</td>
      <td>{page.controls ? `${page.controls.copy.visible} of ${page.controls.original?.visible ?? '—'} visible` : '—'}</td>
      <td>{errors ? <span className={styles.bad}>{errors}</span> : '0'}</td>
      <td>{page.forms?.count ?? 0}</td>
    </tr>
  );
}

/**
 * The result of an "Original as-is" copy: the mode, the checks per page, what was excluded by rule, what needs a person, the
 * JavaScript the copy ships, and Lighthouse before and after (desktop).
 */
/** A copy converted into the stack's code: what became components, what was kept as original HTML, and each form in plain words. */
function Converted({ convert }) {
  if (convert.mode !== 'converted') {
    return (
      <>
        <h4 className={styles.h}>Converted into code</h4>
        <Alert tone="warn" title="Packaged as static files instead">
          The copy could not be converted into pages and components{convert.failed ? `: ${convert.failed.split('\n')[0]}` : ''}. It is packaged as static files inside a project of the stack, so the download still works.
        </Alert>
      </>
    );
  }
  const s = convert.stats ?? {};
  const fallbacks = convert.fallbacks ?? [];
  const forms = convert.forms ?? [];
  return (
    <>
      <h4 className={styles.h}>Converted into code</h4>
      <p className={styles.note}>
        {s.pages} page(s) became {s.components} component(s){s.shared ? ` (${s.shared} shared between pages)` : ''}, {s.elements} element(s) written as components.
        The pages are prerendered and not hydrated, so no runtime of the stack is sent to visitors.
        {convert.urlChanges?.length ? ` ${convert.urlChanges.length} page address(es) changed to folder form (redirects are in the download).` : ''}
      </p>
      {fallbacks.length ? (
        <>
          <p className={styles.note}>{fallbacks.length} part(s) kept as the original HTML inside their component (the page is unchanged; only these parts are not component code):</p>
          <ul className={styles.list}>
            {fallbacks.slice(0, 20).map((f, i) => (
              <li key={i}><span className="mono">{f.page}</span> · <span className="mono">&lt;{f.tag}&gt;{f.attribute ? ` ${f.attribute}` : ''}</span> at <span className="mono">{f.where}</span>: {f.reason}</li>
            ))}
            {fallbacks.length > 20 && <li>… and {fallbacks.length - 20} more (all listed in KNOWN-ISSUES.md in the download).</li>}
          </ul>
        </>
      ) : <p className={styles.note}>Every element of every page is component code.</p>}
      <h4 className={styles.h}>Forms, in plain words</h4>
      {forms.length ? (
        <ul className={styles.list}>
          {forms.map((f, i) => (
            <li key={i}><span className="mono">{f.page}</span> · “{f.label}” ({f.method}, {f.fields.length} field(s){f.password ? ', a password' : ''}{f.file ? ', a file upload' : ''}): on the original it sent its data to {f.target}. {f.note}</li>
          ))}
        </ul>
      ) : <p className={styles.note}>No form on the copied pages.</p>}
    </>
  );
}

/** Shown above everything on Results (never inside "Show details"): the download is held back until this is checked. */
export function AsIsUnsafe({ asIs }) {
  if (!asIs?.safety || asIs.safety.safe) return null;
  return (
    <Alert tone="warn" title="The copy asks for something off its own server">
      Some request leaves the copy. The download is kept off until this is checked: “Checks, per page” under “Show details” shows which page.
    </Alert>
  );
}

export default function AsIsReport({ asIs, outputs, projectId, asIsOutputs = {}, onPackage }) {
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

      <h4 className={styles.h}>Checks, per page</h4>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Page</th>
              <th>Cold first visit</th>
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

      <h4 className={styles.h}>Addresses from the original</h4>
      {asIs.sameOrigin ? (
        <>
          <p className={styles.note}>
            The copy asks its own server for some files it did not hold. The original answered them, and the copy keeps those answers
            ({asIs.sameOrigin.mapped.length} kept; {asIs.sameOrigin.sameAsOriginal.length} the original also lacks).
            {asIs.sameOrigin.ambiguous.length > 0 && ` ${asIs.sameOrigin.ambiguous.length} path(s) have two sizes: each size is its own file.`}
          </p>
          {asIs.sameOrigin.sameAsOriginal.length > 0 && (
            <ul className={styles.list}>
              {asIs.sameOrigin.sameAsOriginal.map((x) => <li key={x.path}><code>{x.path}</code>: the same as the original ({x.reason}).</li>)}
            </ul>
          )}
          {asIs.ranged && (asIs.ranged.files.length > 0 || asIs.ranged.skipped.length > 0) && (
            <p className={styles.note}>
              {asIs.ranged.files.length} file(s) the original serves in pieces are kept whole, and the copy cuts the pieces itself.
              {asIs.ranged.skipped.length > 0 && ` ${asIs.ranged.skipped.length} could not be kept that way and stay as the original answers them.`}
            </p>
          )}
        </>
      ) : <p className={styles.note}>Not recorded for this copy: make the copy again to see it.</p>}

      {asIs.convert && <Converted convert={asIs.convert} />}
      {asIs.convert?.mode !== 'converted' && asIs.formRoutes?.length > 0 && (
        <>
          <h4 className={styles.h}>Forms, in plain words</h4>
          <ul className={styles.list}>
            {asIs.formRoutes.map((f, i) => <li key={i}><span className="mono">{f.page}</span> · “{f.label}” ({f.method}): {f.note}</li>)}
          </ul>
        </>
      )}

      <h4 className={styles.h}>Needs a person</h4>
      {asIs.needsAPerson?.length && asIs.convert?.wiredForms != null ? (
        <Alert tone="warn" title={`${asIs.needsAPerson[0].count} form${asIs.needsAPerson[0].count === 1 ? '' : 's'} not stored by the copy's server`}>
          {asIs.convert.wiredForms ? `${asIs.convert.wiredForms} form${asIs.convert.wiredForms === 1 ? ' is' : 's are'} saved in MongoDB by the copy's own server. ` : ''}
          These went to the original's own server and are forms the copy's server does not store (a sign-in, an upload, a search): “Forms, in plain words” above says which and why. A form of another service sends its data to it, as on the original.
        </Alert>
      ) : asIs.needsAPerson?.length ? (
        <Alert tone="warn" title={`${asIs.needsAPerson[0].count} form${asIs.needsAPerson[0].count === 1 ? '' : 's'} need a server`}>
          The form went to the original's own server: it is drawn and checked as on the original, but its data is never sent there. A form of another service is not counted here: it sends its data to that service, as on the original. Until a server is connected,
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
            {before
              ? <tr><td>Original (from the Check)</td><td>{before.performance ?? '—'}</td><td>{before.seo ?? '—'}</td><td>{before.accessibility ?? '—'}</td><td>{before.bestPractices ?? '—'}</td></tr>
              : <tr><td>Original</td><td colSpan={4}>Not measured: run the Check on this site to get the original's Lighthouse result.</td></tr>}
            <tr><td>Copy</td><td>{after.performance}</td><td>{after.seo}</td><td>{after.accessibility}</td><td>{after.bestPractices}</td></tr>
          </tbody>
        </table>
      ) : (
        <p className={styles.note}>{lh.error ? `Not measured: ${lh.error}` : 'Not measured.'}</p>
      )}

      {/* One download per stack: each stack's own output stays until that stack is packed again. A missing output is never offered. */}
      <h4 className={styles.h}>Downloads, one per stack</h4>
      <ul className={styles.list}>
        {ASIS_STACK_CHOICES.map((s) => {
          const out = asIsOutputs[s.id];
          return (
            <li key={s.id}>
              <span>{s.label}</span>{' '}
              {out && projectId ? (
                <a className="mono" href={api.downloadUrl(projectId, out.recreateId, s.id)}>Download .zip</a>
              ) : (
                <Button size="sm" onClick={() => onPackage?.(s.id)}>Package again</Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>Each download is the stack’s project, with its README (install, run, deploy, FORM_ENDPOINT).</p>
    </Card>
  );
}

