const API_DOWN = 'Cannot reach the API server (port 4000). Start it with npm run dev.';

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error(API_DOWN), { status: 0 });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // The Vite dev proxy answers 5xx without a JSON body when the API server is not running.
    const message = data?.error || (res.status >= 500 && !data ? API_DOWN : `Request failed (${res.status})`);
    const err = new Error(message);
    err.status = res.status;
    err.data = data ?? {};
    throw err;
  }
  return data;
}

// How long a dropped progress stream keeps trying to reconnect before the job is shown as lost.
const RECONNECT_FOR_MS = 120000;
const RECONNECT_MAX_DELAY_MS = 10000;

/**
 * Streams job progress (Analyze or Recreate) over SSE. Handlers: progress(job), done(job),
 * failed(job), reconnecting(boolean). Returns a function that closes the stream.
 *
 * A dropped connection (API server restarting, proxy error, network blip) is not an error: the
 * stream reconnects with backoff for up to 2 minutes and the server replays the job's current
 * state on connect (or its final state, if it ended meanwhile). Only then is the job reported lost.
 */
function subscribe(url, { progress, done, failed, reconnecting }) {
  const parse = (e) => JSON.parse(e.data);
  let source = null;
  let timer = null;
  let closed = false;
  let attempt = 0;
  let downSince = null;
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
  const connected = () => {
    if (downSince != null) reconnecting?.(false);
    attempt = 0;
    downSince = null;
  };

  const open = () => {
    source = new EventSource(url);
    source.addEventListener('open', connected);
    source.addEventListener('progress', (e) => {
      connected();
      progress?.(parse(e));
    });
    source.addEventListener('done', (e) => {
      stop();
      done?.(parse(e));
    });
    source.addEventListener('failed', (e) => {
      stop();
      failed?.(parse(e));
    });
    source.onerror = () => {
      if (closed) return;
      if (downSince == null) {
        downSince = Date.now();
        reconnecting?.(true);
      }
      // CONNECTING: the browser retries on its own. CLOSED: the server or proxy answered with an
      // error (for example while the API restarts); retry ourselves.
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      if (Date.now() - downSince > RECONNECT_FOR_MS) {
        stop();
        failed?.({ status: 'failed', error: 'Lost connection to the server. Reload the page to see the latest state.' });
        return;
      }
      timer = setTimeout(open, Math.min(1000 * 2 ** attempt++, RECONNECT_MAX_DELAY_MS));
    };
  };
  open();
  return stop;
}

export const api = {
  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: input }),
  updateProject: (id, patch) => request(`/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getAudit: (id) => request(`/projects/${id}/audit`),
  startAnalyze: (id, body = {}) => request(`/projects/${id}/analyze`, { method: 'POST', body }),
  getCurrentAnalysis: (id) => request(`/projects/${id}/analyze/current`),
  subscribeAnalysis: (id, analysisId, handlers) => subscribe(`/api/projects/${id}/analyze/${analysisId}/events`, handlers),
  startRecreate: (id) => request(`/projects/${id}/recreate`, { method: 'POST' }),
  getCurrentRecreate: (id) => request(`/projects/${id}/recreate/current`),
  getRecreate: (id) => request(`/projects/${id}/recreate`),
  subscribeRecreate: (id, recreateId, handlers) => subscribe(`/api/projects/${id}/recreate/${recreateId}/events`, handlers),
  getPreview: (id) => request(`/projects/${id}/preview`),
  startPreview: (id) => request(`/projects/${id}/preview`, { method: 'POST' }),
};
