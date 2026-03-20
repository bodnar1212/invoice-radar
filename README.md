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
      - ENABLED_SERVICES=cursor,claude
```

### 3. Build and run

```bash
docker compose build
docker compose run --rm invoice-radar
```

## Automate with cron

Run on the 2nd of every month at 10:00 AM:

```
0 10 2 * * cd /path/to/invoice-radar && docker compose run --rm invoice-radar >> /var/log/invoice-radar.log 2>&1
```

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
| `ENABLED_SERVICES` | Services to process (default: `cursor,claude`) |
