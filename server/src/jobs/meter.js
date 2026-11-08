// @ts-check
// RAM and CPU meter for jobs: how much memory and processor time a job really takes, per job and per step, so a change can be
// checked for weight before it ships (jobs/capacity.js reserves a fixed amount per job; a heavier job means fewer at once).
// OFF by default; SAS_METER=1 turns it on. Measures the whole process tree of this server: Node itself plus every Chromium,
// Lighthouse worker and Lighthouse Chrome it started (they are all descendants of this process).
//
//   SAS_METER      1 = on (anything else = off)
//   SAS_METER_MS   sampling interval in ms (250–10000, default 1000)
//
// How it reads the tree (no dependency, nothing installed):
// - Linux: /proc/<pid>/stat for every process (parent, user + system CPU), /proc/<pid>/status (VmRSS) for the tree's members.
// - Windows: ONE hidden PowerShell helper for as long as a metered job runs (the pattern of jobs/keepAwake.js), a small compiled
//   loop that lists processes, finds parents (NtQueryInformationProcess, cached per process), and prints one line per interval.
//   The helper leaves itself out of the totals and ends when this server ends. ~45 ms of CPU per sample on a laptop.
// - macOS / anything else: `method: 'unavailable'` (no numbers rather than wrong ones).
//
// What the numbers mean: RAM = the sum of resident memory (working set) of every process in the tree, sampled, so pages
// Chromium processes share are counted once per process (an overcount, the same on both sides of a before / after check).
// CPU = processor time used between samples, per process; a process that starts and ends between two samples is not seen.
// Several metered jobs at once share one tree: each gets every sample, and the summary says `shared: true`.
// Output: one log line per job and data/meter/<table>-<jobId>.json (the scratch server's data folder when measuring).
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setting } from './limits.js';
import { DATA_DIR } from '../config/paths.js';

const MB = 1024 * 1024;
/** Linux reports CPU in clock ticks; 100 per second is the user-space ABI value on every mainstream architecture. */
const CLK_TCK = 100;

export const meterEnabled = (env = process.env) => env.SAS_METER === '1';
export const meterIntervalMs = (env = process.env) => setting(env.SAS_METER_MS, { min: 250, max: 10000, def: 1000 });

// ---------- Linux: /proc ----------

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const listProc = () => {
  try {
    return readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
};

/** ppid and CPU ticks (user + system) from one /proc/<pid>/stat text (the name in brackets may hold spaces). */
export function parseStat(text) {
  if (!text) return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 2).trim().split(/\s+/); // f[0] = state, f[1] = ppid, f[11] = utime, f[12] = stime
  const ppid = Number(f[1]);
  const ticks = Number(f[11]) + Number(f[12]);
  return Number.isFinite(ppid) && Number.isFinite(ticks) ? { ppid, ticks } : null;
}

/** VmRSS in bytes from a /proc/<pid>/status text (kernel threads have none: 0). */
export function parseRss(text) {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(text ?? '');
  return m ? Number(m[1]) * 1024 : 0;
}

/**
 * One sample of the tree under `root` on Linux. `prev` maps "pid:start" style keys to CPU seconds seen last time, so CPU is
 * counted per process (an ended process does not subtract). Readers are replaceable (tests pass a fake /proc).
 */
export function linuxSample(root, prev, { read = readText, list = listProc, skip = new Set() } = {}) {
  const procs = new Map();
  for (const pid of list()) {
    const s = parseStat(read(`/proc/${pid}/stat`));
    if (s) procs.set(Number(pid), s);
  }
  const kids = new Map();
  for (const [pid, s] of procs) {
    if (!kids.has(s.ppid)) kids.set(s.ppid, []);
    kids.get(s.ppid).push(pid);
  }
  let rss = 0;
  let cpuDelta = 0;
  let count = 0;
  const seen = new Map();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (skip.has(pid) || !procs.has(pid)) continue;
    const cpu = procs.get(pid).ticks / CLK_TCK;
    seen.set(pid, cpu);
    cpuDelta += Math.max(0, cpu - (prev.get(pid) ?? (prev.size ? 0 : cpu)));
    rss += parseRss(read(`/proc/${pid}/status`));
    count++;
    for (const c of kids.get(pid) ?? []) if (c !== pid) stack.push(c);
  }
  return { rssBytes: rss, cpuSec: cpuDelta, procs: count, cpu: seen };
}

// ---------- Windows: one helper process ----------

const WINDOWS_TICK = String.raw`
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;
public static class SasMeter {
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr Parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool b, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static Dictionary<string,int> parents = new Dictionary<string,int>();
  static Dictionary<string,long> lastCpu = new Dictionary<string,long>();
  static bool first = true;
  static string KeyOf(Process p) { try { return p.Id + ":" + p.StartTime.Ticks; } catch { return p.Id + ":?"; } }
  static int ParentOf(Process p, string key) {
    int v; if (parents.TryGetValue(key, out v)) return v;
    IntPtr h = OpenProcess(0x1000, false, p.Id); int parent = -1;
    if (h != IntPtr.Zero) { PBI i = new PBI(); int r; if (NtQueryInformationProcess(h, 0, ref i, Marshal.SizeOf(i), out r) == 0) parent = i.Parent.ToInt32(); CloseHandle(h); }
    parents[key] = parent; return parent;
  }
  public static string Tick(int root, int skip) {
    var all = Process.GetProcesses();
    var kids = new Dictionary<int,List<int>>(); var byId = new Dictionary<int,Process>(); var keys = new Dictionary<int,string>();
    foreach (var p in all) { string k = KeyOf(p); keys[p.Id] = k; byId[p.Id] = p; int par = ParentOf(p, k);
      List<int> l; if (!kids.TryGetValue(par, out l)) kids[par] = l = new List<int>(); l.Add(p.Id); }
    long ws = 0; long cpuDelta = 0; int n = 0; var now = new Dictionary<string,long>(); var stack = new Stack<int>(); stack.Push(root);
    while (stack.Count > 0) { int id = stack.Pop(); Process p; if (id == skip || !byId.TryGetValue(id, out p)) continue;
      try { long c = p.TotalProcessorTime.Ticks; ws += p.WorkingSet64; string k = keys[id]; long was;
        if (lastCpu.TryGetValue(k, out was)) cpuDelta += Math.Max(0, c - was); else if (!first) cpuDelta += c;
        now[k] = c; n++; } catch {}
      List<int> l; if (kids.TryGetValue(id, out l)) foreach (var c in l) if (c != id) stack.Push(c); }
    lastCpu = now; first = false;
    var live = new HashSet<string>(keys.Values); var drop = new List<string>();
    foreach (var k in parents.Keys) if (!live.Contains(k)) drop.Add(k);
    foreach (var k in drop) parents.Remove(k);
    foreach (var p in all) p.Dispose();
    return ws + " " + cpuDelta + " " + n;
  }
}`;

/** The helper command (exported for tests): prints "<working set bytes> <cpu delta, 100 ns units> <processes>" per interval. */
export function windowsHelperCommand(root = process.pid, intervalMs = 1000) {
  const script = [
    `Add-Type -TypeDefinition @'\n${WINDOWS_TICK}\n'@`,
    `while (Get-Process -Id ${root} -ErrorAction SilentlyContinue) {`,
    `  [Console]::Out.WriteLine([SasMeter]::Tick(${root}, $PID)); [Console]::Out.Flush()`,
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded] };
}

/** One helper line → a sample, or null for anything else. */
export function parseWindowsLine(line) {
  const m = /^(\d+) (\d+) (\d+)$/.exec(String(line).trim());
  return m ? { rssBytes: Number(m[1]), cpuSec: Number(m[2]) / 1e7, procs: Number(m[3]) } : null;
}

// ---------- the shared sampler ----------

/** @type {Set<ReturnType<typeof newRecording>>} */
const recordings = new Set();
let sampler = null; // { stop() }

function startSampler(intervalMs) {
  const deliver = (s) => {
    const at = Date.now();
    for (const r of recordings) r.add({ ...s, at });
  };
  if (process.platform === 'linux') {
    let prev = new Map();
    const tick = () => {
      const s = linuxSample(process.pid, prev);
      prev = s.cpu;
      deliver({ rssBytes: s.rssBytes, cpuSec: s.cpuSec, procs: s.procs });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return { method: 'linux-proc', stop: () => clearInterval(timer) };
  }
  if (process.platform === 'win32') {
    const { cmd, args } = windowsHelperCommand(process.pid, intervalMs);
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      console.warn(`[meter] not available: ${err.message}`);
      return { method: 'unavailable', stop: () => {} };
    }
    proc.on('error', (err) => console.warn(`[meter] helper failed: ${err.message}`));
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const s = parseWindowsLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (s) deliver(s);
      }
    });
    proc.unref();
    /** @type {any} */ (proc.stdout).unref?.();
    const kill = () => proc.kill();
    process.once('exit', kill);
    return { method: 'windows-helper', stop: () => { process.off('exit', kill); kill(); } };
  }
  return { method: 'unavailable', stop: () => {} };
}

/**
 * The summary-keeper of one job. `stepOf()` names the step a sample belongs to (the job line's shown step).
 * Exported for tests, which feed samples by hand.
 */
export function newRecording({ id, table, stepOf, intervalMs, method, startedAt = Date.now() }) {
  const steps = new Map();
  let peak = { mb: 0, at: null, step: null };
  let cpuSec = 0;
  let samples = 0;
  let sumMB = 0;
  let shared = false;
  let lastAt = startedAt;
  return {
    add(s) {
      const mb = s.rssBytes / MB;
      const step = stepOf() ?? 'starting';
      samples++;
      sumMB += mb;
      cpuSec += s.cpuSec;
      if (recordings.size > 1) shared = true;
      if (mb > peak.mb) peak = { mb, at: s.at, step };
      const st = steps.get(step) ?? { ms: 0, peakMB: 0, cpuSec: 0, samples: 0 };
      st.ms += Math.max(0, s.at - lastAt);
      st.peakMB = Math.max(st.peakMB, mb);
      st.cpuSec += s.cpuSec;
      st.samples++;
      steps.set(step, st);
      lastAt = s.at;
    },
    summary({ status = null, endedAt = Date.now() } = {}) {
      const wallMs = endedAt - startedAt;
      const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
      const r1 = (n) => Math.round(n * 10) / 10;
      return {
        table,
        id,
        status,
        method,
        intervalMs,
        startedAt: new Date(startedAt).toISOString(),
        wallMs,
        samples,
        peakMB: Math.round(peak.mb),
        peakStep: peak.step,
        meanMB: samples ? Math.round(sumMB / samples) : 0,
        cpuSec: r1(cpuSec),
        // Share of the whole machine over the job's time (100 = every CPU thread busy for the whole job).
        cpuPct: wallMs > 0 ? r1((cpuSec / (wallMs / 1000) / cpus) * 100) : 0,
        cpus,
        shared,
        byStep: Object.fromEntries([...steps].map(([k, v]) => [k, { ms: v.ms, peakMB: Math.round(v.peakMB), cpuSec: r1(v.cpuSec), samples: v.samples }])),
      };
    },
  };
}

/**
 * Starts metering one job (null when the meter is off). Call `stop({ status })` once the job ends: it writes the summary
 * (log line + data/meter/<table>-<id>.json) and returns it. Never throws into the job.
 * @param {{ id: string, step?: string | null }} job  the job line's record (its `step` is read at every sample)
 * @param {string} table
 */
export function meterJob(job, table, env = process.env) {
  if (!meterEnabled(env)) return null;
  const intervalMs = meterIntervalMs(env);
  try {
    if (!sampler) sampler = startSampler(intervalMs);
    const rec = newRecording({ id: job.id, table, stepOf: () => job.step, intervalMs, method: sampler.method });
    recordings.add(rec);
    let stopped = null;
    return {
      stop({ status = null } = {}) {
        if (stopped) return stopped;
        recordings.delete(rec);
        if (!recordings.size && sampler) {
          sampler.stop();
          sampler = null;
        }
        stopped = rec.summary({ status });
        try {
          const dir = path.join(DATA_DIR, 'meter');
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, `${table}-${job.id}.json`), JSON.stringify(stopped, null, 2));
        } catch (err) {
          console.warn(`[meter] summary not written: ${err.message}`);
        }
        console.log(`[meter ${table} ${job.id}] peak ${stopped.peakMB} MB (${stopped.peakStep}), CPU ${stopped.cpuSec} s (${stopped.cpuPct} % of ${stopped.cpus} threads), ${Math.round(stopped.wallMs / 1000)} s, ${stopped.samples} samples (${stopped.method})`);
        return stopped;
      },
    };
  } catch (err) {
    console.warn(`[meter] not started: ${err.message}`);
    return null;
  }
}

/** True while a sampler runs (tests). */
export const meterRunning = () => sampler != null;
