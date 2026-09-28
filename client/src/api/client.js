async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: input }),
  updateProject: (id, patch) => request(`/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getAudit: (id) => request(`/projects/${id}/audit`),
};
