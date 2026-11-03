// What the job line sees of the machine (jobs/capacity.js): container limits read from the cgroup files (v1 and v2), the
// smaller of host and container winning, the memory budget for jobs, and what each kind of job is counted with. Pure: the cgroup
// files are a map, the host numbers are passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, jobCpus, jobMB, readCgroup, reservedMB } from '../src/jobs/capacity.js';

const GB = 1024 ** 3;
const files = (map) => (file) => (file in map ? String(map[file]) : null);

test('cgroup v2: memory limit, usage and CPU quota; "max" means no limit', () => {
  const limited = readCgroup(files({
    '/sys/fs/cgroup/memory.max': 8 * GB,
    '/sys/fs/cgroup/memory.current': 3 * GB,
    '/sys/fs/cgroup/cpu.max': '400000 100000',
  }));
  assert.deepEqual(limited, { version: 2, memLimitMB: 8192, memUsedMB: 3072, cpus: 4 });
  const open = readCgroup(files({ '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/cpu.max': 'max 100000' }));
  assert.deepEqual(open, { version: 2, memLimitMB: null, memUsedMB: null, cpus: null });
});

test('cgroup v1: the same from the v1 files; the huge "no limit" number and a -1 quota mean none', () => {
  const limited = readCgroup(files({
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': 6 * GB,
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': 1 * GB,
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': 250000,
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us': 100000,
  }));
  assert.deepEqual(limited, { version: 1, memLimitMB: 6144, memUsedMB: 1024, cpus: 2.5 });
  const open = readCgroup(files({
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': -1,
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us': 100000,
  }));
  assert.deepEqual(open, { version: 1, memLimitMB: null, memUsedMB: null, cpus: null });
  assert.deepEqual(readCgroup(files({})), { version: null, memLimitMB: null, memUsedMB: null, cpus: null }, 'no cgroup at all (Windows, macOS)');
});

test('the container wins over the host it runs on: budget, available memory and CPUs', () => {
  const env = {};
  // A 4 CPU / 8 GB container on a 32 thread / 64 GB host that has 40 GB free: os.* would report the host.
  const inBox = capacity.read({
    env,
    cgroup: { version: 2, memLimitMB: 8192, memUsedMB: 3072, cpus: 4 },
    hostCpus: 32,
    hostTotalMB: 65536,
    hostFreeMB: 40960,
  });
  assert.deepEqual(inBox, { cpus: 4, totalMB: 8192, budgetMB: 8192 - 1024, availableMB: 5120, source: 'cgroup' });
  // No container: the host, minus what is kept for everything that is not a job.
  const host = capacity.read({ env, cgroup: { version: null, memLimitMB: null, memUsedMB: null, cpus: null }, hostCpus: 12, hostTotalMB: 15134, hostFreeMB: 4000 });
  assert.deepEqual(host, { cpus: 12, totalMB: 15134, budgetMB: 15134 - 1024, availableMB: 4000, source: 'host' });
  // A container limit above the host's memory is no limit; macOS's "unknown" free memory stays unknown.
  const loose = capacity.read({ env, cgroup: { version: 2, memLimitMB: 1e9, memUsedMB: 10, cpus: null }, hostCpus: 8, hostTotalMB: 16384, hostFreeMB: Infinity });
  assert.equal(loose.totalMB, 16384);
  assert.equal(loose.availableMB, Infinity);
  assert.equal(loose.source, 'host');
});

test('what a job is counted with: measured defaults per kind, each a setting; out of range = default', () => {
  assert.equal(jobMB('analyze', {}), 1500);
  assert.equal(jobMB('recreate', {}), 2500);
  assert.equal(jobMB('reaudit', {}), 2000);
  assert.equal(jobMB('export', {}), 800);
  assert.equal(jobMB('analyze', { SAS_JOB_MB_ANALYZE: '1200' }), 1200);
  assert.equal(jobMB('analyze', { SAS_JOB_MB_ANALYZE: '10' }), 1500, 'below 100 MB is a typo');
  assert.equal(jobCpus({}), 2);
  assert.equal(jobCpus({ SAS_JOB_CPUS: '1.5' }), 1.5);
  assert.equal(reservedMB({}), 1024);
  assert.equal(reservedMB({ SAS_RESERVED_MB: '0' }), 0);
  // The budget follows SAS_RESERVED_MB.
  const cap = capacity.read({ env: { SAS_RESERVED_MB: '3000' }, cgroup: { version: null, memLimitMB: null, memUsedMB: null, cpus: null }, hostCpus: 4, hostTotalMB: 8000, hostFreeMB: 5000 });
  assert.equal(cap.budgetMB, 5000);
});
