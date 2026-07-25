#!/bin/bash
# M4a spike item 3 — lock contention under the embedded (Dolt) backend.
#
# WHY THIS EXISTS: the poller's retry policy hinges on what `bd` does when another process holds
# the database. The measured answer (docs/plans/2026-07-25-m4a-beads-task-sources.md §4a.6 item 3)
# is that bd WAITS FOREVER rather than erroring, which means the adapter's safety mechanism is a
# client-side timeout, not a retry-on-error. Every assertion below corresponds to a claim in that
# section — a FAIL means the retry policy needs revisiting, not that this script is broken.
#
# Companion to m4a-beads-worktree.sh (items 1 & 2). Same rules: NOT part of `npm test` (it shells
# out to the real `bd`), builds a throwaway fixture, cleans up on exit. Run after any bd upgrade.
#
# The lock holder is a real `dolt sql -q 'select sleep(N)'` against the embedded DB directory.
# Readiness is gated on the holder actually having `.dolt/noms/LOCK` open — an earlier version of
# this probe gated on "any fd under embeddeddolt", which is true seconds before the lock is taken
# and made the blocking look intermittent when it is in fact deterministic.
#
# Runtime is ~2 minutes: the blocking assertions can only be made by actually waiting out a hold.
#
# Verified green against: bd 1.1.0 (Homebrew) + dolt 2.2.2 on 2026-07-25.
set -u
export BD_NON_INTERACTIVE=1

command -v bd   >/dev/null || { echo "bd not installed — nothing to verify";   exit 2; }
command -v dolt >/dev/null || { echo "dolt not installed — needed to hold the lock"; exit 2; }
command -v lsof >/dev/null || { echo "lsof not available — needed to detect the lock"; exit 2; }
echo "bd:   $(bd --version 2>&1)"
echo "dolt: $(dolt version 2>&1 | head -1)"
echo

ROOT="$(mktemp -d)/spike"; mkdir -p "$ROOT"
trap 'pkill -f "dolt sql -q select sleep" 2>/dev/null; rm -rf "$(dirname "$ROOT")"' EXIT
P="$ROOT/proj"; DB="$P/.beads/embeddeddolt"
HOLD=8   # seconds a holder keeps the lock; assertions compare elapsed against this

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

now(){ perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
status_of(){ bd show "$1" --json 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d)["status"])' 2>/dev/null \
  || echo "?"; }
# Normalised `git status --porcelain`: one line, no leading/trailing padding. Note porcelain emits
# a LEADING space for worktree-only modifications (" M path"), hence the trim on both ends.
porcelain(){ (cd "${1:-$P}" && git status --porcelain | tr '\n' ' ' | sed 's/^ *//; s/ *$//'); }

HPID=""
hold_start(){ # hold_start — take the DB lock for $HOLD seconds; rc 1 if it never grabs it
  ( cd "$DB" && exec dolt sql -q "select sleep($HOLD)" >/dev/null 2>&1 ) & HPID=$!
  local i=0
  while [ $i -lt 250 ]; do
    lsof -p "$HPID" 2>/dev/null | grep -q 'noms/LOCK' && return 0
    i=$((i+1)); sleep 0.1
  done
  return 1
}
hold_stop(){ kill -9 "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null; sleep 1; }

# time_under_hold <cmd...> -> echoes "<elapsed_ms> <rc>", measured against a fresh holder.
# Each call gets its OWN holder: a blocking command consumes the holder's remaining lifetime, so
# reusing one holder across several commands silently masks every command after the first.
time_under_hold(){
  hold_start || { echo "-1 -1"; return; }
  local t0 t1 rc
  t0=$(now); "$@" >/dev/null 2>"$ROOT/err.txt"; rc=$?; t1=$(now)
  hold_stop
  echo "$((t1-t0)) $rc"
}

# ---------------------------------------------------------------- fixture
git init -q "$P" && cd "$P" || exit 1
git config user.email spike@local && git config user.name spike
echo "# proj" > README.md && git add -A && git commit -qm init
bd init --non-interactive -p sp >/dev/null 2>&1 || { echo "bd init failed"; exit 1; }
git add -A >/dev/null 2>&1 && git commit -qm "beads baseline" >/dev/null 2>&1

echo "== backend mode these conclusions apply to =="
mode=$(bd info 2>/dev/null | awk -F': ' '/Mode/{print $2}')
check "backend is embedded ('direct') mode" "direct" "$mode"
# No raw-SQL escape hatch in this mode — relevant to any 'just query the DB directly' idea.
sqlerr=$(bd sql 'SELECT 1' 2>&1 | head -1)
case "$sqlerr" in *"not yet supported in embedded mode"*) ok "bd sql is unsupported in embedded mode";;
  *) bad "bd sql is unsupported in embedded mode" "'not yet supported in embedded mode'" "$sqlerr";; esac

echo
echo "== the central question: what does a blocked write do? =="
ID=$(bd q "claim under contention")
set -- $(time_under_hold bd update "$ID" --claim)
el=$1; rc=$2
[ "$el" -ge $((HOLD*1000)) ] \
  && ok "a held DB makes 'update --claim' WAIT for the whole hold (${el}ms >= ${HOLD}s)" \
  || bad "claim waits out the hold" ">=${HOLD}000ms" "${el}ms"
check "...and then SUCCEEDS with rc 0 — contention is not an error" "0" "$rc"
check "...with empty stderr — there is no lock warning to key off" "" "$(cat "$ROOT/err.txt")"
check "...and the write did land" "in_progress" "$(status_of "$ID")"
echo "  note  THIS is the load-bearing finding: no lock timeout, no error, no corruption — just an"
echo "        unbounded silent hang. The adapter's protection must be its own timeout."

echo
echo "== which commands block? (each against its own fresh holder) =="
ID2=$(bd q "read probe subject")
blocks(){ # blocks <desc> <expect blocked: yes|no> <cmd...>
  local desc="$1" expect="$2"; shift 2
  set -- $(time_under_hold "$@")
  local e=$1 r=$2 got
  [ "$e" -ge $((HOLD*1000)) ] && got=yes || got=no
  [ "$expect" = "$got" ] \
    && ok "$desc — blocked=$got (${e}ms, rc=$r)" \
    || bad "$desc" "blocked=$expect" "blocked=$got (${e}ms, rc=$r)"
}
blocks "bd ready --json (the poll loop)"      yes bd ready --json
blocks "bd where --json (healthy() probe)"    yes bd where --json
blocks "bd show --json (pre-launch re-read)"  yes bd show "$ID2" --json
blocks "bd close"                             yes bd close "$ID"
blocks "bd --version (no DB access)"          no  bd --version
echo "  note  even healthy() and the poll block. 'bd --version' is the ONLY call that is safe"
echo "        without a timeout, so the version/mismatch check cannot hang."

echo
echo "== is a client-side timeout safe? kill a blocked claim, look for a phantom write =="
for SIG in TERM KILL; do
  KID=$(bd q "kill-$SIG target")
  if hold_start; then
    bd update "$KID" --claim >/dev/null 2>&1 & W=$!
    sleep 3
    if kill -0 $W 2>/dev/null; then
      kill -s $SIG $W 2>/dev/null; sleep 2
      if kill -0 $W 2>/dev/null; then bad "blocked claim dies on SIG$SIG" "dead" "still running"; kill -9 $W 2>/dev/null
      else ok "a blocked claim dies on SIG$SIG"; fi
    else
      bad "claim blocks long enough to signal" "still blocked after 3s" "already exited"
    fi
    wait $W 2>/dev/null
    hold_stop
    sleep 1
    check "SIG$SIG mid-wait leaves NO phantom write (bead still open)" "open" "$(status_of "$KID")"
  else
    bad "holder acquired the lock for SIG$SIG case" "acquired" "never acquired"
  fi
done
echo "  note  both signals are safe: timing out and killing bd cannot half-apply a claim."

echo
echo "== is --claim atomic? 8 concurrent claims of ONE bead =="
R=$(bd q "storm target")
rm -f "$ROOT"/storm.*
for i in 1 2 3 4 5 6 7 8; do
  ( BEADS_ACTOR="racer$i" bd update "$R" --claim >/dev/null 2>"$ROOT/storm.$i.err"
    echo $? > "$ROOT/storm.$i.rc" ) &
done
wait
succ=0; already=0
for i in 1 2 3 4 5 6 7 8; do
  if [ "$(cat "$ROOT/storm.$i.rc" 2>/dev/null)" = 0 ]; then succ=$((succ+1)); fi
  grep -q "already claimed by" "$ROOT/storm.$i.err" 2>/dev/null && already=$((already+1))
done
check "exactly ONE of 8 concurrent claims wins" "1" "$succ"
check "the other 7 fail with 'already claimed by'" "7" "$already"
check "the bead ends up in_progress" "in_progress" "$(status_of "$R")"
asg=$(bd show "$R" --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d).get("assignee",""))')
case "$asg" in racer*) ok "assignee is the single winner ($asg)";; *) bad "assignee is a racer" "racerN" "$asg";; esac
echo "  note  --claim IS compare-and-set. It does not replace our lease (which covers the window"
echo "        BEFORE the claim lands), but it is a real back-stop and it names the winner."

echo
echo "== integrity after all that contention =="
bd ready --json >/dev/null 2>&1; check "bd ready still works" "0" "$?"
cnt=$(bd info 2>/dev/null | awk -F': ' '/Issue Count/{print $2}')
[ "${cnt:-0}" -gt 0 ] && ok "database still reports a sane issue count ($cnt)" \
  || bad "database still readable" ">0" "$cnt"

echo
echo "== claim/close JSON shape and config =="
X=$(bd q "json shape probe")
bd update "$X" --claim --json >"$ROOT/claim.json" 2>/dev/null
shape=$(python3 -c '
import sys,json
d=json.load(open(sys.argv[1]))
if not isinstance(d,list): print("notalist"); raise SystemExit
b=d[0]
print("ok" if all(k in b for k in ("id","status","assignee","started_at")) else "missing:"+",".join(
    k for k in ("id","status","assignee","started_at") if k not in b))
' "$ROOT/claim.json" 2>/dev/null)
check "update --claim --json is a 1-element array with assignee+started_at" "ok" "$shape"
# --help documents 'Default: off', but a bd-init'd repo reports 'on'. The effective value is what
# matters for how eagerly writes hit git.
ac=$(bd config get dolt.auto-commit 2>&1 | head -1)
check "effective dolt.auto-commit in a bd-init'd repo (docs say 'off')" "on" "$ac"

echo
echo "== does scheduled work dirty the human's checkout? =="
git add -A >/dev/null 2>&1; git commit -qm "pre-dirty baseline" >/dev/null 2>&1
check "baseline is clean" "" "$(porcelain)"
D=$(bd q "dirty probe")
bd update "$D" --claim >/dev/null 2>&1
check "bd q + update --claim leave the checkout clean" "" "$(porcelain)"
bd close "$D" >/dev/null 2>&1
check "bd close DIRTIES tracked .beads/interactions.jsonl" "M .beads/interactions.jsonl" "$(porcelain)"
check "...by exactly one appended line" "1" "$(git diff --numstat -- .beads/interactions.jsonl | awk '{print $1}')"
check "...and interactions.jsonl is git-tracked" "YES" \
  "$(git ls-files --error-unmatch .beads/interactions.jsonl >/dev/null 2>&1 && echo YES || echo no)"
# It cannot be turned off: no config key, and neither knob below has any effect.
git checkout -- . >/dev/null 2>&1
D2=$(bd q "dirty probe 2"); bd update "$D2" --claim >/dev/null 2>&1
git add -A >/dev/null 2>&1; git commit -qm reset >/dev/null 2>&1
BD_NO_AUDIT=1 bd close "$D2" >/dev/null 2>&1
check "BD_NO_AUDIT=1 does NOT suppress it" "M .beads/interactions.jsonl" "$(porcelain)"
git checkout -- . >/dev/null 2>&1
bd config set audit.enabled false >/dev/null 2>&1
D3=$(bd q "dirty probe 3"); bd update "$D3" --claim >/dev/null 2>&1
git add -A >/dev/null 2>&1; git commit -qm reset2 >/dev/null 2>&1
bd close "$D3" >/dev/null 2>&1
check "audit.enabled=false does NOT suppress it either" "M .beads/interactions.jsonl" "$(porcelain)"
git checkout -- . >/dev/null 2>&1; git add -A >/dev/null 2>&1; git commit -qm reset3 >/dev/null 2>&1

# The worktree does not shield the primary: interactions.jsonl follows the RESOLVED beads dir.
W="$ROOT/wt"
git worktree add -q "$W" -b wt-sched 2>/dev/null
D4=$(bd q "worktree close probe")
(cd "$W" && BEADS_DIR="$P/.beads" bd update "$D4" --claim >/dev/null 2>&1)
check "claim from the worktree dirties neither checkout" "" "$(porcelain)$(porcelain "$W")"
(cd "$W" && BEADS_DIR="$P/.beads" bd close "$D4" >/dev/null 2>&1)
check "close from the WORKTREE still dirties the PRIMARY" "M .beads/interactions.jsonl" "$(porcelain)"
check "...and leaves the worktree itself clean" "" "$(porcelain "$W")"
echo "  note  unavoidable and by design ('intended to be versioned in git' per bd audit --help)."
echo "        A scheduled close leaves exactly one appended audit line in the human's working tree."

echo
echo "-------- $pass passed, $fail failed --------"
[ "$fail" -eq 0 ] || echo "A failure means §4a.6 item 3's measured conclusions no longer hold for this bd version."
exit $(( fail > 0 ))
