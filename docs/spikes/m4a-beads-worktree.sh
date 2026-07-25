#!/bin/bash
# M4a spike item 1 (+2) — re-verify beads' behaviour in git worktrees and its `ready --json` shape.
#
# WHY THIS EXISTS: the M4a design depends on measured `bd` behaviour, and the version policy
# (docs/plans/2026-07-25-m4a-beads-task-sources.md §4a.6) says to upgrade `bd` deliberately and
# re-check. Run this after any `bd` upgrade. Every assertion below corresponds to a claim in
# §4a.6 — a FAIL means the plan's reasoning needs revisiting, not that this script is broken.
#
# This is NOT part of `npm test`: it shells out to the real `bd`, which the unit tests must never
# do. It builds a throwaway fixture repo in a temp dir and removes it on exit.
#
# Verified green against: bd 1.1.0 (Homebrew) + dolt 2.2.2 on 2026-07-25.
set -u
export BD_NON_INTERACTIVE=1

command -v bd >/dev/null || { echo "bd not installed — nothing to verify"; exit 2; }
echo "bd:   $(bd --version 2>&1)"
echo "dolt: $(dolt version 2>&1 | head -1)"
echo

ROOT="$(mktemp -d)/spike"; mkdir -p "$ROOT"
trap 'rm -rf "$(dirname "$ROOT")"' EXIT
P="$ROOT/proj"; W="$ROOT/wt"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; }
check(){ # check <desc> <expected> <actual>
  [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# ---------------------------------------------------------------- fixture
git init -q "$P" && cd "$P" || exit 1
git config user.email spike@local && git config user.name spike
echo "# proj" > README.md && git add -A && git commit -qm init
bd init --non-interactive -p sp >/dev/null 2>&1 || { echo "bd init failed"; exit 1; }

A=$(bd q "blocker A" 2>/dev/null)
B=$(bd q "dependent B" 2>/dev/null)
C=$(bd q "standalone C" 2>/dev/null)
bd dep add "$B" "$A" >/dev/null 2>&1          # B blocked by A
bd label add "$C" unattended >/dev/null 2>&1
U=$(bd q "unlabelled bead" 2>/dev/null)       # deliberately no labels

echo "== §4a.6 item 1: .beads in a worktree =="

# `bd init` commits .beads/ rather than ignoring it.
tracked=$(git ls-files .beads | wc -l | tr -d ' ')
[ "$tracked" -gt 0 ] && ok ".beads/ is tracked by git ($tracked files)" \
  || bad ".beads/ is tracked by git" ">0 tracked files" "$tracked"

# ...but the Dolt data itself is ignored.
git check-ignore -q .beads/embeddeddolt/ \
  && ok "embeddeddolt/ (the actual DB) is gitignored" \
  || bad "embeddeddolt/ is gitignored" "ignored" "NOT ignored"

git worktree add -q "$W" -b wt-scheduled 2>/dev/null

# The load-bearing trap: the dir is present in the worktree, so existsSync() is misleading.
[ -d "$W/.beads" ] && ok "worktree HAS a .beads dir (existsSync would pass)" \
  || bad "worktree has a .beads dir" "present" "absent"
[ -d "$W/.beads/embeddeddolt" ] \
  && bad "worktree .beads is hollow" "no embeddeddolt" "embeddeddolt present" \
  || ok "worktree .beads is HOLLOW — no embeddeddolt"

# bd resolves across the boundary via git, to the primary's DB.
prim_db=$(cd "$P" && bd where --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("database_path",""))')
wt_db=$(cd "$W" && bd where --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("database_path",""))')
check "worktree resolves to the PRIMARY's database_path" "$prim_db" "$wt_db"

# A write from the worktree lands in the primary's DB.
(cd "$W" && bd update "$C" --claim >/dev/null 2>&1)
st=$(cd "$P" && bd show "$C" --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d)["status"])')
check "claim from worktree is visible in primary" "in_progress" "$st"

# Git is the bridge: strip .git and resolution collapses.
cp -R "$W" "$ROOT/plain" && rm -f "$ROOT/plain/.git"
(cd "$ROOT/plain" && bd ready --json >/dev/null 2>&1); rc=$?
check "hollow copy with no .git: ready exits 1" "1" "$rc"
nodb=$(cd "$ROOT/plain" && bd where --json 2>/dev/null | python3 -c 'import sys,json;print("database_path" in json.load(sys.stdin))')
check "hollow copy with no .git: no database_path key" "False" "$nodb"

# BEADS_DIR is the explicit escape hatch and works without git at all.
(cd "$ROOT/plain" && BEADS_DIR="$P/.beads" bd ready --json >/dev/null 2>&1); rc=$?
check "BEADS_DIR works even with no git present" "0" "$rc"

# Polling must not dirty the human's checkout.
(cd "$P" && git add -A .beads >/dev/null 2>&1 && git commit -qm baseline >/dev/null 2>&1)
(cd "$P" && bd ready --json >/dev/null 2>&1); (cd "$W" && bd note "$A" hello >/dev/null 2>&1)
check "reads/writes leave the primary checkout clean" "" "$(cd "$P" && git status --porcelain)"
check "reads/writes leave the worktree clean"         "" "$(cd "$W" && git status --porcelain)"

echo
echo "== §4a.6 item 2: ready --json shape =="

check "empty result is [] with rc 0" "[]" \
  "$(cd "$P" && bd ready --json --label no-such-label 2>/dev/null)"

# Bare array, not an envelope.
top=$(cd "$P" && bd ready --json 2>/dev/null | python3 -c 'import sys,json;print(type(json.load(sys.stdin)).__name__)')
check "ready --json top level is a bare array" "list" "$top"

# issue_type, not type; priority is an int.
(cd "$P" && bd ready --json 2>/dev/null | python3 -c '
import sys,json
r=json.load(sys.stdin)
b=r[0]
print("HASTYPE" if "issue_type" in b and "type" not in b else "BADTYPE")
print("INTPRIO" if isinstance(b["priority"],int) else "BADPRIO")
print("NOASSIGNEE" if "assignee" not in b else "HASASSIGNEE")
' ) > "$ROOT/shape.txt" 2>/dev/null
check "field is issue_type, not type" "HASTYPE"    "$(sed -n 1p "$ROOT/shape.txt")"
check "priority is an int"            "INTPRIO"    "$(sed -n 2p "$ROOT/shape.txt")"
check "ready carries no assignee"     "NOASSIGNEE" "$(sed -n 3p "$ROOT/shape.txt")"

# The trap: an unlabelled bead omits `labels` entirely.
lk=$(cd "$P" && bd ready --json 2>/dev/null | python3 -c "
import sys,json
print(next(('labels' in b) for b in json.load(sys.stdin) if b['id']=='$U'))")
check "unlabelled bead OMITS the labels key" "False" "$lk"

# bd show returns a one-element array.
sh=$(cd "$P" && bd show "$A" --json 2>/dev/null | python3 -c 'import sys,json;print(type(json.load(sys.stdin)).__name__)')
check "bd show --json returns an array" "list" "$sh"

# B is blocked by A (still open) so it is never offered. C was claimed above, so it is
# in_progress and drops out of ready — that is what makes a landed --claim self-excluding.
# A itself is open and unblocked, so it MUST still be offered (guards against over-filtering).
ids=$(cd "$P" && bd ready --json 2>/dev/null | python3 -c 'import sys,json;print(",".join(sorted(b["id"] for b in json.load(sys.stdin))))')
case ",$ids," in *",$B,"*) bad "blocked bead is not offered" "$B absent" "$ids";; *) ok "blocked bead is not offered";; esac
case ",$ids," in *",$C,"*) bad "claimed (in_progress) bead is not offered" "$C absent" "$ids";; *) ok "claimed (in_progress) bead is not offered";; esac
case ",$ids," in *",$A,"*) ok "open unblocked bead IS still offered";; *) bad "open unblocked bead is offered" "$A present" "$ids";; esac

# --explain is a DIFFERENT top-level shape.
ex=$(cd "$P" && bd ready --explain --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(",".join(sorted(k for k in d if k in ("ready","blocked","summary","schema_version"))))')
check "explain --json is an envelope" "blocked,ready,schema_version,summary" "$ex"

# stderr noise on success must not be read as failure.
(cd "$P" && bd ready --json >/dev/null 2>"$ROOT/err.txt"); rc=$?
check "success rc is 0 despite any stderr warnings" "0" "$rc"
[ -s "$ROOT/err.txt" ] && echo "  note  stderr was non-empty on success (expected): $(head -1 "$ROOT/err.txt")"

# --readonly refuses writes (safety belt for the work process).
(cd "$P" && bd --readonly update "$A" --claim >/dev/null 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok "--readonly refuses writes" || bad "--readonly refuses writes" "non-zero" "$rc"

echo
echo "-------- $pass passed, $fail failed --------"
[ "$fail" -eq 0 ] || echo "A failure means §4a.6's measured conclusions no longer hold for this bd version."
exit $(( fail > 0 ))
