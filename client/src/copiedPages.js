// The pages a finished copy holds, for the counts the app shows ("3 pages copied", "3 pages side by side", the outcome).
// A copy made from the site lists them in `pages` (its capture). A copy packaged again from a kept copy, in another stack or
// the same one, ran no capture: a report saved before the server filled `pages` for it has them only in its output.
export function copiedPages(result) {
  if (!result) return [];
  if (result.pages?.length) return result.pages;
  const output = result.outputs?.[result.stack];
  if (output?.pages?.length) return output.pages;
  return result.asIs?.pages ?? result.copy?.pages ?? [];
}
