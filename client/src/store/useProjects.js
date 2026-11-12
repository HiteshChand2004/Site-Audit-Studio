import { create } from 'zustand';
import { api, isApiDown } from '../api/client.js';
import { fromServerUrl } from '../api/base.js';

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

// The screenshots of an analysis are served under the project that owns them now (an imported project keeps the URLs it was
// saved with, which point at its old id).
function normalizeAudit(id, audit) {
  const views = audit?.screenshots?.views;
  if (!views) return audit;
  const fix = (shot) => (shot?.url ? { ...shot, url: fromServerUrl(shot.url.replace(/^\/api\/projects\/[^/]+\//, `/api/projects/${id}/`)) } : shot);
  const fixed = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v && { ...v, fold: fix(v.fold), full: fix(v.full) }]));
  return { ...audit, screenshots: { ...audit.screenshots, views: fixed } };
}

export const HOME = 'home';
// Build mode, remembered like a website so a reload comes back to it.
const BUILD = 'build';

export const isJobActive = (job) => Boolean(job) && ['starting', 'queued', 'running'].includes(job.status);
export const isAnalysisActive = isJobActive;

/**
 * A job that could not be started because the app's server is off: 'unreachable', not 'failed'. Nothing ran, so the website's
 * marks (the sidebar, the section tabs) keep the last result instead of showing a failure; the step says the server is off.
 */
const notStarted = (err) => ({ status: isApiDown(err) ? 'unreachable' : 'failed', error: err.message });

/**
 * Whether the person may use the owner-only options (the server's rule, accounts/roles.js, which it enforces on every request):
 * the owner role, or nobody signed in (accounts off: the single-user tool). Unknown until /auth/me answered → not yet.
 */
export const selectIsOwner = (s) => s.me === null || s.me?.role === 'owner';

const timeOf = (value) => {
  const t = value ? new Date(value).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

/**
 * The websites in the order of their work, as the sidebar lists them: one with a check, copy or comparison running first,
 * then the most recent work (a check finished, a copy started or finished, even a failed one, a comparison, the website
 * added or its settings changed). Pure over the store's state, so a caller memoizes it.
 */
export function orderByWork(s) {
  const busy = (id) => [s.analyses[id], s.recreates[id], s.reaudits[id]].some(isJobActive);
  const when = (p) => {
    const audit = (s.selectedId === p.id && s.audit) || s.overviews[p.id]?.audit;
    const copy = s.recreateResults[p.id] ?? s.overviews[p.id]?.recreate;
    const real = audit && !audit.isDummy;
    return Math.max(
      timeOf(real && audit.analyzedAt),
      timeOf(real && !audit.recreate?.isDummy && audit.recreate?.reauditedAt),
      timeOf(copy?.result?.createdAt),
      timeOf(copy?.last?.startedAt),
      timeOf(copy?.last?.finishedAt),
      timeOf(p.updated_at),
      timeOf(p.created_at),
    );
  };
  return s.projects
    .map((p) => ({ p, busy: busy(p.id), at: when(p) }))
    .sort((a, b) => Number(b.busy) - Number(a.busy) || b.at - a.at)
    .map((x) => x.p);
}

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
  // projectId → { audit, recreate, loaded }: what the home gallery and the sidebar show for every website.
  overviews: {},
  // The signed-in account: undefined until asked, null when the API has no accounts (then everyone is the owner), else { id, email, name, role, verified }.
  me: undefined,
  // Build mode is open (a new site from a description): the main area shows it instead of home or a website.
  building: false,

  /** Who is signed in (accounts on), or null (accounts off). Asked once at start; the account menu and the owner-only options read it. */
  async loadMe() {
    try {
      set({ me: await api.getMe() });
    } catch {
      // Not signed in or the API unreachable: the gate answers 401 and the app goes to the sign-in page; nothing to show here.
    }
  },

  setJob(kind, projectId, patch) {
    const key = KINDS[kind].stateKey;
    const current = get()[key][projectId] ?? {};
    set({ [key]: { ...get()[key], [projectId]: { ...current, ...patch } } });
  },

  setAnalysis(projectId, patch) {
    get().setJob('analysis', projectId, patch);
  },

  async load() {
    get().loadMe();
    try {
      const projects = await api.listProjects();
      set({ projects, loading: false, error: null });
      get().loadOverviews();
      // The last website opened, or the home overview (also when nothing was opened yet).
      const last = recall();
      const initial = projects.find((p) => p.id === last);
      if (initial) get().select(initial.id);
      else if (last === BUILD) get().openBuild();
    } catch (err) {
      set({ loading: false, error: err.message });
    }
  },

  /** The home overview: no website selected. */
  goHome() {
    set({ selectedId: null, audit: null, auditLoading: false, building: false });
    remember(HOME);
    get().loadOverviews();
  },

  /** Opens build mode: plan a new site, or changes to one, from a description. */
  openBuild() {
    set({ selectedId: null, audit: null, auditLoading: false, building: true });
    remember(BUILD);
  },

  /** Check + copy of every website, for the home gallery and the sidebar (read only). */
  async loadOverviews() {
    await Promise.all(get().projects.map((p) => get().loadOverview(p.id)));
  },

  async loadOverview(id) {
    // The website's running jobs too: after a reload the sidebar and the gallery show a check, copy or comparison that is under
    // way on a website that is not open (before, only opening it found them).
    const [audit, recreate] = await Promise.all([api.getAudit(id).catch(() => null), api.getRecreate(id).catch(() => null), get().followJobs(id)]);
    set({ overviews: { ...get().overviews, [id]: { audit: normalizeAudit(id, audit), recreate, loaded: true } } });
  },

  /**
   * Follows the website's check, copy and comparison that are queued or running (after a reload, a project switch, or a job
   * started in another tab), so its marks move whether or not it is open. A job already followed is left as it is.
   */
  async followJobs(id) {
    await Promise.all(
      Object.keys(KINDS).map(async (kind) => {
        if (streams.has(`${kind}:${id}`)) return;
        const current = await KINDS[kind].current(id).catch(() => null);
        // Asked again after the wait: opening the website and loading the overviews ask at the same time.
        if (current && !streams.has(`${kind}:${id}`)) get().attachJob(kind, id, current.job, current.steps);
      }),
    );
  },

  async select(id) {
    // Picking the open website again looks for newer work (a copy made or imported elsewhere).
    if (get().selectedId === id && get().audit) return get().refreshSelected();
    set({ selectedId: id, audit: null, auditLoading: true, building: false });
    remember(id);
    await Promise.all([get().reloadAudit(id), get().reloadRecreate(id)]);
    // Reattach to jobs that are still running (after a reload or a project switch).
    await get().followJobs(id);
  },

  /**
   * The open website's check and copy as the server has them now: a copy finished, imported or rebuilt
   * while this tab stayed open replaces the one shown (called when the tab comes back into view).
   */
  async refreshSelected() {
    const id = get().selectedId;
    if (!id) return;
    const [data, audit] = await Promise.all([api.getRecreate(id).catch(() => null), api.getAudit(id).catch(() => null)]);
    if (get().selectedId !== id) return;
    const known = get().recreateResults[id];
    const changed = (a, b) => (a?.result?.recreateId ?? null) !== (b?.result?.recreateId ?? null) || (a?.last?.id ?? null) !== (b?.last?.id ?? null) || (a?.last?.status ?? null) !== (b?.last?.status ?? null);
    if (data && changed(data, known)) {
      set({ recreateResults: { ...get().recreateResults, [id]: data } });
      if (data.result) await get().ensurePreview(id);
    } else if (data?.result) {
      // Only one preview runs at a time: another tab may have moved it to another website meanwhile.
      await get().ensurePreview(id);
    }
    const shown = get().audit;
    if (audit && (audit.analysisId !== shown?.analysisId || audit.recreate?.reauditId !== shown?.recreate?.reauditId || audit.recreate?.recreateId !== shown?.recreate?.recreateId)) {
      set({ audit: normalizeAudit(id, audit) });
    }
  },

  async reloadRecreate(id) {
    const data = await api.getRecreate(id).catch(() => null);
    if (data) set({ recreateResults: { ...get().recreateResults, [id]: data }, overviews: { ...get().overviews, [id]: { ...get().overviews[id], recreate: data } } });
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
      const audit = normalizeAudit(id, await api.getAudit(id));
      if (get().selectedId === id) set({ audit, auditLoading: false });
      set({ overviews: { ...get().overviews, [id]: { ...get().overviews[id], audit, loaded: true } } });
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
        // Also when another website is open now: the sidebar and the home gallery show this one's marks from its overview,
        // which reloadAudit refreshes (it only touches the open dashboard when this website is the one open).
        if (kind !== 'recreate') await get().reloadAudit(projectId);
      },
      failed: (data) => {
        streams.delete(`${kind}:${projectId}`);
        get().setJob(kind, projectId, { status: 'failed', error: data.error || failedMessage });
        // The latest attempt (its reason) is loaded, so the Create step shows why it failed and offers a new try.
        if (kind === 'recreate') get().reloadRecreate(projectId).catch(() => {});
        // A copy stopped by its time limit after getting further continues by itself (the server queues the next try):
        // follow it, so the progress goes on instead of showing the failure. Asked again shortly after: the server decides
        // that just after it reports the failure.
        if (kind === 'recreate') {
          get().reloadRecreate(projectId);
          setTimeout(() => get().followRecreate(projectId).then(() => get().reloadRecreate(projectId)), 2000);
        }
        if (kind === 'reaudit') get().reloadAudit(projectId);
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
      get().setAnalysis(id, notStarted(err));
    }
  },

  /** Attaches to the project's queued or running recreate, if any (e.g. one that continues a stopped copy by itself). */
  async followRecreate(id) {
    const current = await api.getCurrentRecreate(id).catch(() => null);
    if (current && !streams.has(`recreate:${id}`)) get().attachJob('recreate', id, current.job, current.steps);
  },

  /**
   * @param {{ reuseCapture?: boolean, resume?: boolean, exact?: boolean }} [options]  reuseCapture: rebuild from the last
   *   capture, without opening the site; resume: continue the copy that stopped, keeping what it had done
   *   (GET …/recreate `resumable`); exact: this one copy is an exact one (the project's own setting decides otherwise)
   */
  async recreate(id, options = null) {
    // The request is kept: a failed copy can be tried again with the same settings (the Create step's "Try again").
    set({ lastRecreateOptions: { ...get().lastRecreateOptions, [id]: options } });
    get().setJob('recreate', id, { status: 'starting', pct: 0, step: null, error: null, message: 'Starting…' });
    try {
      const { job, steps } = await api.startRecreate(id, options);
      get().attachJob('recreate', id, job, steps);
    } catch (err) {
      if (err.status === 409 && err.data?.recreateId) {
        const current = await api.getCurrentRecreate(id).catch(() => null);
        if (current) return get().attachJob('recreate', id, current.job, current.steps);
      }
      get().setJob('recreate', id, notStarted(err));
    }
  },

  /**
   * Writes the new site's address into a finished "Copy my site" copy (the download dialog). Unlike `recreate`, a refusal is
   * thrown back to the dialog, which shows it under the field; on success the job is followed like any copy.
   * @returns {Promise<string>} the new job's id
   */
  /** Fix mode: writes the approved changes into the finished copy (a short job, followed like any copy). */
  async applyFixes(id, recreateId, approved) {
    const { job, steps } = await api.applyFixes(id, recreateId, approved);
    get().attachJob('recreate', id, job, steps);
    return job.id;
  },

  async addAddress(id, recreateId, address) {
    const { job, steps } = await api.addAddress(id, recreateId, address);
    get().attachJob('recreate', id, job, steps);
    return job.id;
  },

  /**
   * Asks the copy that is running to stop. What it has done is kept, so the Copy step then offers to continue where it
   * stopped. The job's own SSE stream reports the end, so nothing is set here beyond the "Stopping…" message.
   */
  async stopRecreate(id) {
    try {
      const { job } = await api.stopRecreate(id);
      get().setJob('recreate', id, { status: job.status, message: job.message, pct: job.pct, step: job.step });
    } catch {
      // Already finished or stopped: its stream reports the real state.
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
      get().setJob('reaudit', id, notStarted(err));
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
    get().loadOverview(project.id);
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
    const before = orderByWork(get());
    set({ projects: get().projects.filter((p) => p.id !== id) });
    if (get().selectedId !== id) return;
    // The open website was deleted: the one after it in the list opens (the sidebar's order), or the one above when it was the
    // last; none left = home. Deleting another website leaves the open one as it is.
    const at = before.findIndex((p) => p.id === id);
    const next = before[at + 1] ?? before[at - 1] ?? null;
    set({ selectedId: null, audit: null });
    if (next) await get().select(next.id);
    else get().goHome();
  },
}));

export const useSelectedProject = () =>
  useProjects((s) => s.projects.find((p) => p.id === s.selectedId) ?? null);
