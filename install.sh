#!/bin/zsh
# Install claude-scheduler: deps + launchd agent (RunAtLoad + KeepAlive).
set -e
cd "$(dirname "$0")"
TOOL_DIR="$PWD"
LABEL="com.claude-scheduler"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA="$HOME/.claude-scheduler"
NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }

npm install --omit=dev --no-audit --no-fund

mkdir -p "$DATA" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TOOL_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$TOOL_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/daemon.log</string>
  <key>StandardErrorPath</key><string>$DATA/daemon.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 1
if curl -sf http://127.0.0.1:${CS_PORT:-9099}/api/settings >/dev/null; then
  echo "✓ claude-scheduler running — http://127.0.0.1:${CS_PORT:-9099}"
else
  echo "daemon starting… check $DATA/daemon.log — UI at http://127.0.0.1:${CS_PORT:-9099}"
fi
