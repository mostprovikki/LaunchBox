#!/bin/bash
# The MINIMUM human verification of the auth system: two dialogs, ~30 seconds.
#
# Why this is sufficient, rather than a shortcut. Everything else in
# docs/spikes/auth-verify.sh is already covered without a human:
#
#   * which actions gate, and that a refusal writes nothing — tests/api.test.js,
#     with a fake approver, mutation-checked (moving a write before its gate fails);
#   * grace scoping, the queue, timeouts, tamper detection — tests/approval.test.js,
#     25 tests, including the real binary's captured payloads as fixtures;
#   * server -> real binary -> a genuine system dialog -> refusal — 
#     tools/verify-approval-timeout.sh, using the timeout outcome, which needs no
#     input at all;
#   * the token, the header guards, and the UI keeping your work on a refusal —
#     tools/verify-auth-ui.mjs, driving real Chrome.
#
# What no machine here can do is press Deny and then authenticate as you. That is
# the whole point of the layer, so it is the whole of what is asked below.
#
# Sandboxed: throwaway CS_DATA, a fake `claude`, and an 8s timeout. Your real
# ~/.claude-scheduler is never touched and no quota can be spent.
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok(){ echo "   ✓ $1"; pass=$((pass+1)); }
bad(){ echo "   ✗ $1"; fail=$((fail+1)); }

PORT=18907
export CS_DATA="$(mktemp -d)" CS_PORT=$PORT CS_NO_NOTIFY=1 CS_APPROVAL_TIMEOUT_MS=60000
FAKE="$(mktemp -d)"
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

cleanup(){ stop_daemon; rm -rf "$CS_DATA" "$FAKE"
  echo ""; echo "──────── $pass passed, $fail failed ────────"
  [ "$fail" = "0" ] && echo "The approval layer is verified end to end, including the human half." ; }
trap cleanup EXIT

printf '#!/bin/bash\necho %s\n' "'{\"type\":\"result\",\"subtype\":\"success\"}'" > "$FAKE/claude"
chmod +x "$FAKE/claude"
mkdir -p "$CS_DATA/bin"
swiftc -O -o "$CS_DATA/bin/LaunchBox" helper/LaunchBox.swift 2>/dev/null || { bad "helper did not compile"; exit 1; }
shasum -a 256 "$CS_DATA/bin/LaunchBox" | awk '{print $1}' > "$CS_DATA/bin/LaunchBox.sha256"
node -e "
import('./lib/paths.js').then(async (p) => {
  const { openDb, setSetting } = await import('./lib/db.js');
  p.ensureDirs(); const db = openDb(p.dbPath());
  setSetting(db, 'claudePath', process.argv[1]); db.close();
});" "$FAKE/claude"
node server.js > "$CS_DATA/log" 2>&1 &
# Detached from job control so the shell does not print "Terminated: 15" after the
# summary — a teardown notice that reads like a failure at the moment the results say
# everything passed.
disown 2>/dev/null || true
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null || { bad "daemon did not start"; exit 1; }
T=$(node bin/claude-scheduler.mjs token)
A=(-H "Authorization: Bearer $T" -H 'Content-Type: application/json')
JOB='{"name":"nightly sweep","type":"command","command":"echo hi","cwd":"/tmp","schedules":[{"type":"cron","expr":"0 3 * * *"}]}'
count(){ curl -s "${A[@]}" "http://127.0.0.1:$PORT/api/jobs" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["jobs"]))'; }

echo ""
echo "════════════════════════════════════════════════════════"
echo " Two dialogs. Deny the first, approve the second."
echo "════════════════════════════════════════════════════════"
echo ""
echo "── 1 of 2   press DENY"
echo "   It should read: LaunchBox is trying to create the scheduled"
echo "   job “nightly sweep”, which can run commands on this Mac."
B=$(count)
C=$(curl -s -X POST "http://127.0.0.1:$PORT/api/jobs" "${A[@]}" -d "$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("code"))')
[ "$C" = "approval_denied" ] && ok "your Deny was recorded as a denial" || bad "expected approval_denied, got $C"
[ "$(count)" = "$B" ] && ok "nothing was saved" || bad "a job was created despite the denial"

echo ""
echo "── 2 of 2   APPROVE this one (Touch ID or your password)"
echo "   Same wording. This is the identical request, retried — which is"
echo "   what the UI does when you press Submit again."
ID=$(curl -s -X POST "http://127.0.0.1:$PORT/api/jobs" "${A[@]}" -d "$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id") or "")')
[ -n "$ID" ] && ok "your approval created the job" || bad "the job was not created"
grep -q "approval: job.create → approved" "$CS_DATA/log" && ok "the approval is in the audit log" || bad "nothing was logged"
