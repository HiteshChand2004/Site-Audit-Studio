// A link from Growth OS to a site it described in Build mode: /app/?buildSite=<id> (server/src/routes/ext.js POST /site-briefs).
// Taken before the app starts: Build mode is remembered as the last view and that saved site as the one to open, so the app
// opens it where Growth OS left it (an existing website, its live site, the description filled in), and the id leaves the URL
// so a reload does not take it again. Opening it is all this does: the owner still presses Continue to plan and build.
const ID = /^[0-9a-f-]{36}$/;

/** @param {{ location: Location, history: History, storage: Storage | null }} [env] */
export function takeBuildSiteLink(env = { location: window.location, history: window.history, storage: safeStorage() }) {
  let url;
  try {
    url = new URL(env.location.href);
  } catch {
    return null;
  }
  const id = (url.searchParams.get('buildSite') ?? '').trim().toLowerCase();
  if (!url.searchParams.has('buildSite')) return null;
  url.searchParams.delete('buildSite');
  env.history.replaceState(null, '', url.pathname + url.search + url.hash);
  if (!ID.test(id)) return null;
  try {
    env.storage?.setItem('wa:lastProject', 'build'); // useProjects.js: the last view, 'build' = Build mode
    env.storage?.setItem('wa:buildSite', id); // BuildMode.jsx: the saved site to open
  } catch {
    /* storage unavailable: Build mode's list of sites still shows it */
  }
  return id;
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
