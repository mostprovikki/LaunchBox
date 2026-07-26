#!/bin/bash
# Verifies the REAL approval helper end to end — without a human.
#
# The approve and deny outcomes need a finger. The TIMEOUT outcome does not: it
# needs only that nobody touches the dialog. So this exercises the whole real
# path — server → lib/approval.js → the compiled Swift binary → a genuine system
# dialog → refusal → nothing written — and is safe to run unattended and in CI-ish
# contexts on a Mac with a GUI session.
#
# A dialog WILL appear on screen and dismiss itself after ~6 seconds.
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok(){ echo "   ✓ $1"; pass=$((pass+1)); }
bad(){ echo "   ✗ $1"; fail=$((fail+1)); }

D=$(mktemp -d); mkdir -p "$D/bin"
export CS_DATA=$D CS_PORT=18959 CS_NO_NOTIFY=1 CS_APPROVAL_TIMEOUT_MS=6000
cleanup(){ lsof -ti:$CS_PORT 2>/dev/null | xargs kill -9 2>/dev/null; rm -rf "$D"; echo ""; echo "──────── $pass passed, $fail failed ────────"; }
trap cleanup EXIT

swiftc -O -o "$D/bin/LaunchBox" helper/LaunchBox.swift 2>/dev/null \
  && ok "the real helper compiled" || { bad "helper did not compile"; exit 1; }

node server.js > "$D/log" 2>&1 &
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$CS_PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$CS_PORT/" >/dev/null || { bad "daemon did not start"; exit 1; }
[ "$(grep -c 'approval:' "$D/log")" = "0" ] && ok "no approval warning at boot — the helper is usable" \
  || bad "daemon warned about the helper: $(grep 'approval:' "$D/log" | head -1)"

T=$(node bin/claude-scheduler.mjs token)
A=(-H "Authorization: Bearer $T" -H 'Content-Type: application/json')
count(){ curl -s "${A[@]}" "http://127.0.0.1:$CS_PORT/api/jobs" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["jobs"]))'; }

echo "   … a real dialog is about to appear. Do not touch it."
BEFORE=$(count)
( curl -s -X POST "http://127.0.0.1:$CS_PORT/api/jobs" "${A[@]}" \
  -d '{"name":"timeout probe","type":"command","command":"echo x","cwd":"/tmp","schedules":[{"type":"cron","expr":"0 3 * * *"}]}' > "$D/resp" ) &
CURL=$!
sleep 2
pgrep -f "$D/bin/LaunchBox" >/dev/null \
  && ok "the real helper is running — a genuine system dialog was raised" \
  || bad "no helper process: the server never reached the real binary"
wait $CURL
python3 -c "
import json,sys
d=json.load(open('$D/resp'))
sys.exit(0 if d.get('code')=='approval_timeout' else 1)" \
  && ok "refused with approval_timeout" || bad "unexpected response: $(cat "$D/resp")"
[ "$(count)" = "$BEFORE" ] && ok "nothing was written — an unanswered dialog is not consent" \
  || bad "a job was created without approval"
