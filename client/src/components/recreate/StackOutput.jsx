import { AlertTriangle, Check, Hammer, RotateCw, X } from 'lucide-react';
import Button from '../common/Button.jsx';
import { stackName } from '../../stacks.js';
import styles from './RecreateReport.module.css';
import panel from '../../layout/Panel.module.css';

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Row({ ok, label, detail }) {
  const Icon = ok ? Check : X;
  return (
    <li className={styles.check} data-ok={ok}>
      <span className={styles.mark} aria-label={ok ? 'Passed' : 'Failed'}>
        <Icon size={11} strokeWidth={3} />
      </span>
      <span className={styles.checkLabel}>{label}</span>
      <span className={styles.checkDetail}>{detail}</span>
    </li>
  );
}

/**
 * The project's stack build of a recreate (React + Vite, Next.js, MERN): building / failed / not built, or what was
 * verified about it and what it costs. The plain-HTML build is the reference; an app build is checked against it.
 */
export default function StackOutput({ stack, state, output, busy, onBuild }) {
  const name = stackName(stack);

  if (state === 'building') {
    return (
      <div className={styles.card} role="status">
        <div className={styles.head}>
          <span className={styles.title}>{name} build</span>
          <span className={styles.meta}>
            <RotateCw size={12} className={panel.spin} aria-hidden="true" /> Building from the saved recreate… this can take a couple of minutes.
          </span>
        </div>
        <p className={styles.meta}>The plain-HTML build is shown until it is ready.</p>
      </div>
    );
  }

  if (state === 'failed' || state === 'none') {
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.title}>{name} build</span>
          <span className={styles.meta}>{state === 'failed' ? 'failed' : 'not built for this recreate'}</span>
        </div>
        {state === 'failed' && (
          <ul className={styles.warnings}>
            <li>
              <AlertTriangle size={12} aria-hidden="true" />
              {output?.error ?? 'The build failed.'}
            </li>
          </ul>
        )}
        <p className={styles.meta}>The plain-HTML build is shown and downloadable; the {name} version is built from the same recreate, without capturing the site again.</p>
        <div>
          <Button size="sm" icon={Hammer} onClick={onBuild} disabled={busy}>
            {state === 'failed' ? `Build ${name} again` : `Build ${name}`}
          </Button>
        </div>
      </div>
    );
  }

  const { build, equivalence, hydration, safety, urlChanges, forms, server } = output;
  const hydrated = hydration ? hydration.checked - hydration.failed : null;
  return (
    <div className={styles.card}>
      <section aria-label={`${name} build`}>
        <div className={styles.head}>
          <span className={styles.title}>{name} build</span>
          <span className={styles.meta}>
            {build?.toolchain} · {plural(output.pages?.length ?? 0, 'page')}
            {build?.ms != null && ` · built in ${Math.round(build.ms / 1000)} s`}
          </span>
        </div>
        <ul className={styles.checks}>
          {equivalence && (
            <Row
              ok
              label="Same as the plain-HTML build"
              detail={`${equivalence.dom.equal}/${equivalence.dom.total} pages identical · pixels ≥ ${Math.round((equivalence.visual.min ?? 1) * 100)}%`}
            />
          )}
          {hydration && (
            <Row ok={!hydration.failed} label="Hydration" detail={`${hydrated}/${hydration.checked} pages hydrate cleanly`} />
          )}
          {safety && <Row ok={safety.safe} label="Safety" detail="only the build’s own scripts, no external reference" />}
          {build?.js && (
            <Row
              ok
              label="JavaScript shipped"
              detail={`${kb(build.js.gzipBytes)} gzipped (${kb(build.js.bytes)}) · CSS ${kb(build.css?.bytes ?? 0)} · the plain-HTML build ships none`}
            />
          )}
          {output.fidelity?.score != null && (
            <Row ok label="Fidelity to the original" detail={`${output.fidelity.score}/100 — same as the plain-HTML build it is identical to`} />
          )}
          {urlChanges?.length > 0 && (
            <Row
              ok
              label="URLs changed"
              detail={`${plural(urlChanges.length, 'page')} moved (${urlChanges.slice(0, 2).map((c) => `${c.from} → ${c.to}`).join(', ')}${urlChanges.length > 2 ? ', …' : ''}); redirects are in the download`}
            />
          )}
          {forms && (
            <Row
              ok
              label="Forms"
              detail={`${plural(forms.stored.length, 'form')} stored in MongoDB · ${forms.skipped.length} left as they are · server tests ${server?.tests?.pass}/${server?.tests?.tests}`}
            />
          )}
        </ul>
      </section>
      {output.warnings?.length > 0 && (
        <ul className={styles.warnings}>
          {output.warnings.map((w) => (
            <li key={w}>
              <AlertTriangle size={12} aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
