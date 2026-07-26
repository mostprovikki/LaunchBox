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

mkdir -p "$DATA" "$DATA/bin" "$HOME/Library/LaunchAgents"

# The approval helper (docs/specs/2026-07-26-local-api-auth-design.md, Layer 2).
#
# Compiled from source here rather than shipped as a binary, for two reasons:
# a downloaded prebuilt Mach-O gets flagged and removed by XProtect (the same
# problem this repo already documents for better-sqlite3), and swiftc emits the
# adhoc signature that Apple Silicon *requires* to execute at all.
#
# The output filename is load-bearing: it becomes the title of the system
# approval dialog, so it must read as the product and nothing else.
if [ "$(uname)" = "Darwin" ]; then
  if command -v swiftc >/dev/null; then
    swiftc -O -o "$DATA/bin/LaunchBox" helper/LaunchBox.swift
    # Record the checksum beside the binary and verify it before every spawn. An
    # attacker who can overwrite the binary can usually overwrite this too, so it
    # does not make the gate unbypassable -- it makes tampering LOUD, requires two
    # coordinated writes instead of one silent one, and fails closed on a partial
    # attempt. 0500/0700 also keeps any *other* account on the machine out.
    shasum -a 256 "$DATA/bin/LaunchBox" | awk '{print $1}' > "$DATA/bin/LaunchBox.sha256"
    chmod 0500 "$DATA/bin/LaunchBox"
    chmod 0400 "$DATA/bin/LaunchBox.sha256"
    chmod 0700 "$DATA/bin"
    # Verifying by running --check (which never prompts) also detects tampering
    # for free: a patched or re-signed binary is SIGKILLed rather than misbehaving.
    if "$DATA/bin/LaunchBox" --check >/dev/null 2>&1; then
      echo "✓ approval helper built — high-power actions will ask for Touch ID"
    else
      echo "⚠ approval helper built but will not authenticate on this machine."
      echo "  High-power actions (creating jobs, activating projects) will be REFUSED."
    fi
  else
    echo "⚠ swiftc not found, so the approval helper was not built."
    echo "  High-power actions will be REFUSED until you install the Xcode command"
    echo "  line tools (xcode-select --install) and re-run this script."
  fi
fi

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
# Liveness is checked against the static shell, NOT /api/settings: every /api
# route now requires the capability token, so an authenticated probe would need
# the key and an unauthenticated one answers 401 — which `curl -sf` treats as
# failure, making a perfectly healthy daemon report itself as still starting.
if curl -sf "http://127.0.0.1:${CS_PORT:-9099}/" >/dev/null; then
  echo "✓ claude-scheduler running"
else
  echo "daemon starting… check $DATA/daemon.log"
fi

# The UI is unreachable without the token, so hand it over rather than printing
# a bare URL that would just show the "no session key" banner.
echo ""
echo "Open the UI with:"
echo "  node $TOOL_DIR/bin/claude-scheduler.mjs open"
echo ""
echo "That prints a one-time URL carrying your session key and opens it. The key"
echo "lives in $DATA/token (mode 0600). Anything without it gets a 401, which is"
echo "what stops a web page you visit from driving this API."
