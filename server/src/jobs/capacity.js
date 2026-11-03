// @ts-check
// What this machine (or this container) can hold right now, for the job line (jobs/manager.js): CPUs, the memory jobs may use
// in all, the memory available this moment, and what one job of each kind is counted with. Every number is read at call time,
// host-agnostic, and can be replaced in tests (`capacity.read`).
//
// Containers: os.freemem() and os.totalmem() report the HOST, not the container's limit (docs/DEPLOY-TOOL.md), so the cgroup's
// own files are read when they exist (v2: memory.max / memory.current / cpu.max; v1: memory.limit_in_bytes / usage_in_bytes /
// cpu.cfs_quota_us / cpu.cfs_period_us) and the smaller answer wins.
//
//   SAS_RESERVED_MB        memory left to everything that is not a job: the OS, the API process itself, a proxy, a marketing
//                          site (default 1024).
//   SAS_JOB_MB_ANALYZE     memory one job of that kind is counted with, in MB. Measured: an Analyze took ~1.1–1.3 GB (the
//   SAS_JOB_MB_RECREATE    parallel test of 2026-10-30), an as-is copy + its re-audit ~2.2 GB (2026-10-24), a stack build
//   SAS_JOB_MB_REAUDIT     0.3–0.4 GB. Defaults 1500 / 2500 / 2000 / 800.
//   SAS_JOB_MB_EXPORT
//   SAS_JOB_CPUS           CPU threads one job is counted with (default 2): a capture keeps about that many busy at its peak.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { memory, setting } from './limits.js';

const MB = 1024 * 1024;
const CGROUP = '/sys/fs/cgroup';

/** Kinds of work the line knows, by the manager's table (an export has no table). */
export const KIND_OF_TABLE = { analyses: 'analyze', recreates: 'recreate', reaudits: 'reaudit' };
const KIND_MB = { analyze: 1500, recreate: 2500, reaudit: 2000, export: 800 };

/** Memory one job of a kind is counted with, in MB (SAS_JOB_MB_<KIND>, 100–65536). */
export function jobMB(kind, env = process.env) {
  const def = KIND_MB[kind] ?? KIND_MB.recreate;
  return setting(env[`SAS_JOB_MB_${String(kind).toUpperCase()}`], { min: 100, max: 65536, def });
}
/** CPU threads one job is counted with (SAS_JOB_CPUS, 0.5–64). */
export const jobCpus = (env = process.env) => setting(env.SAS_JOB_CPUS, { min: 0.5, max: 64, def: 2, integer: false });
/** Memory kept for everything that is not a job (SAS_RESERVED_MB, 0–1048576). */
export const reservedMB = (env = process.env) => setting(env.SAS_RESERVED_MB, { min: 0, max: 1048576, def: 1024 });

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};
const num = (text) => {
  if (text == null || text === '' || text === 'max') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
// cgroup v1 reports "no limit" as a huge number (PAGE_COUNTER_MAX, ~9.2e18): anything beyond 1 PB is no limit.
const realLimit = (bytes) => (bytes != null && bytes < 2 ** 50 ? bytes : null);

/**
 * The container's limits, from the cgroup files (null where there is none). `read` is the file reader (tests pass a map).
 * @param {(file: string) => string | null} [read]
 * @returns {{ version: 1 | 2 | null, memLimitMB: number | null, memUsedMB: number | null, cpus: number | null }}
 */
export function readCgroup(read = readText) {
  // v2: one unified hierarchy; the process's own group is the root of the namespace inside a container.
  const max2 = read(`${CGROUP}/memory.max`);
  const cpu2 = read(`${CGROUP}/cpu.max`);
  if (max2 != null || cpu2 != null) {
    const limit = realLimit(num(max2));
    const used = num(read(`${CGROUP}/memory.current`));
    const [quota, period] = (cpu2 ?? '').split(/\s+/);
    const q = num(quota);
    const p = num(period);
    return {
      version: 2,
      memLimitMB: limit != null ? limit / MB : null,
      memUsedMB: limit != null && used != null ? used / MB : null,
      cpus: q != null && p ? q / p : null,
    };
  }
  const max1 = read(`${CGROUP}/memory/memory.limit_in_bytes`);
  const quota1 = read(`${CGROUP}/cpu/cpu.cfs_quota_us`) ?? read(`${CGROUP}/cpu,cpuacct/cpu.cfs_quota_us`);
  if (max1 != null || quota1 != null) {
    const limit = realLimit(num(max1));
    const used = num(read(`${CGROUP}/memory/memory.usage_in_bytes`));
    const q = Number(quota1); // -1 = no quota
    const p = num(read(`${CGROUP}/cpu/cpu.cfs_period_us`) ?? read(`${CGROUP}/cpu,cpuacct/cpu.cfs_period_us`));
    return {
      version: 1,
      memLimitMB: limit != null ? limit / MB : null,
      memUsedMB: limit != null && used != null ? used / MB : null,
      cpus: q > 0 && p ? q / p : null,
    };
  }
  return { version: null, memLimitMB: null, memUsedMB: null, cpus: null };
}

/**
 * The machine as the job line sees it now.
 * @param {{ env?: object, cgroup?: ReturnType<typeof readCgroup>, hostCpus?: number, hostTotalMB?: number, hostFreeMB?: number }} [o]  overrides (tests)
 * @returns {{ cpus: number, totalMB: number, budgetMB: number, availableMB: number, source: 'cgroup' | 'host' }}
 *   budgetMB: memory all jobs together may be counted with (total minus SAS_RESERVED_MB); availableMB: what can be used this
 *   moment without swapping (Infinity where the OS cannot say, macOS)
 */
function readCapacity({
  env = process.env,
  cgroup = process.platform === 'linux' ? readCgroup() : readCgroup(() => null),
  hostCpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  hostTotalMB = os.totalmem() / MB,
  // The same reader as the memory gate (jobs/limits.js `memory.free`, which tests replace).
  hostFreeMB = memory.free(),
} = {}) {
  const limited = cgroup.memLimitMB != null && cgroup.memLimitMB < hostTotalMB;
  const totalMB = limited ? cgroup.memLimitMB : hostTotalMB;
  const cgroupFree = limited && cgroup.memUsedMB != null ? Math.max(0, cgroup.memLimitMB - cgroup.memUsedMB) : Infinity;
  const availableMB = Math.min(hostFreeMB, cgroupFree);
  const cpus = Math.max(1, cgroup.cpus != null ? Math.min(hostCpus, cgroup.cpus) : hostCpus);
  return {
    cpus,
    totalMB: Math.round(totalMB),
    budgetMB: Math.max(0, Math.round(totalMB - reservedMB(env))),
    availableMB,
    source: limited || cgroup.cpus != null ? 'cgroup' : 'host',
  };
}

/** The reader the job line and the jobs use; tests replace `read`. */
export const capacity = { read: readCapacity };
