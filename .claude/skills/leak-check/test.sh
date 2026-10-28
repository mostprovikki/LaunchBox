#!/bin/sh
# test.sh -- prove each leak-check gate: a bad commit is refused, a clean one goes through.
# Runs in a throwaway repo with the machine's git config shut out. Every fake value is built
# at run time, so this file passes its own gate. Exit 1 on any failed case.
set -u
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export GIT_CONFIG_GLOBAL="$t/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
r="$t/repo"; git init -q "$r"; cd "$r" || exit 1
git config user.name Tester; git config user.email tester@example.com
git config leak-check.email tester@example.com
# stand-in for employer-scan.sh: refuses one made-up word in staged lines or the message
w=forbid; w="${w}denword"
printf '%s\n' '#!/bin/sh' "git diff --cached | grep -q $w && exit 1" \
	"grep -q $w \"\$3\" && exit 1" 'exit 0' > "$t/scan.sh"
git config leak-check.employer-scan "$t/scan.sh"
mkdir -p .claude/skills && cp -R "$here" .claude/skills/leak-check
sh .claude/skills/leak-check/hook.sh . >/dev/null || { echo "FAIL hook.sh"; exit 1; }
git add .claude && git commit -q -m "install" || { echo "FAIL first commit"; exit 1; }

pass=0; fails=0
# case <name> <want: ok|refused> <file> <content> [git commit options...]
case_() {
	name=$1; want=$2; f=$3; body=$4; shift 4
	mkdir -p "$(dirname "$f")"; printf '%s\n' "$body" > "$f"; git add "$f"
	if git commit -q "$@" -m "case: $name" >"$t/out" 2>&1; then got=ok; else got=refused; fi
	if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok    $name ($got)"
	else fails=$((fails+1)); echo "FAIL  $name: want $want, got $got"; sed 's/^/      /' "$t/out"; fi
	[ "$got" = ok ] || { git reset -q; rm -f "$f"; }
}

p=ABCDE; a=AKIA; k=aadh; d=2345; b=HDFC
case_ "clean change"                ok      notes.txt     "plain text"
case_ "fake PAN"                    refused id.txt        "pan ${p}1234F"
case_ "fake IFSC"                   refused bank.txt      "branch ${b}0001234"
case_ "fake AWS key"                refused cfg.txt       "key=${a}QWERTYUIOPASDFGH"
case_ "Aadhaar named in the text"   refused uid.txt       "${k}aar: $d 6789 0123"
case_ "12 digits, no Aadhaar word"  ok      count.txt     "total $d 6789 0123"
case_ "data file (.xlsx)"           refused report.xlsx   "sheet"
case_ "data file (.pdf)"            refused statement.pdf "page"
case_ "CSV at the root"             refused data.csv      "a,b"
case_ "CSV in a fixture folder"     ok      tests/fixtures/rows.csv "a,b"
case_ "employer word in a line"     refused doc.txt       "$w"
case_ "employer word in the message" refused msg.txt      "fine" -m "$w"
case_ "wrong author (--author)"     refused w1.txt        "x" --author "Someone <someone@example.org>"
git config user.email someone@example.org
case_ "wrong author (user.email)"   refused w2.txt        "x"
git config user.email tester@example.com
git config --unset leak-check.email
case_ "no expected address set"     refused w3.txt        "x"
git config leak-check.email tester@example.com
git config leak-check.employer-scan "$t/missing.sh"
case_ "employer scan missing"       refused w4.txt        "x"
git config leak-check.employer-scan "$t/scan.sh"
PATH_SAVE=$PATH; PATH=$(echo "$PATH" | tr ':' '\n' | grep -v -e homebrew -e '/usr/local' | paste -sd: -)
case_ "gitleaks not on PATH"        refused w5.txt        "x"
PATH=$PATH_SAVE

if sh "$here/hook.sh" . --check >/dev/null 2>&1; then pass=$((pass+1)); echo "ok    hook.sh --check passes"
else fails=$((fails+1)); echo "FAIL  hook.sh --check"; fi
hp=$(git rev-parse --absolute-git-dir)/hooks
printf '#!/bin/sh\nexit 0\n' > "$hp/commit-msg"
if sh "$here/hook.sh" . >/dev/null 2>&1; then fails=$((fails+1)); echo "FAIL  hook.sh replaced a foreign hook"
else pass=$((pass+1)); echo "ok    hook.sh keeps a foreign commit-msg hook"; fi
if sh "$here/hook.sh" . --check >/dev/null 2>&1; then fails=$((fails+1)); echo "FAIL  --check passed a foreign hook"
else pass=$((pass+1)); echo "ok    hook.sh --check fails on a foreign hook"; fi

echo "$pass passed, $fails failed"
[ $fails -eq 0 ]
