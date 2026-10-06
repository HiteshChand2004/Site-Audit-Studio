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
// The server sends a ping every 15 s; a stream silent for longer is treated as dropped (a proxy can
// keep the browser's connection open after the API behind it has gone).
const SILENT_MS = 40000;

/**
 * Streams job progress (Analyze, Recreate or Re-audit) over SSE. Handlers: progress(job), done(job),
 * failed(job), reconnecting(boolean). Returns a function that closes the stream.
 *
 * A dropped connection (API server restarting, proxy error, network blip, a silent stream) is not
 * an error: the stream reconnects with backoff for up to 2 minutes and the server replays the job's
 * current state on connect (or its final state, if it ended meanwhile). Only then is the job
 * reported lost.
 */
function subscribe(url, { progress, done, failed, reconnecting }) {
  const parse = (e) => JSON.parse(e.data);
  let source = null;
  let timer = null;
  let watchdog = null;
  let closed = false;
  let attempt = 0;
  let downSince = null;
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    source?.close();
  };
  const alive = () => {
    if (downSince != null) reconnecting?.(false);
    attempt = 0;
    downSince = null;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => drop(true), SILENT_MS);
  };
  // force: reopen ourselves even while the browser would keep retrying (a silent stream).
  const drop = (force) => {
    if (closed) return;
    if (downSince == null) {
      downSince = Date.now();
      reconnecting?.(true);
    }
    // CONNECTING: the browser retries on its own. CLOSED: the server or proxy answered with an
    // error (for example while the API restarts); retry ourselves.
    if (!force && source.readyState !== EventSource.CLOSED) return;
    source.close();
    clearTimeout(watchdog);
    if (Date.now() - downSince > RECONNECT_FOR_MS) {
      stop();
      failed?.({ status: 'failed', error: 'Lost connection to the server. Reload the page to see the latest state.' });
      return;
    }
    timer = setTimeout(open, Math.min(1000 * 2 ** attempt++, RECONNECT_MAX_DELAY_MS));
  };

  const open = () => {
    source = new EventSource(url);
    clearTimeout(watchdog);
    watchdog = setTimeout(() => drop(true), SILENT_MS);
    source.addEventListener('open', alive);
    source.addEventListener('ping', alive);
    source.addEventListener('progress', (e) => {
      alive();
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
    source.onerror = () => drop(false);
  };
  open();
  return stop;
}

// The report comes back as text (HTML or JSON), not as the JSON the other calls return.
async function requestText(path) {
  let res;
  try {
    res = await fetch(`/api${path}`);
  } catch {
    throw Object.assign(new Error(API_DOWN), { status: 0 });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || (res.status >= 500 ? API_DOWN : `Request failed (${res.status})`));
  }
  return res.text();
}

export const api = {
  // The complete report of a project (original site, recreated site, fix checklist).
  getReportHtml: (id) => requestText(`/projects/${id}/report`),
  getReportJson: (id) => requestText(`/projects/${id}/report?format=json`),
  // The PDF is made by the server (the same Chromium that draws the pages): a Blob to save, no print dialog.
  async getReportPdf(id) {
    let res;
    try {
      res = await fetch(`/api/projects/${id}/report?format=pdf`);
    } catch {
      throw Object.assign(new Error(API_DOWN), { status: 0 });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || (res.status >= 500 ? 'The PDF could not be built.' : `Request failed (${res.status})`));
    }
    return res.blob();
  },
  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: input }),
  updateProject: (id, patch) => request(`/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getAudit: (id) => request(`/projects/${id}/audit`),
  startAnalyze: (id, body = {}) => request(`/projects/${id}/analyze`, { method: 'POST', body }),
  getCurrentAnalysis: (id) => request(`/projects/${id}/analyze/current`),
  subscribeAnalysis: (id, analysisId, handlers) => subscribe(`/api/projects/${id}/analyze/${analysisId}/events`, handlers),
  // { reuseCapture: true }: rebuild from the last capture (the site is not opened again).
  startRecreate: (id, options = null) => request(`/projects/${id}/recreate`, { method: 'POST', ...(options && { body: options }) }),
  getCurrentRecreate: (id) => request(`/projects/${id}/recreate/current`),
  downloadUrl: (id, recreateId, stack) => `/api/projects/${id}/recreate/${recreateId}/download${stack ? `?stack=${encodeURIComponent(stack)}` : ''}`,
  // Builds another stack from the saved recreate (no new capture): resolves when it is ready, rejects with why it failed.
  exportStack: (id, recreateId, stack) => request(`/projects/${id}/recreate/${recreateId}/export`, { method: 'POST', body: { stack } }),
  // HEAD first: it plans the zip without streaming it, so a refusal comes back as a message.
  async checkDownload(id, recreateId, stack) {
    const res = await fetch(api.downloadUrl(id, recreateId, stack), { method: 'HEAD' });
    return res.ok ? null : res.headers.get('X-Download-Error') ?? `Download failed (${res.status}).`;
  },
  getRecreate: (id) => request(`/projects/${id}/recreate`),
  subscribeRecreate: (id, recreateId, handlers) => subscribe(`/api/projects/${id}/recreate/${recreateId}/events`, handlers),
  startReaudit: (id) => request(`/projects/${id}/reaudit`, { method: 'POST' }),
  getCurrentReaudit: (id) => request(`/projects/${id}/reaudit/current`),
  subscribeReaudit: (id, reauditId, handlers) => subscribe(`/api/projects/${id}/reaudit/${reauditId}/events`, handlers),
  getPreview: (id) => request(`/projects/${id}/preview`),
  startPreview: (id) => request(`/projects/${id}/preview`, { method: 'POST' }),
};
