#!/bin/zsh
# Uninstall launchbox: stop the daemon and remove schedules/data.
# The source tree (this dir) is intentionally KEPT — deleting it here is what
# wiped the app before. It is printed for manual removal instead. Idempotent.
LABEL="com.launchbox"
LEGACY_LABEL="com.claude-scheduler" # legacy (pre-M6) launchd label
TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"

for L in "$LABEL" "$LEGACY_LABEL"; do
  launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
rm -rf "$HOME/.launchbox"
echo "launchbox uninstalled: daemon stopped, schedules and data removed."
echo "Source code left at $TOOL_DIR"
echo "To delete the source too, run:  rm -rf \"$TOOL_DIR\""
