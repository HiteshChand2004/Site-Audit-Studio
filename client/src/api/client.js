async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Streams Analyze progress over SSE. Handlers: progress(job), done(job), failed(job).
 * Returns a function that closes the stream.
 */
function subscribeAnalysis(projectId, analysisId, { progress, done, failed }) {
  const source = new EventSource(`/api/projects/${projectId}/analyze/${analysisId}/events`);
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
  subscribeAnalysis,
};
