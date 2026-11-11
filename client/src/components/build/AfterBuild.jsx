import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Alert } from '../common/Surface.jsx';
import FillMissing from './FillMissing.jsx';
import EditText from './EditText.jsx';
import ShareSite from './ShareSite.jsx';

/**
 * What the owner does with a finished site, without building again (server/src/buildmode/edit.js, publish.js): fill in
 * what is missing, change the words, share it with a link. Every change comes back as the run (onRun), so the preview
 * and the download show it.
 */
export default function AfterBuild({ run, onRun }) {
  const [texts, setTexts] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.getBuildTexts(run.id).then((t) => { setTexts(t); setError(''); }).catch((e) => setError(e.message));
  }, [run.id]);
  // Read again after every change: what is missing and what can be changed follow the site's files.
  useEffect(load, [load, run.revision]);

  /** One change: the run comes back with its new revision; the words are read again by the effect above. */
  const edit = async (body) => {
    const out = await api.editBuild(run.id, body);
    onRun(out.run);
    return out;
  };

  return (
    <>
      {error && <Alert tone="warn" title="The site’s words could not be read">{error}</Alert>}
      {texts && <FillMissing texts={texts} onFill={(token, value) => edit({ kind: 'fill', token, value })} />}
      {texts && <EditText texts={texts} run={run} onEdit={(page, from, to) => edit({ kind: 'text', page, from, to })} />}
      <ShareSite run={run} onRun={onRun} />
    </>
  );
}
