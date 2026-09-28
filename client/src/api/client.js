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

/**
 * Streams job progress (Analyze or Recreate) over SSE. Handlers: progress(job), done(job), failed(job).
 * Returns a function that closes the stream.
 */
function subscribe(url, { progress, done, failed }) {
  const source = new EventSource(url);
  const parse = (e) => JSON.parse(e.data);
  source.addEventListener('progress', (e) => progress?.(parse(e)));
  source.addEventListener('done', (e) => {
    source.close();
    done?.(parse(e));
  });
  source.addEventListener('failed', (e) => {
    source.close();
    failed?.(parse(e));
  });
  // Built-in connection error. While the stream is reconnecting, the server replays the job
  // state on reconnect; once the stream is closed for good, report it.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) failed?.({ status: 'failed', error: 'Lost connection to the server.' });
  };
  return () => source.close();
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
};
