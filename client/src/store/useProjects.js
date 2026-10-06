import { create } from 'zustand';
import { api } from '../api/client.js';

const LAST_KEY = 'wa:lastProject';

function remember(id) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

function recall() {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

// Open SSE streams, keyed by "<kind>:<projectId>". Kept outside the store: they are not render state.
const streams = new Map();

function closeStream(kind, projectId) {
  const key = `${kind}:${projectId}`;
  streams.get(key)?.close();
  streams.delete(key);
}

// Background job kinds: where their state lives in the store and how they are reached.
const KINDS = {
  analysis: { stateKey: 'analyses', subscribe: api.subscribeAnalysis, current: api.getCurrentAnalysis, failed: 'Analysis failed.' },
  recreate: { stateKey: 'recreates', subscribe: api.subscribeRecreate, current: api.getCurrentRecreate, failed: 'Recreate failed.' },
  // The fix checklist: the recreated site audited again (queued by the server after every Recreate).
  reaudit: { stateKey: 'reaudits', subscribe: api.subscribeReaudit, current: api.getCurrentReaudit, failed: 'Re-audit failed.' },
};

export const isJobActive = (job) => Boolean(job) && ['starting', 'queued', 'running'].includes(job.status);
export const isAnalysisActive = isJobActive;

export const useProjects = create((set, get) => ({
  projects: [],
  loading: true,
  error: null,
  selectedId: null,
  audit: null,
  auditLoading: false,
  // projectId → { id, status, step, pct, message, error, steps }
  analyses: {},
  recreates: {},
  reaudits: {},
  // projectId → { last, result } from GET /recreate
  recreateResults: {},
  // projectId → { url, port, recreateId, loading, error }: the preview of the latest recreate.
  // Only one preview runs at a time, so it follows the selected project.
  previews: {},

  setJob(kind, projectId, patch) {
    const key = KINDS[kind].stateKey;
    const current = get()[key][projectId] ?? {};
    set({ [key]: { ...get()[key], [projectId]: { ...current, ...patch } } });
  },

  setAnalysis(projectId, patch) {
    get().setJob('analysis', projectId, patch);
  },

  async load() {
    try {
      const projects = await api.listProjects();
      set({ projects, loading: false, error: null });
      const last = recall();
      const initial = projects.find((p) => p.id === last) ?? projects[0];
      if (initial) get().select(initial.id);
    } catch (err) {
      set({ loading: false, error: err.message });
    }
  },

  async select(id) {
    if (get().selectedId === id && get().audit) return;
    set({ selectedId: id, audit: null, auditLoading: true });
    remember(id);
    await Promise.all([get().reloadAudit(id), get().reloadRecreate(id)]);
    // Reattach to jobs that are still running (after a reload or a project switch).
    for (const kind of Object.keys(KINDS)) {
      if (streams.has(`${kind}:${id}`)) continue;
      const current = await KINDS[kind].current(id).catch(() => null);
      if (current) get().attachJob(kind, id, current.job, current.steps);
    }
  },

  async reloadRecreate(id) {
    const data = await api.getRecreate(id).catch(() => null);
    if (data) set({ recreateResults: { ...get().recreateResults, [id]: data } });
    if (data?.result && get().selectedId === id) await get().ensurePreview(id);
  },

  setPreview(id, patch) {
    set({ previews: { ...get().previews, [id]: { ...get().previews[id], ...patch } } });
  },

  /** Starts (or finds) the preview server of the project's latest recreate. */
  async ensurePreview(id) {
    get().setPreview(id, { loading: true, error: null });
    try {
      const { preview } = await api.startPreview(id);
      get().setPreview(id, { ...preview, loading: false });
    } catch (err) {
      get().setPreview(id, { url: null, loading: false, error: err.message });
    }
  },

  async reloadAudit(id) {
    try {
      const audit = await api.getAudit(id);
      if (get().selectedId === id) set({ audit, auditLoading: false });
    } catch (err) {
      if (get().selectedId === id) set({ auditLoading: false, error: err.message });
    }
  },

  attachJob(kind, projectId, job, steps) {
    const { stateKey, subscribe, failed: failedMessage } = KINDS[kind];
    closeStream(kind, projectId);
    get().setJob(kind, projectId, { ...job, steps: steps ?? get()[stateKey][projectId]?.steps ?? [] });
    const close = subscribe(projectId, job.id, {
      progress: (data) => get().setJob(kind, projectId, { ...data, reconnecting: false }),
      // The stream dropped and is reconnecting (shown as a note, not an error).
      reconnecting: (on) => get().setJob(kind, projectId, { reconnecting: on }),
      done: async (data) => {
        streams.delete(`${kind}:${projectId}`);
        get().setJob(kind, projectId, { ...data, status: 'done', pct: 100 });
        if (kind === 'recreate') {
          await get().reloadRecreate(projectId);
          // The server queues a re-audit of the new site: follow it (and show the checklist as stale meanwhile).
          await get().followReaudit(projectId);
        }
        if (kind !== 'recreate' && get().selectedId === projectId) await get().reloadAudit(projectId);
      },
      failed: (data) => {
        streams.delete(`${kind}:${projectId}`);
        get().setJob(kind, projectId, { status: 'failed', error: data.error || failedMessage });
        if (kind === 'recreate') get().reloadRecreate(projectId);
        if (kind === 'reaudit' && get().selectedId === projectId) get().reloadAudit(projectId);
      },
    });
    streams.set(`${kind}:${projectId}`, { close });
  },

  attach(projectId, job, steps) {
    get().attachJob('analysis', projectId, job, steps);
  },

  async analyze(id, url) {
    const project = get().projects.find((p) => p.id === id);
    get().setAnalysis(id, { status: 'starting', pct: 0, step: null, error: null, message: 'Starting…' });
    try {
      if (project && url && url.trim() !== project.url) await get().update(id, { url });
      const { job, steps } = await api.startAnalyze(id);
      get().attach(id, job, steps);
    } catch (err) {
      // Already running (another tab, or before a reload): follow that job instead.
      if (err.status === 409 && err.data?.analysisId) {
        const current = await api.getCurrentAnalysis(id).catch(() => null);
        if (current) return get().attach(id, current.job, current.steps);
      }
      get().setAnalysis(id, { status: 'failed', error: err.message });
    }
  },

  /** @param {{ reuseCapture?: boolean }} [options]  reuseCapture: rebuild from the last capture, without opening the site */
  async recreate(id, options = null) {
    get().setJob('recreate', id, { status: 'starting', pct: 0, step: null, error: null, message: 'Starting…' });
    try {
      const { job, steps } = await api.startRecreate(id, options);
      get().attachJob('recreate', id, job, steps);
    } catch (err) {
      if (err.status === 409 && err.data?.recreateId) {
        const current = await api.getCurrentRecreate(id).catch(() => null);
        if (current) return get().attachJob('recreate', id, current.job, current.steps);
      }
      get().setJob('recreate', id, { status: 'failed', error: err.message });
    }
  },

  /** Attaches to the project's queued or running re-audit, if any. */
  async followReaudit(id) {
    const current = await api.getCurrentReaudit(id).catch(() => null);
    if (current) get().attachJob('reaudit', id, current.job, current.steps);
    if (get().selectedId === id) await get().reloadAudit(id);
  },

  async reaudit(id) {
    get().setJob('reaudit', id, { status: 'starting', pct: 0, step: null, error: null, message: 'Starting…' });
    try {
      const { job, steps } = await api.startReaudit(id);
      get().attachJob('reaudit', id, job, steps);
    } catch (err) {
      if (err.status === 409 && err.data?.reauditId) {
        const current = await api.getCurrentReaudit(id).catch(() => null);
        if (current) return get().attachJob('reaudit', id, current.job, current.steps);
      }
      get().setJob('reaudit', id, { status: 'failed', error: err.message });
    }
  },

  dismissJob(kind, id) {
    const key = KINDS[kind].stateKey;
    const { [id]: _, ...rest } = get()[key];
    set({ [key]: rest });
  },

  dismissAnalysis(id) {
    get().dismissJob('analysis', id);
  },

  async create(input) {
    const project = await api.createProject(input);
    set({ projects: [project, ...get().projects] });
    await get().select(project.id);
    return project;
  },

  async update(id, patch) {
    const updated = await api.updateProject(id, patch);
    set({ projects: get().projects.map((p) => (p.id === id ? updated : p)) });
    return updated;
  },

  async remove(id) {
    await api.deleteProject(id);
    for (const kind of Object.keys(KINDS)) {
      closeStream(kind, id);
      get().dismissJob(kind, id);
    }
    const projects = get().projects.filter((p) => p.id !== id);
    set({ projects });
    if (get().selectedId === id) {
      set({ selectedId: null, audit: null });
      remember(null);
      if (projects[0]) get().select(projects[0].id);
    }
  },
}));

export const useSelectedProject = () =>
  useProjects((s) => s.projects.find((p) => p.id === s.selectedId) ?? null);
