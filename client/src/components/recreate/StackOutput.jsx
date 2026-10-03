import { AlertTriangle, Hammer, Layers, Loader2 } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Alert, Card } from '../common/Surface.jsx';
import { StatusIcon } from '../common/Score.jsx';
import { stackName } from '../../stacks.js';
import styles from './StackOutput.module.css';

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Row({ ok, label, detail }) {
  return (
    <li className={styles.row}>
      <StatusIcon tone={ok ? 'ok' : 'bad'} size={22} label={ok ? 'OK' : 'Problem'} />
      <span className={styles.label}>{label}</span>
      <span className={styles.detail}>{detail}</span>
    </li>
  );
}

/**
 * The version of the copy in the project's technology (React + Vite, Next.js, MERN): being built / failed / not built yet,
 * or what was checked about it, in plain words. It is always checked against the simple (plain HTML) version.
 */
export default function StackOutput({ stack, state, output, busy, onBuild }) {
  const name = stackName(stack);

  if (state === 'building') {
    return (
      <Card icon={Layers} title={`Building the ${name} version`} sub="Made from the saved copy (the site is not visited again). This takes a couple of minutes; the simple version is shown meanwhile.">
        <p className={styles.working}>
          <Loader2 size={16} className={styles.spin} aria-hidden="true" /> Working…
        </p>
      </Card>
    );
  }

  if (state === 'failed' || state === 'none') {
    return (
      <Card
        icon={Layers}
        title={state === 'failed' ? `The ${name} version could not be built` : `The ${name} version is not built yet`}
        sub={`The simple version can be previewed and downloaded already. The ${name} version is made from the same copy, without visiting the site again.`}
      >
        {state === 'failed' && (
          <Alert tone="bad" title="What went wrong">
            {output?.error ?? 'The build failed.'}
          </Alert>
        )}
        <div className={styles.actions}>
          <Button icon={Hammer} onClick={onBuild} disabled={busy}>
            {state === 'failed' ? `Try building ${name} again` : `Build the ${name} version`}
          </Button>
        </div>
      </Card>
    );
  }

  const { build, equivalence, hydration, safety, urlChanges, forms, server } = output;
  const hydrated = hydration ? hydration.checked - hydration.failed : null;
  return (
    <Card
      icon={Layers}
      title={`${name} version`}
      sub={`${plural(output.pages?.length ?? 0, 'page')}${build?.ms != null ? ` · built in ${Math.round(build.ms / 1000)} s` : ''}. Checked against the simple version page by page.`}
    >
      <ul className={styles.rows}>
        {equivalence && (
          <Row ok label="Looks and works like the simple version" detail={`${equivalence.dom.equal} of ${equivalence.dom.total} pages identical`} />
        )}
        {hydration && <Row ok={!hydration.failed} label="Starts without errors in the browser" detail={`${hydrated} of ${hydration.checked} pages`} />}
        {safety && <Row ok={safety.safe} label="Safe" detail="Only its own scripts; nothing is loaded from other sites" />}
        {build?.js && (
          <Row ok label="Extra download for visitors" detail={`${kb(build.js.gzipBytes)} of app code (the simple version needs none)`} />
        )}
        {output.fidelity?.score != null && <Row ok label="Match with the original" detail={`${output.fidelity.score} out of 100, the same as the simple version`} />}
        {urlChanges?.length > 0 && (
          <Row
            ok
            label="Some page addresses changed"
            detail={`${plural(urlChanges.length, 'page')}, e.g. ${urlChanges.slice(0, 2).map((c) => `${c.from} → ${c.to}`).join(', ')}. Redirects from the old addresses are included.`}
          />
        )}
        {forms && (
          <Row
            ok
            label="Contact forms"
            detail={`${plural(forms.stored.length, 'form')} save${forms.stored.length === 1 ? 's' : ''} what visitors send in its database · ${forms.skipped.length} left as ${forms.skipped.length === 1 ? 'it is' : 'they are'} · server checks ${server?.tests?.pass}/${server?.tests?.tests} passed`}
          />
        )}
      </ul>
      {output.warnings?.length > 0 && (
        <ul className={styles.warnings}>
          {output.warnings.map((w) => (
            <li key={w}>
              <AlertTriangle size={14} aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
