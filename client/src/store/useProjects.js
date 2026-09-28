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

export const useProjects = create((set, get) => ({
  projects: [],
  loading: true,
  error: null,
  selectedId: null,
  audit: null,
  auditLoading: false,

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
    try {
      const audit = await api.getAudit(id);
      if (get().selectedId === id) set({ audit, auditLoading: false });
    } catch (err) {
      if (get().selectedId === id) set({ auditLoading: false, error: err.message });
    }
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
