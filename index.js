const { chromium } = require('playwright');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const https = require('https');

const now = new Date();
const MONTH_LONG = now.toLocaleString('en-US', { month: 'long' });
const MONTH_SHORT = now.toLocaleString('en-US', { month: 'short' });
const YEAR = now.getFullYear();
const MONTH = now.getMonth();
const MONTH_YEAR = `${MONTH_LONG} ${YEAR}`;

const INVOICE_NAME = process.env.INVOICE_NAME;
if (!INVOICE_NAME) {
  console.error('Error: INVOICE_NAME environment variable is required');
  process.exit(1);
}

const ENABLED_SERVICES = (process.env.ENABLED_SERVICES || 'cursor,claude').split(',').map(s => s.trim().toLowerCase());

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const STEALTH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// --- Email helpers ---

async function sendEmail(subject, text, attachment) {
  const sesClient = new SESClient({ region: process.env.AWS_REGION });
  const transporter = nodemailer.createTransport({ streamTransport: true });

  const mailOpts = {
    from: process.env.SES_FROM_EMAIL,
    to: process.env.TARGET_EMAIL.split(',').map(e => e.trim()),
    subject,
    text,
  };
  if (attachment) {
    mailOpts.attachments = [{
      filename: attachment.filename,
      content: attachment.content,
      contentType: 'application/pdf',
    }];
  }

  const info = await transporter.sendMail(mailOpts);
  const chunks = [];
  for await (const chunk of info.message) chunks.push(chunk);
  await sesClient.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.concat(chunks) },
  }));
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// --- Session checks ---

async function checkCursorSession() {
  const authFile = '/auth/cursor-auth.json';
  if (!fs.existsSync(authFile)) return { valid: false, reason: 'auth file not found' };

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: authFile, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto('https://cursor.com/dashboard/billing', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(5000);

    if (!page.url().includes('cursor.com/dashboard')) {
      await browser.close();
      return { valid: false, reason: 'session expired' };
    }
    return { valid: true, browser, context, page };
  } catch (err) {
    await browser.close();
    return { valid: false, reason: err.message };
  }
}

async function checkClaudeSession() {
  const authFile = '/auth/claude-auth.json';
  if (!fs.existsSync(authFile)) return { valid: false, reason: 'auth file not found' };

  const browser = await chromium.launch({ args: STEALTH_ARGS });
  const context = await browser.newContext({ storageState: authFile, userAgent: STEALTH_UA });

  try {
    const bootstrapRes = await context.request.get(
      'https://claude.ai/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false'
    );

    if (!bootstrapRes.ok()) {
      await browser.close();
      return { valid: false, reason: `API returned ${bootstrapRes.status()}` };
    }
    return { valid: true, browser, context, bootstrapRes };
  } catch (err) {
    await browser.close();
    return { valid: false, reason: err.message };
  }
}

// --- Cursor: page scraping approach ---

async function processCursor(session) {
  console.log('\nProcessing Cursor...');
  const { browser, context, page } = session;

  try {
    const pdfPath = await findCursorInvoice(context, page);
    if (pdfPath) {
      console.log(`  Downloaded: ${pdfPath}`);
      await sendEmail(
        `INVOICE Cursor [${MONTH_LONG}] [${INVOICE_NAME}]`,
        `Attached: Cursor invoice for ${MONTH_YEAR}.`,
        { filename: `Cursor-Invoice-${MONTH_LONG}-${YEAR}.pdf`, content: fs.readFileSync(pdfPath) },
      );
      console.log('  Email sent!');
      fs.unlinkSync(pdfPath);
    } else {
      console.log(`  No invoice found for ${MONTH_YEAR} — skipping`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  } finally {
    await browser.close();
  }
}

async function findCursorInvoice(context, page) {
  const monthPatterns = [`${MONTH_SHORT} `, `${MONTH_LONG} `, MONTH_YEAR, `${MONTH_SHORT} ${YEAR}`];

  // Find Stripe invoice links on the page
  const links = await page.locator('a[href*="invoice.stripe.com"]').all();

  for (const link of links) {
    const href = await link.getAttribute('href');
    const parentText = await link.evaluate(el => {
      let node = el;
      for (let i = 0; i < 5; i++) {
        if (node.parentElement) node = node.parentElement;
        const text = node.textContent || '';
        if (text.length > 20 && text.length < 500) return text;
      }
      return node.textContent || '';
    });

    const matchesMonth = monthPatterns.some(p => parentText.includes(p));
    const matchesYear = parentText.includes(String(YEAR));

    if (matchesMonth && matchesYear) {
      console.log(`  Found Stripe invoice link`);
      return await downloadStripeInvoice(context, href);
    }
  }

  return null;
}

async function downloadStripeInvoice(context, stripeUrl) {
  const page = await context.newPage();
  try {
    await page.goto(stripeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const downloadBtn = page.locator(
      'a:has-text("Download invoice"), a:has-text("Download PDF"), ' +
      'a[href*=".pdf"], button:has-text("Download")'
    );

    if (await downloadBtn.count() > 0) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        downloadBtn.first().click(),
      ]);
      const filePath = path.join('/tmp', download.suggestedFilename() || 'invoice.pdf');
      await download.saveAs(filePath);
      return filePath;
    }
  } catch (e) {
    console.log(`  Stripe download error: ${e.message}`);
  } finally {
    await page.close();
  }
  return null;
}

// --- Claude: API approach (bypasses Cloudflare) ---

async function processClaude(session) {
  console.log('\nProcessing Claude...');
  const { browser, context, bootstrapRes } = session;

  try {
    const bootstrap = await bootstrapRes.json();
    const orgUuid = bootstrap.account?.memberships?.[0]?.organization?.uuid;

    if (!orgUuid) {
      console.log('  Could not find organization UUID — skipping');
      return;
    }
    console.log(`  Org UUID: ${orgUuid}`);

    // Fetch invoices via Stripe API (bypasses Cloudflare via context.request)
    const invoicesRes = await context.request.get(
      `https://claude.ai/api/stripe/${orgUuid}/invoices?limit=12`
    );
    const invoices = await invoicesRes.json();

    if (!Array.isArray(invoices) || invoices.length === 0) {
      console.log('  No invoices found — skipping');
      return;
    }

    // Find invoice matching current month
    const currentMonthInvoice = invoices.find(inv => {
      const date = new Date(inv.created_ts * 1000);
      return date.getMonth() === MONTH && date.getFullYear() === YEAR;
    });

    if (!currentMonthInvoice) {
      console.log(`  No invoice found for ${MONTH_YEAR} — skipping`);
      return;
    }

    if (!currentMonthInvoice.invoice_pdf_url) {
      console.log('  Invoice found but no PDF URL — skipping');
      return;
    }

    console.log(`  Found invoice: ${currentMonthInvoice.status}, ${currentMonthInvoice.total / 100} ${currentMonthInvoice.currency.toUpperCase()}`);

    // Download PDF directly from Stripe
    const pdfBuffer = await downloadFile(currentMonthInvoice.invoice_pdf_url);
    const filePath = path.join('/tmp', `Claude-Invoice-${MONTH_LONG}-${YEAR}.pdf`);
    fs.writeFileSync(filePath, pdfBuffer);
    console.log(`  Downloaded: ${filePath} (${pdfBuffer.length} bytes)`);

    await sendEmail(
      `INVOICE Claude [${MONTH_LONG}] [${INVOICE_NAME}]`,
      `Attached: Claude invoice for ${MONTH_YEAR}.`,
      { filename: `Claude-Invoice-${MONTH_LONG}-${YEAR}.pdf`, content: pdfBuffer },
    );
    console.log('  Email sent!');
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  } finally {
    await browser.close();
  }
}

// --- Main ---

(async () => {
  console.log(`Looking for invoices for: ${MONTH_YEAR}`);
  console.log(`Enabled services: ${ENABLED_SERVICES.join(', ')}`);

  // Phase 1: Check all sessions before processing anything
  const sessions = {};
  const expired = [];

  if (ENABLED_SERVICES.includes('cursor')) {
    console.log('\nChecking Cursor session...');
    sessions.cursor = await checkCursorSession();
    if (sessions.cursor.valid) {
      console.log('  Session OK');
    } else {
      console.log(`  ${sessions.cursor.reason}`);
      expired.push('Cursor');
    }
  }

  if (ENABLED_SERVICES.includes('claude')) {
    console.log('\nChecking Claude session...');
    sessions.claude = await checkClaudeSession();
    if (sessions.claude.valid) {
      console.log('  Session OK');
    } else {
      console.log(`  ${sessions.claude.reason}`);
      expired.push('Claude');
    }
  }

  // If any session is expired, send alerts and abort
  if (expired.length > 0) {
    console.log(`\nSession check failed for: ${expired.join(', ')} — aborting all services`);

    if (expired.includes('Cursor')) {
      await sendEmail(
        '[Cursor] Session Expired — Action Required',
        'Cursor session expired.\n\nRefresh with:\nnpx playwright codegen --save-storage=cursor-auth.json https://cursor.com/dashboard/billing',
      );
    }
    if (expired.includes('Claude')) {
      await sendEmail(
        '[Claude] Session Expired — Action Required',
        'Claude session expired.\n\nRefresh by copying the sessionKey cookie from your browser into claude-auth.json',
      );
    }

    // Clean up any valid sessions that were opened
    for (const s of Object.values(sessions)) {
      if (s.valid && s.browser) await s.browser.close();
    }

    console.log('\nDone.');
    return;
  }

  // Phase 2: All sessions valid — process invoices
  if (sessions.cursor?.valid) await processCursor(sessions.cursor);
  if (sessions.claude?.valid) await processClaude(sessions.claude);

  console.log('\nDone.');
})();
