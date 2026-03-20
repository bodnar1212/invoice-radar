#!/bin/bash
# Registers the native messaging host with Chrome/Chromium

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/native-host/invoice_radar_cookie_host.py"

# Get the extension ID — user must provide it after loading unpacked
EXT_ID="${1:?Usage: $0 <extension-id>}"

# Chrome native messaging hosts directory
NATIVE_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
mkdir -p "$NATIVE_DIR"

# Also support Chromium
CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
mkdir -p "$CHROMIUM_DIR" 2>/dev/null || true

MANIFEST='{
  "name": "invoice_radar_cookie_host",
  "description": "Writes cookie auth files for invoice-radar",
  "path": "'"$HOST_PATH"'",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://'"$EXT_ID"'/"]
}'

echo "$MANIFEST" > "$NATIVE_DIR/invoice_radar_cookie_host.json"
echo "Installed to $NATIVE_DIR/invoice_radar_cookie_host.json"

# Copy to Chromium too if the dir exists
if [ -d "$CHROMIUM_DIR" ]; then
  echo "$MANIFEST" > "$CHROMIUM_DIR/invoice_radar_cookie_host.json"
  echo "Installed to $CHROMIUM_DIR/invoice_radar_cookie_host.json"
fi

echo ""
echo "Done! Restart Chrome and the extension will auto-save cookies."
