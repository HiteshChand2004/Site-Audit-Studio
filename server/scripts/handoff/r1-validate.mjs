// Release 1 real-site validation through the app's own API (localhost:4000): homepage check -> exact copy -> re-audit.
// One site at a time (the server runs one job at a time). Restores each project's page_url afterwards.
const API = 'http://localhost:4000/api';
const SITES = [
  { name: 'nyaayai', id: '1f98e132-7f60-45d7-8110-704d790a210c', home: 'https://www.nyaayai.com/' },
  { name: 'parchaa', id: 'd5691f4f-8b64-4244-a561-d467db3fcb8c', home: 'https://www.parchaa.com/' },
  { name: 'flexibench', id: 'caa38f97-330d-401e-bec9-059a9c3635b2', home: 'https://www.flexibench.io/' },
];
const only = process.argv[2] ? process.argv[2].split(',') : null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const req = async (method, url, body) => {
  const res = await fetch(`${API}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(kind, id) {
  let last = '';
  for (;;) {
    const r = await req('GET', `/projects/${id}/${kind}/current`);
    const job = r.json?.job;
    if (!job) return null;
    const line = `${kind} ${job.status} ${job.step ?? ''} ${job.pct ?? ''}% ${job.message ?? ''}`.slice(0, 160);
    if (line !== last) { log(line); last = line; }
    if (['done', 'failed', 'error'].includes(job.status)) return job;
    await sleep(15000);
  }
}

for (const site of SITES.filter((s) => !only || only.includes(s.name))) {
  log(`=== ${site.name}`);
  const before = (await req('GET', `/projects/${site.id}`)).json;
  const project = before.project ?? before;
  const restore = project.page_url ?? null;
  if (project.page_url !== site.home) log('page_url ->', site.home, (await req('PATCH', `/projects/${site.id}`, { page_url: site.home })).status);
  try {
    const a = await req('POST', `/projects/${site.id}/analyze`, {});
    log('analyze', a.status, a.text.slice(0, 120));
    const aj = await waitJob('analyze', site.id);
    log('analyze end', aj?.status, aj?.error ?? '');
    const r = await req('POST', `/projects/${site.id}/recreate`, { exact: true });
    log('recreate', r.status, r.text.slice(0, 160));
    const rj = await waitJob('recreate', site.id);
    log('recreate end', rj?.status, rj?.error ?? '');
    await sleep(5000);
    const ra = await waitJob('reaudit', site.id);
    log('reaudit end', ra?.status ?? 'none', ra?.error ?? '');
  } catch (err) {
    log('ERROR', err.message);
  } finally {
    if (restore !== site.home) log('page_url restored', (await req('PATCH', `/projects/${site.id}`, { page_url: restore })).status);
  }
}
log('all done');
