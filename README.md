# invoice-radar

Dockerized script that downloads current-month invoice PDFs from Cursor and Claude, then emails them via AWS SES.

## Setup

### 1. Install the cookie extension

A Chrome extension auto-syncs your session cookies to auth files — no manual copy-pasting.

1. Open `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select the `cookie-extension/` folder
3. Copy the **extension ID** shown on the page
4. Run:
   ```bash
   ./cookie-extension/install-native-host.sh <extension-id>
   ```
5. Restart Chrome

From now on, every time you log into Cursor or Claude, the auth files update automatically.

### 2. Configure environment

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
```

Edit `docker-compose.override.yml`:

```yaml
services:
  invoice-radar:
    environment:
      - AWS_ACCESS_KEY_ID=AKIA...
      - AWS_SECRET_ACCESS_KEY=...
      - AWS_REGION=us-east-1
      - SES_FROM_EMAIL=invoices@yourdomain.com
      - TARGET_EMAIL=you@example.com
      - INVOICE_NAME=Your Name
      - ENABLED_SERVICES=cursor,claude
```

### 3. Build and run

```bash
docker compose build
docker compose run --rm invoice-radar
```

## Automate with cron

Run on the 25th of every month at 10:00 AM:

```
0 10 25 * * cd /path/to/invoice-radar && docker compose run --rm invoice-radar >> /var/log/invoice-radar.log 2>&1
```

## How the cookie extension works

The extension has two parts:

1. **Background service worker** (`background.js`) — runs inside Chrome and listens to `chrome.cookies.onChanged`. Whenever the `WorkosCursorSessionToken` (Cursor) or `sessionKey` (Claude) cookie is set or updated, it formats the cookie into Playwright's `storageState` JSON and sends it to the native host.

2. **Native messaging host** (`native-host/invoice_radar_cookie_host.py`) — a small Python script that Chrome launches as a subprocess. It receives the JSON from the extension and writes it to `cursor-auth.json` or `claude-auth.json` in the project root.

The connection between them is registered by `install-native-host.sh`, which writes a manifest to `~/.config/google-chrome/NativeMessagingHosts/`. This persists across restarts — you only run it once.

```
Chrome cookie changes
  → background.js detects it
    → sends JSON via native messaging
      → invoice_radar_cookie_host.py writes to auth file
```

The extension popup also lets you manually copy auth JSON to clipboard as a fallback.

## Troubleshooting the extension

1. Go to `chrome://extensions`
2. Find "Invoice Radar Cookie Export" → click the **Service worker** link to open its DevTools
3. Reload the extension (click the refresh icon)
4. Visit `claude.ai` or `cursor.com` in another tab
5. Check the console — you should see one of:
   - `Cookie changed: ...` then `Saved ...` — working
   - `Cookie changed: ...` then `Native messaging error: ...` — native host issue, re-run `install-native-host.sh`
   - Nothing — cookie name doesn't match, check that you're logged in

## Refreshing expired sessions

If you get a "Session Expired" email, just log into that service in Chrome — the extension updates the auth file automatically.

## Environment variables

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `SES_FROM_EMAIL` | Sender email (verified in SES) |
| `TARGET_EMAIL` | Recipient email |
| `INVOICE_NAME` | Name to include in invoice email subjects (required) |
| `ENABLED_SERVICES` | Services to process (default: `cursor,claude`) |
