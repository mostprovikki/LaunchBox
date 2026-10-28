#!/bin/sh
# hook.sh <repo-root> [--check] -- wire leak-check.sh into the repo's commit-msg hook.
# Writes <hooks dir>/commit-msg (core.hooksPath, else .git/hooks); refuses to replace a
# commit-msg hook it did not write. --check: exit 1 unless the hook, the installed skill copy,
# gitleaks and leak-check.email are all in place (a check that cannot run must fail).
set -eu
repo=$(cd "${1:?usage: hook.sh <repo-root> [--check]}" && pwd)
mark="# leak-check hook (ai-skills leak-check)"
hp=$(git -C "$repo" config core.hooksPath || true)
case "$hp" in "") hp=$(git -C "$repo" rev-parse --absolute-git-dir)/hooks ;; /*) ;; *) hp="$repo/$hp" ;; esac
hook="$hp/commit-msg"

if [ "${2:-}" = "--check" ]; then
	rc=0
	grep -qF "$mark" "$hook" 2>/dev/null || { echo "no leak-check commit-msg hook: $hook" >&2; rc=1; }
	[ -x "$hook" ] || { echo "hook not executable: $hook" >&2; rc=1; }
	[ -f "$repo/.claude/skills/leak-check/leak-check.sh" ] || { echo "skill not installed in $repo" >&2; rc=1; }
	command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks not installed" >&2; rc=1; }
	git -C "$repo" config leak-check.email >/dev/null || { echo "leak-check.email not set for $repo" >&2; rc=1; }
	[ $rc -eq 0 ] && echo "leak-check hook ok: $hook"
	exit $rc
fi

if [ -e "$hook" ] && ! grep -qF "$mark" "$hook"; then
	echo "refusing: $hook exists and is not the leak-check hook; merge it by hand" >&2; exit 1
fi
mkdir -p "$hp"
cat > "$hook" <<EOF
#!/bin/sh
$mark
# Runs the repo's installed copy; a linked worktree without one uses the main worktree's copy.
s=.claude/skills/leak-check/leak-check.sh
top=\$(git rev-parse --show-toplevel)
main=\$(dirname "\$(git rev-parse --path-format=absolute --git-common-dir)")
for d in "\$top" "\$main"; do [ -f "\$d/\$s" ] && exec sh "\$d/\$s" "\$@"; done
echo "leak-check: \$s not found; install it: ~/mydevelopment/skills/install.sh <repo> leak-check" >&2
exit 1
EOF
chmod +x "$hook"
echo "wrote $hook"
