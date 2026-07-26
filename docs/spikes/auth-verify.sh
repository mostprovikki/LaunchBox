#!/bin/bash
# Batched human verification of the auth system — the ONE session that prompts.
#
# The user asked that every Touch ID / password prompt be collected into a single
# sitting rather than interrupting them repeatedly. Nothing else in this repo
# raises a system dialog: every automated test injects a fake approver, and the
# helper is only ever run with --check, which never prompts.
#
# SAFETY, by construction rather than by care:
#   * CS_DATA is a throwaway directory, so your real ~/.claude-scheduler is never
#     touched — not its jobs, not its projects, not its token.
#   * claudePath is pre-seeded to a fake binary, so no claude job can spend quota.
#   * CS_APPROVAL_TIMEOUT_MS is lowered to 8s, because sitting through two 180s
#     timeouts is unreasonable. The real 180s bound is covered by an automated
#     test with an injected clock.
#
# Usage:  docs/spikes/auth-verify.sh
# Expect: 8 numbered steps, 5 dialogs. Each step says what to do.
set -u
# docs/spikes/ -> repo root: two levels, not one.
cd "$(dirname "$0")/../.."

pass=0; fail=0
ok()   { echo "   ✓ $1"; pass=$((pass+1)); }
bad()  { echo "   ✗ $1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — expected $3, got $2"; fi; }
hr()   { echo ""; echo "── $1 ────────────────────────────────────────────"; }

PORT=18979
export CS_DATA="$(mktemp -d)"
export CS_PORT=$PORT
export CS_NO_NOTIFY=1
export CS_APPROVAL_TIMEOUT_MS=8000

# SIGTERM first, and suppress the shell's job-control notice: a bare `kill -9`
# on a daemon this shell still owns prints "Killed: 9" AFTER the results, which
# reads like a failure at exactly the moment the summary says everything passed.
stop_daemon() {
  local pids
  pids=$(lsof -ti:"${PORT:-${CS_PORT:-0}}" 2>/dev/null) || true
  [ -n "$pids" ] || return 0
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -ti:"${PORT:-${CS_PORT:-0}}" >/dev/null 2>&1 || return 0
    sleep 0.3
  done
  kill -9 $pids 2>/dev/null || true
  wait $pids 2>/dev/null || true
}

cleanup() {
  [ -n "${SRV:-}" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }
  stop_daemon
  rm -rf "$CS_DATA" "${FAKE:-/nonexistent}"
  echo ""
  echo "──────── $pass passed, $fail failed ────────"
  echo "sandbox removed; your real ~/.claude-scheduler was never touched"
}
trap cleanup EXIT

# ---------------------------------------------------------------- preparation
hr "Preparation (no prompts yet)"

FAKE="$(mktemp -d)"
cat > "$FAKE/claude" <<'SH'
#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"verify-fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"fake"}'
SH
chmod +x "$FAKE/claude"
ok "fake claude in place — no quota can be spent"

HELPER="$CS_DATA/bin/LaunchBox"
mkdir -p "$CS_DATA/bin"
# CS_VERIFY_HELPER lets this script be dry-run end to end with a scripted stand-in
# instead of the real dialog, so its plumbing can be proved correct BEFORE a human
# is asked to sit through ten prompts. Unset (the normal case) builds the real one.
if [ -n "${CS_VERIFY_HELPER:-}" ]; then
  cp "$CS_VERIFY_HELPER" "$HELPER"
  echo "   ⚠ DRY RUN: scripted helper, no real dialogs — plumbing check only"
elif swiftc -O -o "$HELPER" helper/LaunchBox.swift 2>/dev/null; then
  ok "helper compiled"
else
  bad "helper failed to compile — cannot verify Layer 2"; exit 1
fi
# --check never prompts, so this is safe to run before the session proper.
if "$HELPER" --check >/dev/null 2>&1; then ok "helper --check exits 0 (no prompt)"; else bad "helper --check failed"; fi

node -e "
import('./lib/paths.js').then(async (p) => {
  const { openDb, setSetting } = await import('./lib/db.js');
  p.ensureDirs();
  const db = openDb(p.dbPath());
  setSetting(db, 'claudePath', process.argv[1]);
  db.close();
});" "$FAKE/claude" || { bad "could not seed claudePath"; exit 1; }
ok "claudePath seeded directly in the database (going through the API would have prompted)"

node server.js > "$CS_DATA/daemon.log" 2>&1 &
SRV=$!
# Detached from job control so the shell does not print "Terminated: 15" after the
# summary — a teardown notice that reads like a failure at the moment the results say
# everything passed.
disown 2>/dev/null || true
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null && ok "daemon up on $PORT" || { bad "daemon did not start"; cat "$CS_DATA/daemon.log"; exit 1; }

TOKEN=$(node bin/claude-scheduler.mjs token)
A=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
api() { local m=$1 p=$2 b=${3:-}; if [ -n "$b" ]; then curl -s -X "$m" "${A[@]}" -d "$b" "http://127.0.0.1:$PORT$p"; else curl -s -X "$m" "${A[@]}" "http://127.0.0.1:$PORT$p"; fi; }
code() { local m=$1 p=$2 b=${3:-}; if [ -n "$b" ]; then curl -s -o /dev/null -w '%{http_code}' -X "$m" "${A[@]}" -d "$b" "http://127.0.0.1:$PORT$p"; else curl -s -o /dev/null -w '%{http_code}' -X "$m" "${A[@]}" "http://127.0.0.1:$PORT$p"; fi; }
jsonf() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

ok "token obtained"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " 8 steps follow, 5 of which show a dialog. Each says exactly"
echo " what to do. Nothing here can touch your real data or spend quota."
echo "════════════════════════════════════════════════════════════"

# ═══════════════════════════════════════════════════════════════════════════
# STEP ORDER MATTERS, and getting it wrong is how the first draft of this
# script produced five false failures.
#
# Creating or editing a job may ride the 5-minute grace window. So the moment
# ONE job approval succeeds, the next few job writes do not prompt at all —
# which is correct behaviour, but it means a deny/timeout check placed after an
# approval silently tests nothing and then "fails".
#
# Therefore: the deny and timeout checks for jobs come FIRST, before any
# approval opens a window; and the second deny/timeout pair uses cleanup, which
# is never graced by design.
# ═══════════════════════════════════════════════════════════════════════════

# ------------------------------------------------------------------- step 1
hr "1/8  DENY — create a job"
echo '   The dialog should read:'
echo '     LaunchBox is trying to create the scheduled job "nightly sweep",'
echo '     which can run commands on this Mac.'
echo '   Press Deny. Nothing must be saved.'
NEWJOB='{"name":"nightly sweep","type":"command","command":"echo hi","cwd":"/tmp","schedule":{"type":"cron","expr":"0 3 * * *"}}'
BEFORE=$(api GET /api/jobs | jsonf "['jobs'].__len__()")
CODE=$(api POST /api/jobs "$NEWJOB" | jsonf "['code']")
AFTER=$(api GET /api/jobs | jsonf "['jobs'].__len__()")
check "refusal code" "$CODE" "approval_denied"
check "nothing was written" "$AFTER" "$BEFORE"

# ------------------------------------------------------------------- step 2
hr "2/8  APPROVE — retry that identical request"
echo '   This is the state-preservation contract. In the UI your form would'
echo '   still be filled, so pressing Submit again must simply work.'
JOB_ID=$(api POST /api/jobs "$NEWJOB" | jsonf "['id']")
if [ -n "$JOB_ID" ]; then ok "the retried request succeeded"; else bad "retry failed"; fi

# ------------------------------------------------------------------- step 3
hr "3/8  NO DIALOG EXPECTED — edit that job inside the grace window"
echo '   Step 2 approved seconds ago, so this must NOT prompt.'
echo '   If a dialog appears, that is a FAILURE — deny it.'
S=$(code PUT "/api/jobs/$JOB_ID" '{"name":"nightly sweep","type":"command","command":"echo hi2","cwd":"/tmp","schedule":{"type":"cron","expr":"0 3 * * *"}}')
check "edit rode the grace window without prompting" "$S" "200"

# ------------------------------------------------------------------- step 4
hr "4/8  DENY — cleanup, which must prompt DESPITE that open grace window"
echo '   A grace window IS an attack window, so destructive actions never ride'
echo '   one. Press Deny; the sandbox jobs must survive.'
BEFORE=$(api GET /api/jobs | jsonf "['jobs'].__len__()")
CODE=$(api POST /api/cleanup | jsonf "['code']")
AFTER=$(api GET /api/jobs | jsonf "['jobs'].__len__()")
check "cleanup prompted and was refused" "$CODE" "approval_denied"
check "jobs survived the denial" "$AFTER" "$BEFORE"

# ------------------------------------------------------------------- step 5
hr "5/8  ALREADY VERIFIED AUTOMATICALLY — the timeout path"
echo '   Skipped here on purpose. A timeout needs no human input, only that'
echo '   nobody touches the dialog, so it is covered unattended by:'
echo '     tools/verify-approval-timeout.sh'
echo '   That runs the real helper, confirms a genuine dialog was raised, and'
echo '   asserts approval_timeout with nothing written. One less prompt for you.'
ok "timeout coverage delegated to tools/verify-approval-timeout.sh"

# ------------------------------------------------------------------- step 6
hr "6/8  APPROVE — activate a project"
echo '   Activation is the airlock for unattended agent runs with write access,'
echo '   so it prompts even though the grace window is still open.'
REPO=$(mktemp -d)
printf '{ "autoLabel": "unattended", "enabled": true }\n' > "$REPO/.scheduler.json"
PROJ_ID=$(api POST /api/projects "{\"path\":\"$REPO\",\"name\":\"verify-repo\"}" | jsonf "['project']['id']")
if [ -z "$PROJ_ID" ]; then bad "could not register the fixture repo"; else
  S=$(code PUT "/api/projects/$PROJ_ID" '{"state":"active"}')
  check "activation approved" "$S" "200"
fi
rm -rf "$REPO"

# ------------------------------------------------------------------- step 7
hr "7/8  APPROVE — change claudePath"
echo '   The bypass the spec calls out: repointing this makes every existing'
echo '   job run a different binary, without creating any job at all.'
S=$(code PUT /api/settings '{"claudePath":"/usr/bin/true"}')
check "claudePath change approved" "$S" "200"

# ------------------------------------------------------------------- step 8
hr "8/8  NO DIALOG EXPECTED — change an ordinary setting"
echo '   usagePollSec tunes a threshold and names no executable, so it is'
echo '   deliberately ungated. No dialog should appear.'
S=$(code PUT /api/settings '{"usagePollSec":300}')
check "an ordinary setting needs no approval" "$S" "200"

# ---------------------------------------------------- the web layer (no dialogs)
hr "Layer 1 — the token and the header guards (no dialogs)"
check "no token at all is refused"   "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/settings)" "401"
check "a wrong token is refused"     "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' http://127.0.0.1:$PORT/api/settings)" "401"
check "the static shell still loads" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)" "200"
check "a foreign Host is refused"    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "${A[@]}" http://127.0.0.1:$PORT/api/settings)" "403"
check "a form-style POST is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' --data x=1 http://127.0.0.1:$PORT/api/cleanup)" "415"
check "the SSE tail route is gone"   "$(code GET /api/runs/anything/tail)" "404"
