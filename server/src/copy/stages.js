// The stages of "Copy my site", in order (docs/COPY-MY-SITE.md §7). The progress view shows these names; the job maps its
// steps onto them.

export const COPY_STAGES = ['Capturing', 'Copying', 'Fixing', 'Packaging', 'Checking', 'Done'];

/**
 * The stage a job step belongs to. Unknown steps keep the stage they came after.
 * @param {string} step
 * @param {string} [current]
 */
export function stageOf(step, current = COPY_STAGES[0]) {
  const map = {
    inspect: 'Capturing',
    sweep: 'Capturing',
    assets: 'Copying',
    generate: 'Fixing',
    build: 'Packaging',
    preview: 'Packaging',
    responsive: 'Checking',
    reaudit: 'Checking',
    done: 'Done',
  };
  return map[step] ?? current;
}

/** Position of a stage (0-based) in COPY_STAGES; -1 if unknown. */
export function stageIndex(stage) {
  return COPY_STAGES.indexOf(stage);
}
