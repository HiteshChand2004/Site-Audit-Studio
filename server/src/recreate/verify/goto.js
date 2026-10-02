// Opening a page of our own build in the local renderer. A stalled `load` (the machine is short of memory: several browsers
// at once) must not fail a whole Recreate - the pages are small local files - so a timeout gets one more try with twice the time.
export async function gotoLocal(page, url, timeout = 15000) {
  try {
    return await page.goto(url, { waitUntil: 'load', timeout });
  } catch (err) {
    if (!/timeout/i.test(String(err?.message))) throw err;
    return page.goto(url, { waitUntil: 'load', timeout: timeout * 2 });
  }
}
