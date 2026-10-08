// Switches of the speed-ups of the "Create the copy" pipeline (branch optimize-create-copy). Each one is on by default and
// changes only when or how many times work runs, never what is captured, compared or written. SAS_COPY_OPTIMIZE=0 turns
// them all off (the pipeline then runs the code paths it ran before them); SAS_COPY_OPT_<NAME>=0 turns off one:
//   IMAGE_CACHE   decoded screenshots of the original reused by every comparison of a job (verify/imageCache.js)
//   EQUIVALENCE   the stack's equivalence check renders pages side by side (verify/equivalence.js)
//   SWEEP         the original is screenshotted at the sweep widths several pages at once, starting while the capture
//                 still runs when a capture slot is idle (recreate/sweep.js, inspect.js)
//   STACK_REF     the stack build inside the job uses the job's own plain-HTML build as its reference when it is the
//                 same output (export/fromIr.js)
//   REFINE        the breakpoint / fluid type check renders its pages side by side (verify/refine.js)
export const OPTIMIZATIONS = ['IMAGE_CACHE', 'EQUIVALENCE', 'SWEEP', 'STACK_REF', 'REFINE'];

/** Is the speed-up `name` (one of OPTIMIZATIONS) on? */
export const optimized = (name, env = process.env) => env.SAS_COPY_OPTIMIZE !== '0' && env[`SAS_COPY_OPT_${name}`] !== '0';
