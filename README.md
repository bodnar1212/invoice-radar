# invoice-radar

Dockerized script that downloads current-month invoice PDFs from Cursor and Claude billing pages using Playwright, then sends them via AWS SES.

## Prerequisites

- Docker
- AWS account with SES configured (both sender and recipient verified if in sandbox mode)

## Setup

### 1. Create auth cookie files (one-time)

**Option A: Automatic extraction (recommended)**

Close Chrome completely, then run:

```bash
npm install
npx playwright install chrome
npm run extract-cookies
```

This opens your system Chrome, extracts the session cookies, and saves `cursor-auth.json` and `claude-auth.json` automatically.

**Option B: Manual extraction**

1. Open the service in Chrome (e.g. https://cursor.com/dashboard/billing)
2. DevTools (F12) → Application → Cookies
3. Copy the cookie value and create the JSON file:

**Cursor** — cookie name: `WorkosCursorSessionToken`

```json
{
  "cookies": [
    {
      "name": "WorkosCursorSessionToken",
      "value": "PASTE_YOUR_TOKEN_HERE",
      "domain": "cursor.com",
      "path": "/",
      "expires": -1,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": []
}
```

**Claude** — cookie name: `sessionKey`

```json
{
  "cookies": [
    {
      "name": "sessionKey",
      "value": "PASTE_YOUR_SESSION_KEY_HERE",
      "domain": ".claude.ai",
      "path": "/",
      "expires": -1,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": []
}
```

> Sessions last weeks to months. If they expire, the script sends you an alert email.

### 2. Configure environment variables

Copy the override template and fill in your values:

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

> To disable a service, remove it from `ENABLED_SERVICES`. For example, `ENABLED_SERVICES=cursor` will only process Cursor invoices.

> This file is gitignored. Docker Compose merges it automatically with `docker-compose.yml`.

### 3. Build Docker image

```bash
docker compose build
```

## Usage

### Run manually

```bash
docker compose run --rm invoice-radar
```

### Run via cron (monthly)

Run on the 2nd of every month at 10:00 AM (gives billing systems time to generate invoices):

```bash
crontab -e
```

Add:

```
0 10 2 * * cd /path/to/invoice-radar && docker compose run --rm invoice-radar >> /var/log/invoice-radar.log 2>&1
```

Replace `/path/to/invoice-radar` with the actual path to your project directory.

## How it works

**Cursor:**
1. Opens billing page with saved cookie
2. Finds Stripe invoice link matching the current month
3. Navigates to Stripe and downloads the PDF

**Claude:**
1. Loads settings page to pass Cloudflare
2. Calls internal API (`/api/stripe/{org}/invoices`) to list invoices
3. Downloads PDF directly from Stripe's `invoice_pdf_url`

Both PDFs are sent as email attachments via AWS SES.

## Emails sent

| Scenario | Subject |
|---|---|
| Invoice found | `INVOICE Cursor [March] [Andrei Bodnar]` |
| Invoice found | `INVOICE Claude [March] [Andrei Bodnar]` |
| Session expired | `[Cursor] Session Expired — Action Required` |

## Refreshing expired sessions

If you receive a "Session Expired" email, repeat step 1 for that service — copy the fresh cookie from your browser into the auth JSON file.

## Environment variables

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | AWS region (e.g. `us-east-1`) |
| `SES_FROM_EMAIL` | Sender email (must be verified in SES) |
| `TARGET_EMAIL` | Recipient email |
| `ENABLED_SERVICES` | Comma-separated list of services to process (default: `cursor,claude`) |

## Files

```
.
├── index.js                             # Main script
├── Dockerfile                           # Container definition
├── package.json                         # Dependencies
├── docker-compose.yml                   # Docker Compose config (pushed to git)
├── docker-compose.override.example.yml  # Override template (pushed to git)
├── docker-compose.override.yml          # Your env vars (gitignored)
├── cursor-auth.json                     # Saved Cursor session (gitignored)
└── claude-auth.json                     # Saved Claude session (gitignored)
```
