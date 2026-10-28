#!/bin/sh
# leak-check.sh <commit-msg-file> -- the commit-msg hook body (hook.sh wires it in).
# Refuses the commit (exit 1) when any check fails, and when a check cannot run:
#   1. identity: the author or committer email is not `git config leak-check.email`
#   2. data file: a staged .pdf, sheet, database or statement file; a CSV outside a test folder
#   3. gitleaks: a secret or an ID number in the staged changes (gitleaks.toml)
#   4. employer: employer-scan.sh --staged finds a reference in the staged changes, the
#      identity or the message (`git config leak-check.employer-scan`, default below)
# Skip once, on purpose: git commit --no-verify.
set -u
here=$(cd "$(dirname "$0")" && pwd)
msg=${1:?usage: leak-check.sh <commit-msg-file>}
fail=0
say() { echo "leak-check: $*" >&2; }

want=$(git config leak-check.email) || { say "no expected address: set git config leak-check.email"; exit 1; }
for who in AUTHOR COMMITTER; do
	got=$(git var "GIT_${who}_IDENT" | sed -n 's/^.*<\(.*\)>.*$/\1/p')
	[ "$got" = "$want" ] || { say "$who email is <$got>, expected <$want>"; fail=1; }
done

data=$(git diff --cached --name-only --diff-filter=ACMR | grep -iE '\.(pdf|xlsx|xls|xlsm|ods|db|sqlite|sqlite3|tsv|ofx|qif)$')
csv=$(git diff --cached --name-only --diff-filter=ACMR | grep -iE '\.csv$' | grep -vE '(^|/)(tests?|fixtures?|testdata|e2e|__fixtures__)/')
[ -z "$data$csv" ] || { say "data file staged (keep it out of git):"; printf '%s\n' $data $csv | sed 's/^/  /' >&2; fail=1; }

if command -v gitleaks >/dev/null 2>&1; then
	out=$(gitleaks git --pre-commit --staged --no-banner --redact -c "$here/gitleaks.toml" . 2>&1)
	rc=$?
	if [ $rc -ne 0 ]; then say "gitleaks found leaks (rc $rc):"; echo "$out" >&2; fail=1; fi
else
	say "gitleaks is not installed (brew install gitleaks)"; fail=1
fi

scan=$(git config leak-check.employer-scan || echo "$HOME/.claude/scripts/employer-scan.sh")
if [ -f "$scan" ]; then
	zsh "$scan" --staged . "$msg" >&2 || { say "employer reference (see above)"; fail=1; }
else
	say "employer scan not found: $scan"; fail=1
fi

[ $fail -eq 0 ] || say "commit refused"
exit $fail
