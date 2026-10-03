// Keeps the computer awake while a job runs. A laptop that goes to sleep (or to Windows' Modern Standby, which turns the
// network off) in the middle of an Analyze or Recreate stalls every browser and request, and the job ends in timeouts or
// takes half an hour. The job manager holds the request while any job runs or is queued (jobs/manager.js exclusive()) and
// lets go shortly after the last one ends, so the machine's own power settings apply again when nothing runs.
//
// How: a small helper process asks the operating system to stay awake and is stopped to let go.
// - Windows: PowerShell calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED). The display
//   flag matters: on Modern Standby laptops the screen turning off is what starts standby. The helper exits by itself when
//   this server process is gone (a crashed or killed server never leaves the machine awake).
// - macOS: caffeinate -di -w <pid> (also ends with this process). Linux: systemd-inhibit around a sleep, when available.
// Closing the lid or pressing the power button still sleeps the machine: the request only stops idle sleep.
// SAS_KEEP_AWAKE=0 turns it off (the test suite does). Any failure is logged once and ignored: a job never fails over this.
import { spawn } from 'node:child_process';

// Time after the last job before the request is released: a Recreate queues its re-audit right after it ends.
const RELEASE_DELAY_MS = 30000;

let child = null;
let releaseTimer = null;
let warned = false;

export const keepAwakeEnabled = (env = process.env) => env.SAS_KEEP_AWAKE !== '0';

/** The helper command for a platform, or null when there is none. */
export function keepAwakeCommand(platform = process.platform, pid = process.pid) {
  if (platform === 'win32') {
    const script = [
      "$k = Add-Type -Name Power -Namespace SasKeepAwake -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      // ES_CONTINUOUS 0x80000000 | ES_DISPLAY_REQUIRED 0x2 | ES_SYSTEM_REQUIRED 0x1
      'if ($k::SetThreadExecutionState([uint32]2147483651) -eq 0) { exit 3 }',
      "[Console]::Out.WriteLine('awake')",
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded] };
  }
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-di', '-w', String(pid)] };
  if (platform === 'linux') {
    return { cmd: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=Site Audit Studio', '--why=An analysis or recreate is running', '--mode=block', 'sleep', 'infinity'] };
  }
  return null;
}

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`Keep-awake is not available (${message}); a job may stall if the computer sleeps while it runs.`);
}

/** Ask the machine to stay awake (idempotent). */
export function holdAwake(env = process.env) {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  if (child || !keepAwakeEnabled(env)) return;
  const command = keepAwakeCommand();
  if (!command) return;
  try {
    const proc = spawn(command.cmd, command.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stdout.resume();
    proc.stderr.resume();
    proc.on('error', (err) => {
      warnOnce(err.message);
      if (child === proc) child = null;
    });
    proc.on('exit', (code) => {
      if (code === 3) warnOnce('the operating system refused the request');
      if (child === proc) child = null;
    });
    child = proc;
  } catch (err) {
    warnOnce(err.message);
  }
}

/** Let the machine sleep again, after a short delay (another job may start right away). */
export function releaseAwake({ delayMs = RELEASE_DELAY_MS } = {}) {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(stopHelper, delayMs);
  releaseTimer.unref();
}

function stopHelper() {
  releaseTimer = null;
  if (!child) return;
  const proc = child;
  child = null;
  proc.kill();
}

/** True while the helper runs (GET /api/health shows it). */
export const awakeHeld = () => child != null && child.exitCode == null;

/** The running helper process (tests). */
export const awakeHelper = () => child;

// A server that exits normally never leaves the helper behind (Windows and macOS helpers also watch this process).
process.on('exit', () => child?.kill());
