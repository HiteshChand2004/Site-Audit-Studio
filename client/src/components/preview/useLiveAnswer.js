import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { withAnswer } from './framing.js';

/**
 * The live availability of the original, with whether it answers right now: asked from the server once per address
 * (only while it could be shown live), so a site that is down opens on its picture instead of a blank frame.
 * @param {string} projectId
 * @param {string} url
 * @param {{ ok: boolean, why: string|null }} live  liveAvailability(audit, url)
 */
export function useLiveAnswer(projectId, url, live) {
  const [answer, setAnswer] = useState(null);
  useEffect(() => {
    setAnswer(null);
    if (!live.ok || !projectId || !url) return undefined;
    let alive = true;
    // A failed question (the app's own server is off) says nothing about the site: live stays as it was.
    api.siteAnswers(projectId, url).then((a) => alive && setAnswer(a)).catch(() => {});
    return () => { alive = false; };
  }, [projectId, url, live.ok]);
  return withAnswer(live, answer);
}
