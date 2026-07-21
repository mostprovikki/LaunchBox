#!/bin/zsh
# Uninstall claude-scheduler: stop the daemon and remove schedules/data.
# The source tree (this dir) is intentionally KEPT — deleting it here is what
# wiped the app before. It is printed for manual removal instead. Idempotent.
LABEL="com.claude-scheduler"
TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/.claude-scheduler"
echo "claude-scheduler uninstalled: daemon stopped, schedules and data removed."
echo "Source code left at $TOOL_DIR"
echo "To delete the source too, run:  rm -rf \"$TOOL_DIR\""
