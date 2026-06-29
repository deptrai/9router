#!/usr/bin/env bash
# 1-lệnh: kill old → fix config → start MITM → dns-on windsurf
# Usage: sudo ./dev.sh
set -e
cd "$(dirname "$0")"

echo "=== 9R MITM Quick Start ==="

# Kill old process on :443
OLD_PID=$(lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "⏹ Killing old MITM (pid $OLD_PID)..."
  kill -9 $OLD_PID 2>/dev/null || true
fi

# Fix config defaults
node bin/mitm-client.js config routerUrl http://localhost:20128
node bin/mitm-client.js config mitmDebug true

# Start MITM in background
echo "🚀 Starting MITM..."
node bin/mitm-client.js start &
MITM_PID=$!
sleep 2

# Enable DNS redirect
echo "🌐 Enabling DNS redirect for windsurf..."
node bin/mitm-client.js dns-on windsurf || true

echo ""
echo "✅ Ready! MITM pid=$MITM_PID on :443 → localhost:20128"
echo "   Test: devin -- \"hello\""
echo "   Stop: sudo kill $MITM_PID && node bin/mitm-client.js dns-off windsurf"
echo ""
wait $MITM_PID
