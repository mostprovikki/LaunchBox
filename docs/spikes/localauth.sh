#!/bin/bash
# Task 9 spike — re-verify that LocalAuthentication can prompt from a background launchd agent,
# and that LaunchBox's exit-code / JSON contract holds for approval AND denial.
#
# ⚠️ THIS SCRIPT NEEDS A HUMAN. It raises TWO real system authentication sheets and you must
#    answer them in this order:
#
#         sheet 1  →  APPROVE  (Touch ID or your login password)
#         sheet 2  →  DENY     (press the "Deny" button)
#
#    Nothing else on the Mac is touched: no job, no project, no quota, no real
#    ~/.claude-scheduler state. The only thing written outside a temp dir is one throwaway
#    LaunchAgent plist, removed on exit.
#
# WHY THIS EXISTS: the whole approval layer rests on one measured claim — that a process
# started by launchd, with no TTY and no controlling app, can still put an authentication
# sheet in front of the user. If that ever stops being true (an OS update, a TCC policy
# change, a Swift/LocalAuthentication change), every gated action in the scheduler would
# fail closed and the product would look broken for no visible reason. Run this after any
# macOS upgrade, any Xcode/Swift toolchain change, and after editing helper/LaunchBox.swift.
# Every assertion corresponds to a claim in docs/plans/2026-07-26-local-api-auth.md §Task 9
# and the "MEASURED FACTS" header of helper/LaunchBox.swift — a FAIL means that reasoning
# needs revisiting, not that this script is broken.
#
# This is DELIBERATELY NOT part of `npm test`, for two independent reasons:
#   1. it shells out to the real helper, and the house rule is that no unit test does that;
#   2. it blocks on a human finger, so it can never run unattended or in CI.
# The automated coverage of the same contract lives in tests/approval.test.js, which injects
# a fakeApprover and never prompts. The 180s timeout path is not exercised here either —
# asking the operator to sit and watch a dialog for three minutes is unreasonable, and that
# bound is covered by an injected-clock test instead.
#
# Verified green against: macOS 26.x (Darwin 25.5.0), Apple Silicon, Touch ID present.
set -u

[ "$(uname -s)" = "Darwin" ] || { echo "not macOS — LocalAuthentication does not exist here"; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/helper/LaunchBox.swift"
LABEL="local.claude-scheduler.localauth-spike"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(mktemp -d)"

cleanup() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  launchctl remove "$LABEL" >/dev/null 2>&1
  rm -f "$PLIST"
  rm -rf "$ROOT"
}
trap cleanup EXIT
# Re-runnable: clear any agent left behind by an interrupted previous run.
cleanup_previous() { launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1; rm -f "$PLIST"; }
cleanup_previous

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; }
check(){ # check <desc> <expected> <actual>
  [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
jsonf(){ # jsonf <file> <key>  — print one field, or the empty string
  python3 -c 'import sys,json
try: print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
except Exception: print("")' "$1" "$2" 2>/dev/null; }

# ------------------------------------------------------------------ the binary under test
# Prefer the installed helper — that is the artifact users actually run. Fall back to
# compiling the source, but ALWAYS to a file named exactly `LaunchBox`: the filename is the
# dialog title, so a differently-named build would be testing a different dialog.
HELPER="$HOME/.claude-scheduler/bin/LaunchBox"
if [ -x "$HELPER" ]; then
  echo "helper: $HELPER (installed)"
else
  command -v swiftc >/dev/null || { echo "no installed helper and no swiftc — cannot verify"; exit 2; }
  mkdir -p "$ROOT/bin"
  HELPER="$ROOT/bin/LaunchBox"
  swiftc -O -o "$HELPER" "$SRC" || { echo "swiftc failed"; exit 1; }
  echo "helper: $HELPER (compiled from helper/LaunchBox.swift)"
fi
echo "swift:  $(swiftc --version 2>&1 | head -1)"
echo

echo "== part 1: --check, non-interactive (must NOT prompt) =="

check "the helper is named LaunchBox — the filename IS the dialog title" "LaunchBox" "$(basename "$HELPER")"

# Fact 3: swiftc's adhoc signature is mandatory. If this is absent something post-processed
# the binary, and the kernel will SIGKILL it (137) instead of running it.
codesign -dv "$HELPER" 2>&1 | grep -q "Signature=adhoc" \
  && ok "binary carries swiftc's adhoc signature (never strip or re-sign it)" \
  || bad "binary carries an adhoc signature" "Signature=adhoc" "$(codesign -dv "$HELPER" 2>&1 | tail -1)"

start=$(date +%s)
"$HELPER" --check > "$ROOT/check.json" 2>"$ROOT/check.err"; rc=$?
elapsed=$(( $(date +%s) - start ))

check "--check exits 0"                       "0"    "$rc"
check "--check reports canEvaluate: true"     "True" "$(jsonf "$ROOT/check.json" canEvaluate)"
check "--check reports errorCode 0"           "0"    "$(jsonf "$ROOT/check.json" errorCode)"
check "--check reports mode: check"           "check" "$(jsonf "$ROOT/check.json" mode)"
# A prompt would have blocked on the human; returning instantly is the evidence it did not.
[ "$elapsed" -le 5 ] && ok "--check returned in ${elapsed}s without prompting" \
  || bad "--check returns without prompting" "<=5s" "${elapsed}s"
echo "  note  biometryType=$(jsonf "$ROOT/check.json" biometryType)  (a Mac with no Touch ID must still pass, via password)"

# Bad usage must be distinguishable from a refusal, and must not prompt either.
"$HELPER" --nonsense > "$ROOT/usage.json" 2>&1; rc=$?
check "an unknown mode exits 2, not 0 or 1" "2" "$rc"

echo
echo "== part 2: --auth from a background launchd agent (INTERACTIVE) =="
echo
echo "  This is the load-bearing part. The helper is started by launchd, not by this shell:"
echo "  no TTY, no parent app, no window. If a sheet still appears, the design holds."
echo

# The wrapper exists so we capture the real exit status. launchd does not hand it back.
cat > "$ROOT/run.sh" <<'WRAP'
#!/bin/bash
# $1 = helper, $2 = reason, $3 = output dir
"$1" --auth "$2" > "$3/auth.json" 2>"$3/auth.err"
echo $? > "$3/auth.rc"
WRAP
chmod +x "$ROOT/run.sh"

# Runs the helper under launchd and blocks until the wrapper records an exit code.
# <phase> is a subdirectory so the approve and deny runs cannot read each other's files.
run_under_launchd() { # run_under_launchd <phase> <reason>
  local phase="$1" reason="$2" out="$ROOT/$1" i
  mkdir -p "$out"
  cat > "$PLIST" <<PLI
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/run.sh</string>
    <string>$HELPER</string>
    <string>$reason</string>
    <string>$out</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$out/launchd.err</string>
</dict>
</plist>
PLI
  chmod 644 "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>"$out/bootstrap.err" \
    || launchctl load -w "$PLIST" 2>>"$out/bootstrap.err" \
    || { echo "  FAIL  could not start the launchd agent: $(cat "$out/bootstrap.err")"; fail=$((fail+1)); return 1; }
  # 200s: longer than the helper's own 180s bound, so a helper timeout is reported by the
  # helper rather than misattributed to this script giving up.
  for i in $(seq 1 200); do
    [ -s "$out/auth.rc" ] && break
    sleep 1
  done
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  rm -f "$PLIST"
  [ -s "$out/auth.rc" ] || { echo "  FAIL  the agent never produced a result in 200s"; fail=$((fail+1)); return 1; }
  return 0
}

REASON='create the scheduled job “nightly sweep”, which can run commands on this Mac'

echo "  >>> SHEET 1 of 2 is about to appear. Please APPROVE it. <<<"
echo
if run_under_launchd approve "$REASON"; then
  A="$ROOT/approve"
  check "approval exits 0"                    "0"     "$(cat "$A/auth.rc")"
  check "approval reports success: true"      "True"  "$(jsonf "$A/auth.json" success)"
  check "approval reports timedOut: false"    "False" "$(jsonf "$A/auth.json" timedOut)"
  check "approval reports errorCode 0"        "0"     "$(jsonf "$A/auth.json" errorCode)"
  # The claim being pinned: launchd context, therefore no TTY, and it still prompted.
  check "the agent genuinely had no TTY"      "False" "$(jsonf "$A/auth.json" hasTTY)"
  echo "  note  elapsedMs=$(jsonf "$A/auth.json" elapsedMs)  (the 180s bound in LaunchBox.swift exists because a"
  echo "        password approval once measured 67600ms against a 120s bound — check the headroom here)"

  # Wording cannot be asserted from the outside: the sheet composes
  # "<filename> is trying to <reason>." and only the operator saw it.
  printf '  ?     Did the sheet title read exactly "LaunchBox", and the sentence read\n'
  printf '        "LaunchBox is trying to %s."?  [y/N] ' "$REASON"
  read -r seen
  case "$seen" in
    [yY]*) ok "operator confirms the title and the appended-reason sentence read correctly";;
    *)     bad "the title and sentence read correctly" "y" "${seen:-no}";;
  esac
fi

echo
echo "  >>> SHEET 2 of 2 is about to appear. Please press DENY. <<<"
echo
if run_under_launchd deny "$REASON"; then
  D="$ROOT/deny"
  check "denial exits 1"                      "1"     "$(cat "$D/auth.rc")"
  check "denial reports success: false"       "False" "$(jsonf "$D/auth.json" success)"
  check "denial reports timedOut: false"      "False" "$(jsonf "$D/auth.json" timedOut)"
  # -2 is LAError.userCancel. lib/approval.js maps exactly this to approval_denied; any
  # other code is a system failure and maps to approval_unavailable, so the distinction
  # is what keeps "you said no" from being reported as "the helper is broken".
  check "denial reports errorCode -2 (LAError.userCancel)" "-2" "$(jsonf "$D/auth.json" errorCode)"
fi

echo
echo "-------- $pass passed, $fail failed --------"
[ "$fail" -eq 0 ] || echo "A failure means Task 9's measured conclusions no longer hold on this OS/toolchain."
exit $(( fail > 0 ))
