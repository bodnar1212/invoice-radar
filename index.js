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

// --- Cursor: page scraping approach ---

async function processCursor() {
  console.log('\nProcessing Cursor...');
  const authFile = '/auth/cursor-auth.json';
  if (!fs.existsSync(authFile)) {
    console.log('  Auth file not found — skipping');
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: authFile,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await page.goto('https://cursor.com/dashboard/billing', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(5000);

    if (!page.url().includes('cursor.com/dashboard')) {
      console.log('  Session expired — sending alert');
      await sendEmail(
        '[Cursor] Session Expired — Action Required',
        'Cursor session expired.\n\nRefresh with:\nnpx playwright codegen --save-storage=cursor-auth.json https://cursor.com/dashboard/billing',
      );
      return;
    }

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

async function processClaude() {
  console.log('\nProcessing Claude...');
  const authFile = '/auth/claude-auth.json';
  if (!fs.existsSync(authFile)) {
    console.log('  Auth file not found — skipping');
    return;
  }

  const browser = await chromium.launch({ args: STEALTH_ARGS });
  const context = await browser.newContext({
    storageState: authFile,
    userAgent: STEALTH_UA,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await context.newPage();

  try {
    // Load settings page to pass Cloudflare and get cookies
    await page.goto('https://claude.ai/settings', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForTimeout(12000);

    if (!page.url().includes('claude.ai/settings')) {
      console.log('  Session expired — sending alert');
      await sendEmail(
        '[Claude] Session Expired — Action Required',
        'Claude session expired.\n\nRefresh by copying the sessionKey cookie from your browser into claude-auth.json',
      );
      return;
    }

    // Get org UUID from bootstrap API
    const bootstrapRes = await context.request.get(
      'https://claude.ai/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false'
    );
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

  if (ENABLED_SERVICES.includes('cursor')) await processCursor();
  if (ENABLED_SERVICES.includes('claude')) await processClaude();

  console.log('\nDone.');
})();
