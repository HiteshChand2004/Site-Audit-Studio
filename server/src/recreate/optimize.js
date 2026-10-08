// Switches of the speed-ups of the "Create the copy" pipeline (branch optimize-create-copy). Each one is on by default and
// changes only when or how many times work runs, never what is captured, compared or written. SAS_COPY_OPTIMIZE=0 turns
// them all off (the pipeline then runs the code paths it ran before them); SAS_COPY_OPT_<NAME>=0 turns off one:
//   IMAGE_CACHE   decoded screenshots of the original reused by every comparison of a job (verify/imageCache.js)
//   EQUIVALENCE   the stack's equivalence check renders pages side by side (verify/equivalence.js)
//   SWEEP         the original is screenshotted at the sweep widths several pages at once (recreate/sweep.js)
//   STACK_REF     the stack build inside the job uses the job's own plain-HTML build as its reference when it is the
//                 same output (export/fromIr.js)
//   REFINE        the breakpoint / fluid type check renders its pages side by side (verify/refine.js)
//   IMAGES        responsive image files encoded several images at once (assets/variants.js)
//   STACK_EARLY   the chosen stack is built from the IR right after generate, next to the build step; only its check
//                 against the plain-HTML build waits for that step (recreate/index.js, stack.js)
export const OPTIMIZATIONS = ['IMAGE_CACHE', 'EQUIVALENCE', 'SWEEP', 'STACK_REF', 'REFINE', 'IMAGES', 'STACK_EARLY'];

/** Is the speed-up `name` (one of OPTIMIZATIONS) on? */
export const optimized = (name, env = process.env) => env.SAS_COPY_OPTIMIZE !== '0' && env[`SAS_COPY_OPT_${name}`] !== '0';

// Measured and left off by default, on only with SAS_COPY_OPT_<NAME>=1 (and never with SAS_COPY_OPTIMIZE=0):
//   SWEEP_EARLY   the capture hands each captured page to the sweep, which may use the capture slots left idle at the end of
//                 the capture. It saves time where the sweep is the longest step, but the sweep's page loads then run next to
//                 the last captures' timing-sensitive probes: on the fixture site the capture took 5–7 s longer and one scroll
//                 reveal was once sampled mid-fade.
export const OPT_IN = ['SWEEP_EARLY'];

/** Is the opt-in speed-up `name` (one of OPT_IN) turned on? */
export const optedIn = (name, env = process.env) => env.SAS_COPY_OPTIMIZE !== '0' && env[`SAS_COPY_OPT_${name}`] === '1';
