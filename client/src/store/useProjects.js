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

// Open SSE streams, keyed by project id. Kept outside the store: they are not render state.
const streams = new Map();

function closeStream(projectId) {
  streams.get(projectId)?.close();
  streams.delete(projectId);
}

export const isAnalysisActive = (a) => Boolean(a) && ['starting', 'queued', 'running'].includes(a.status);

export const useProjects = create((set, get) => ({
  projects: [],
  loading: true,
  error: null,
  selectedId: null,
  audit: null,
  auditLoading: false,
  // projectId → { id, status, step, pct, message, error, steps }
  analyses: {},

  setAnalysis(projectId, patch) {
    const current = get().analyses[projectId] ?? {};
    set({ analyses: { ...get().analyses, [projectId]: { ...current, ...patch } } });
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
    await get().reloadAudit(id);
    // Reattach to an analysis that is still running (after a reload or a project switch).
    if (!streams.has(id)) {
      const current = await api.getCurrentAnalysis(id).catch(() => null);
      if (current) get().attach(id, current.job, current.steps);
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

  attach(projectId, job, steps) {
    closeStream(projectId);
    get().setAnalysis(projectId, { ...job, steps: steps ?? get().analyses[projectId]?.steps ?? [] });
    const close = api.subscribeAnalysis(projectId, job.id, {
      progress: (data) => get().setAnalysis(projectId, data),
      done: async (data) => {
        streams.delete(projectId);
        get().setAnalysis(projectId, { ...data, status: 'done', pct: 100 });
        if (get().selectedId === projectId) await get().reloadAudit(projectId);
      },
      failed: (data) => {
        streams.delete(projectId);
        get().setAnalysis(projectId, { status: 'failed', error: data.error || 'Analysis failed.' });
      },
    });
    streams.set(projectId, { close });
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

  dismissAnalysis(id) {
    const { [id]: _, ...rest } = get().analyses;
    set({ analyses: rest });
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
    closeStream(id);
    const projects = get().projects.filter((p) => p.id !== id);
    set({ projects });
    get().dismissAnalysis(id);
    if (get().selectedId === id) {
      set({ selectedId: null, audit: null });
      remember(null);
      if (projects[0]) get().select(projects[0].id);
    }
  },
}));

export const useSelectedProject = () =>
  useProjects((s) => s.projects.find((p) => p.id === s.selectedId) ?? null);
