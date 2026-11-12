import { apiUrl, goToSignIn } from './base.js';

// The app's own server (the API) is off: shown as is, so it names what to run.
const API_DOWN = 'The app cannot reach its server: it is not running. Start it again (npm run local, or npm run dev), then try again.';

/** True when a request failed because the API is not running (no answer, or the dev proxy's empty 5xx), not because it refused. */
export const isApiDown = (err) => err?.apiDown === true;

/**
 * With accounts on, a request the API refuses for want of a (verified) session carries `auth: 'signin' | 'verify'`: the
 * visitor is sent to the sign-in page, coming back here after. True when that happened.
 */
function signInIfAsked(res, data) {
  if ((res.status === 401 || res.status === 403) && (data?.auth === 'signin' || data?.auth === 'verify')) {
    goToSignIn(data.auth);
    return true;
  }
  return false;
}

// file: a File sent as it is (its own type), in place of a JSON body.
async function request(path, { method = 'GET', body, file } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: file ? { 'Content-Type': file.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : undefined,
      body: file ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw Object.assign(new Error(API_DOWN), { status: 0, apiDown: true });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    signInIfAsked(res, data);
    // The Vite dev proxy answers 5xx without a JSON body when the API server is not running.
    const message = data?.error || (res.status >= 500 && !data ? API_DOWN : `Request failed (${res.status})`);
    const err = new Error(message);
    err.status = res.status;
    if (message === API_DOWN) err.apiDown = true;
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

// The browser opens at most 6 connections to one address (HTTP/1.1), shared by every tab of the app, and a live stream holds
// one for as long as its job runs or waits in the queue: with a few copies queued and two tabs open they were all taken, and
// every other request (a website's check, its copy) waited for ever. So a tab keeps LIVE_STREAMS jobs on a live stream; any
// other job is followed by short reads of the same stream (the server sends the job's current state first), one every
// POLL_MS, each holding a connection for a moment only. A job waiting for a live slot gets it when one frees.
const LIVE_STREAMS = 1;
const POLL_MS = 2500;
const READ_LIMIT_MS = 10000;
let liveCount = 0;
const waitingForLive = new Set();

/**
 * Follows job progress (Analyze, Recreate or Re-audit) over SSE. Handlers: progress(job), done(job),
 * failed(job), reconnecting(boolean). Returns a function that stops following it.
 *
 * A dropped connection (API server restarting, proxy error, network blip, a silent stream) is not
 * an error: the stream reconnects with backoff for up to 2 minutes and the server replays the job's
 * current state on connect (or its final state, if it ended meanwhile). Only then is the job
 * reported lost. The same holds for a job followed by short reads.
 */
function subscribe(url, { progress, done, failed, reconnecting }) {
  const parse = (e) => JSON.parse(e.data);
  let source = null;
  let timer = null;
  let watchdog = null;
  let closed = false;
  let live = false;
  let attempt = 0;
  let downSince = null;
  const sub = {};
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    source?.close();
    source = null;
    waitingForLive.delete(sub);
    if (live) {
      live = false;
      liveCount -= 1;
      waitingForLive.values().next().value?.promote();
    }
  };
  const ended = (handler) => (e) => {
    stop();
    handler?.(parse(e));
  };
  const ok = () => {
    if (downSince != null) reconnecting?.(false);
    attempt = 0;
    downSince = null;
  };
  // Not reachable just now: shown as reconnecting, and given up after RECONNECT_FOR_MS. False once given up.
  const trouble = () => {
    if (downSince == null) {
      downSince = Date.now();
      reconnecting?.(true);
    }
    if (Date.now() - downSince <= RECONNECT_FOR_MS) return true;
    stop();
    failed?.({ status: 'failed', error: 'Lost connection to the server. Reload the page to see the latest state.' });
    return false;
  };

  const alive = () => {
    ok();
    clearTimeout(watchdog);
    watchdog = setTimeout(() => drop(true), SILENT_MS);
  };
  // force: reopen ourselves even while the browser would keep retrying (a silent stream).
  const drop = (force) => {
    if (closed) return;
    // CONNECTING: the browser retries on its own. CLOSED: the server or proxy answered with an
    // error (for example while the API restarts); retry ourselves.
    if (!force && source.readyState !== EventSource.CLOSED) {
      if (downSince == null) trouble();
      return;
    }
    source.close();
    clearTimeout(watchdog);
    if (!trouble()) return;
    timer = setTimeout(openLive, Math.min(1000 * 2 ** attempt++, RECONNECT_MAX_DELAY_MS));
  };

  const openLive = () => {
    source = new EventSource(url);
    clearTimeout(watchdog);
    watchdog = setTimeout(() => drop(true), SILENT_MS);
    source.addEventListener('open', alive);
    source.addEventListener('ping', alive);
    source.addEventListener('progress', (e) => {
      alive();
      progress?.(parse(e));
    });
    source.addEventListener('done', ended(done));
    source.addEventListener('failed', ended(failed));
    source.onerror = () => drop(false);
  };

  // One short read: the state the server sends first, then the connection is closed again. A job that has ended is sent
  // as its progress and then done / failed, so those are waited for.
  const read = () => {
    if (closed || live) return;
    const s = new EventSource(url);
    source = s;
    const current = () => source === s && !closed;
    const next = () => {
      clearTimeout(limit);
      s.close();
      if (current()) timer = setTimeout(read, POLL_MS);
    };
    const limit = setTimeout(() => {
      if (current() && trouble()) next();
    }, READ_LIMIT_MS);
    s.addEventListener('progress', (e) => {
      if (!current()) return;
      ok();
      const job = parse(e);
      progress?.(job);
      if (job.status !== 'done' && job.status !== 'failed') next();
    });
    s.addEventListener('done', (e) => current() && (clearTimeout(limit), ended(done)(e)));
    s.addEventListener('failed', (e) => current() && (clearTimeout(limit), ended(failed)(e)));
    s.onerror = () => {
      if (current() && trouble()) next();
    };
  };

  sub.promote = () => {
    if (closed || live) return;
    waitingForLive.delete(sub);
    live = true;
    liveCount += 1;
    clearTimeout(timer);
    source?.close();
    openLive();
  };
  if (liveCount < LIVE_STREAMS) sub.promote();
  else {
    waitingForLive.add(sub);
    read();
  }
  return stop;
}

// The report comes back as text (HTML or JSON), not as the JSON the other calls return.
async function requestText(path) {
  let res;
  try {
    res = await fetch(apiUrl(path));
  } catch {
    throw Object.assign(new Error(API_DOWN), { status: 0, apiDown: true });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    signInIfAsked(res, data);
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
      res = await fetch(apiUrl(`/projects/${id}/report?format=pdf`));
    } catch {
      throw Object.assign(new Error(API_DOWN), { status: 0, apiDown: true });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      signInIfAsked(res, data);
      throw new Error(data?.error || (res.status >= 500 ? 'The PDF could not be built.' : `Request failed (${res.status})`));
    }
    return res.blob();
  },
  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: input }),
  updateProject: (id, patch) => request(`/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getAudit: (id) => request(`/projects/${id}/audit`),
  // Every page of the site the app has seen (for the "One page" picker): { pages: [{ path, url }], pageUrl }.
  getPages: (id) => request(`/projects/${id}/pages`),
  startAnalyze: (id, body = {}) => request(`/projects/${id}/analyze`, { method: 'POST', body }),
  getCurrentAnalysis: (id) => request(`/projects/${id}/analyze/current`),
  subscribeAnalysis: (id, analysisId, handlers) => subscribe(apiUrl(`/projects/${id}/analyze/${analysisId}/events`), handlers),
  // { reuseCapture: true }: rebuild from the last capture (the site is not opened again).
  startRecreate: (id, options = null) => request(`/projects/${id}/recreate`, { method: 'POST', ...(options && { body: options }) }),
  // The preview of an original as-is copy: its own address on this machine (never the app's origin).
  // The new site's address written into a finished "Copy my site" copy, at download (a new job; files only, no page changes).
  addAddress: (id, recreateId, address) => request(`/projects/${id}/recreate`, {
    method: 'POST', body: { mode: 'as-is', confirmed: true, addressOnly: true, recreateId, addressConfirmed: address },
  }),
  // Whether the original answers right now (a site that is down draws a blank live frame).
  siteAnswers: (id, url) => request(`/projects/${id}/live?url=${encodeURIComponent(url)}`),
  startAsIsPreview: (id, recreateId) => request(`/projects/${id}/recreate/${recreateId}/asis-preview`, { method: 'POST' }),
  getCurrentRecreate: (id) => request(`/projects/${id}/recreate/current`),
  downloadUrl: (id, recreateId, stack) => apiUrl(`/projects/${id}/recreate/${recreateId}/download${stack ? `?stack=${encodeURIComponent(stack)}` : ''}`),
  // Builds another stack from the saved recreate (no new capture): resolves when it is ready, rejects with why it failed.
  exportStack: (id, recreateId, stack) => request(`/projects/${id}/recreate/${recreateId}/export`, { method: 'POST', body: { stack } }),
  // HEAD first: it plans the zip without streaming it, so a refusal comes back as a message.
  async checkDownload(id, recreateId, stack) {
    const res = await fetch(api.downloadUrl(id, recreateId, stack), { method: 'HEAD' });
    return res.ok ? null : res.headers.get('X-Download-Error') ?? `Download failed (${res.status}).`;
  },
  getRecreate: (id) => request(`/projects/${id}/recreate`),
  stopRecreate: (id) => request(`/projects/${id}/recreate/stop`, { method: 'POST' }),
  subscribeRecreate: (id, recreateId, handlers) => subscribe(apiUrl(`/projects/${id}/recreate/${recreateId}/events`), handlers),
  startReaudit: (id) => request(`/projects/${id}/reaudit`, { method: 'POST' }),
  getCurrentReaudit: (id) => request(`/projects/${id}/reaudit/current`),
  subscribeReaudit: (id, reauditId, handlers) => subscribe(apiUrl(`/projects/${id}/reaudit/${reauditId}/events`), handlers),
  getPreview: (id) => request(`/projects/${id}/preview`),
  startPreview: (id) => request(`/projects/${id}/preview`, { method: 'POST' }),

  // Build mode (server/src/buildmode): the playbook library, a plan (two model calls), and the prompt again from an edited brief.
  getBuildModules: () => request('/build/modules'),
  planBuild: (body) => request('/build/plan', { method: 'POST', body }),
  composeBuild: (body) => request('/build/compose', { method: 'POST', body }),
  // Building the site from a confirmed plan (server/src/buildmode/builds.js): start, follow, stop, download.
  startBuild: (body) => request('/build/runs', { method: 'POST', body }),
  getBuild: (id) => request(`/build/runs/${id}`),
  stopBuild: (id) => request(`/build/runs/${id}/stop`, { method: 'POST' }),
  buildDownloadUrl: (id) => apiUrl(`/build/runs/${id}/download`),
  // After the build, without the AI (server/src/buildmode/edit.js, publish.js): the site's words, a change, the share link.
  getBuildTexts: (id) => request(`/build/runs/${id}/texts`),
  editBuild: (id, body) => request(`/build/runs/${id}/edits`, { method: 'POST', body }),
  publishBuild: (id) => request(`/build/runs/${id}/publish`, { method: 'POST' }),
  unpublishBuild: (id) => request(`/build/runs/${id}/publish`, { method: 'DELETE' }),
  // Saved sites (server/src/buildmode/sites.js): the app's state of each site, kept on the server, with the builds made from it.
  listBuildSites: () => request('/build/sites'),
  getBuildSite: (id) => request(`/build/sites/${id}`),
  createBuildSite: (state) => request('/build/sites', { method: 'POST', body: { state } }),
  saveBuildSite: (id, state) => request(`/build/sites/${id}`, { method: 'PUT', body: { state } }),
  deleteBuildSite: (id) => request(`/build/sites/${id}`, { method: 'DELETE' }),
  // The owner's photos and logo of a saved site (server/src/buildmode/images.js): stored beside it, never in its state.
  listBuildImages: (siteId) => request(`/build/sites/${siteId}/images`),
  uploadBuildImage: (siteId, file, role) => request(`/build/sites/${siteId}/images?role=${role === 'logo' ? 'logo' : 'photo'}`, { method: 'POST', file }),
  deleteBuildImage: (siteId, imageId) => request(`/build/sites/${siteId}/images/${imageId}`, { method: 'DELETE' }),
  buildImageUrl: (siteId, imageId) => apiUrl(`/build/sites/${siteId}/images/${imageId}/thumb`),

  // The signed-in account (accounts on). Resolves to null when the API runs without accounts (no /auth routes: 404).
  async getMe() {
    try {
      return (await request('/auth/me')).user;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  signOut: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
};
