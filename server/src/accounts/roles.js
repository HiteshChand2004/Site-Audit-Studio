// @ts-check
// Who may use the owner-only options: what the app hides under "Advanced options" and enforces here, on the REQUEST — a clean
// rebuild, an exact copy, a run with no time limit, "preserve" outside "Copy my site", a rebuild from a saved capture, another
// stack built from a saved IR, and the settings that change how a copy is made (exact mode, a page count). Ordinary users keep
// "Copy my site" (an as-is copy, its stack choice, its pages, its optional address), continuing a stopped copy, and packaging the
// same lifted copy again ("Rebuild from the last visit").
//
// The check reads the request only. The engines decide nothing by role: recreate/index.js runs the clean, exact and as-is
// pipelines from the payload its caller gives it, for the route, for autoResume (recreate/jobs.js) and for the per-page fallback to
// come (copy/run.js checkPage → deps.rebuildClean / deps.correct), which will call them in-process for every user's copy.
//
// Accounts off (SAS_ACCOUNTS unset): there is no req.user and no roles, the single-user local tool, everyone is the owner. A
// production server refuses to start with accounts off (config/index.js startupProblems), so hosted, this is always a real check
// of users.role, which only db/migrations.js (SAS_OWNER_EMAIL) sets to 'owner'.

/** @param {import('express').Request} req */
export function isOwner(req) {
  const user = /** @type {any} */ (req).user;
  return !user || user.role === 'owner';
}

/**
 * The 403 for a non-owner asking for an owner-only option. `forbidden: 'owner'` (not `auth`, which sends the app to sign-in).
 * @param {import('express').Response} res
 * @param {string} what  the option in words, e.g. "a clean rebuild"
 */
export function refuseNonOwner(res, what) {
  return res.status(403).json({ error: `Only the owner can use ${what}. Use “Copy my site” instead.`, forbidden: 'owner' });
}
