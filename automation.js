// automation.js
const { chromium } = require('playwright');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let _browser = null;

// Viewport tuned so the panel renders at a similar scale to your sample.
// You can tweak via env if needed.
const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || '800', 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || '980', 10);
const JPEG_QUALITY = Math.min(95, Math.max(30, parseInt(process.env.JPEG_QUALITY || '70', 10)));
const RESULT_TIMEOUT_MS = parseInt(process.env.RESULT_TIMEOUT_MS || '8000', 10);

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  return _browser;
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sanitize(s = '') { return String(s).replace(/[^a-z0-9._-]/gi, '_'); }

async function ensureWritablePath(p) { await fsp.mkdir(path.dirname(p), { recursive: true }); return p; }
function withUniqueSuffix(p) { const ext = path.extname(p) || '.jpg'; const base = p.slice(0, -ext.length); return `${base}_${ts()}${ext}`; }

// Accept common forms and normalize to MM/DD/YYYY
function normalizeDOB(input) {
  if (!input) return '';
  const s = String(input).trim();
  let m;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return `${m[2]}/${m[3]}/${m[1]}`;
  if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s))) {
    let [, a, b, c] = m;
    const mm = String(parseInt(a,10)).padStart(2,'0');
    const dd = String(parseInt(b,10)).padStart(2,'0');
    let yyyy = c;
    if (yyyy.length === 2) yyyy = (parseInt(yyyy,10) <= 30 ? 2000 + parseInt(yyyy,10) : 1900 + parseInt(yyyy,10)).toString();
    return `${mm}/${dd}/${yyyy}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
  return s;
}

async function uniqueShotPath(last4, zip) {
  const dir = process.env.SHOT_DIR || path.resolve('screenshots');
  await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, `shot_${sanitize(last4)}_${sanitize(zip)}.jpg`);
}

async function tryClickContinue(page) {
  const candidates = [
    'button:has-text("Continue")',
    'button:has-text("CONTINUE")',
    'input[type="submit"][value*="Continue" i]',
    '[role="button"]:has-text("Continue")',
    'button[type="submit"]',
  ];
  for (const sel of candidates) {
    try {
      const b = page.locator(sel).first();
      await b.waitFor({ state: 'visible', timeout: 4000 });
      await b.scrollIntoViewIfNeeded().catch(()=>{});
      await b.click({ timeout: 4000 });
      return true;
    } catch {}
  }
  return false;
}

async function tryFill(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 4000 });
      await el.scrollIntoViewIfNeeded().catch(()=>{});
      await el.click({ timeout: 2000 }).catch(()=>{});
      await el.fill(''); // clear first
      await el.type(String(value), { delay: 30 });
      return true;
    } catch {}
  }
  return false;
}

// NEW: take a screenshot of exactly the central panel (alert + inputs + buttons)
async function screenshotPanel(page, outPath) {
  // Prefer a form that contains the Continue button
  let target = page.locator('form:has(button:has-text("Continue"))').first();
  try {
    await target.waitFor({ state: 'visible', timeout: 4000 });

    // Many sites wrap the form in a panel <div> that also contains the red alert.
    // Jump one level up if that parent contains a heading/alert; this matches your sample.
    const parent = target.locator('..');
    try {
      const hasAlert = await parent.locator('text=/unable to confirm your identity/i').count();
      const hasHeading = await parent.locator('text=/Verify your Identity/i').count();
      if (hasAlert || hasHeading) target = parent;
    } catch {}

    await target.screenshot({ path: outPath, type: 'jpeg', quality: JPEG_QUALITY });
    return outPath;
  } catch {
    // Fallback: visible viewport (not full page)
    await page.screenshot({ path: outPath, type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
    return outPath;
  }
}

// Result classifier — maps the red alert to "incorrect"
async function classifyResult(page) {
  const incorrectMatchers = [
    /We are unable to confirm your identity/i,
    /could not verify/i,
    /doesn[’']?t match/i,
    /not match/i
  ];
  for (const re of incorrectMatchers) {
    if (await page.locator(`text=/${re.source}/`).first().isVisible().catch(() => false)) return 'incorrect';
    const alert = page.locator('[role="alert"], .alert, .alert-danger, .usa-alert').filter({ hasText: re });
    if (await alert.first().isVisible().catch(() => false)) return 'incorrect';
  }
  const validMatchers = [
    /verified/i, /success/i, /we found your account/i, /security code/i, /verification code/i
  ];
  for (const re of validMatchers) {
    if (await page.locator(`text=/${re.source}/`).first().isVisible().catch(() => false)) return 'valid';
  }
  return 'unknown';
}

// Signature: (lastName, dob, zip, last4, screenshotPath?)
async function runAutomation(lastName, dob, zip, last4, screenshotPath) {
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    deviceScaleFactor: 1.0,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
  });

  // Keep it fast, but don't block fonts/CSS (labels can depend on webfonts)
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'media' || t === 'image') return route.abort(); // allow fonts & css
    return route.continue();
  });

  const page = await context.newPage();

  let shotPath;
  if (screenshotPath) {
    const ensured = await ensureWritablePath(screenshotPath);
    shotPath = withUniqueSuffix(ensured);
  } else {
    shotPath = withUniqueSuffix(await uniqueShotPath(last4, zip));
  }

  let status = 'error';
  try {
    const url = process.env.TARGET_URL || '';
    if (!/^https?:\/\//i.test(url) || /YOUR_AUTHORIZED_URL_HERE|dommy/i.test(url)) {
      throw new Error('TARGET_URL is not set to a real authorized https URL');
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Fill the four fields (labels/placeholders matching your UI)
    const okLast = await tryFill(page, [
      'label:has-text("Last Name") ~ input',
      'input[placeholder*="Last Name" i]',
      'input[name*="last" i]',
      'input[id*="last" i]'
    ], String(lastName).trim());

    const okDOB = await tryFill(page, [
      'label:has-text("Date of Birth") ~ input',
      'input[placeholder*="mm/dd/yyyy" i]',
      'input[placeholder*="DOB" i]',
      'input[name*="dob" i]',
      'input[id*="dob" i]'
    ], normalizeDOB(dob));

    const okZIP = await tryFill(page, [
      'label:has-text("US Zip Code") ~ input',
      'input[placeholder*="Zip" i]',
      'input[name*="zip" i]',
      'input[id*="zip" i]',
      'input[name*="postal" i]'
    ], String(zip).trim());

    const okL4 = await tryFill(page, [
      'label:has-text("Last 4 Digits of SSN") ~ input',
      'input[placeholder*="Last 4" i]',
      'input[name*="last4" i]',
      'input[id*="last4" i]',
      'input[name*="ssn" i][maxlength="4"]'
    ], String(last4).trim());

    if (!okLast || !okDOB || !okZIP || !okL4) {
      throw new Error(`Could not locate all fields (last:${okLast} dob:${okDOB} zip:${okZIP} last4:${okL4})`);
    }

    const clicked = await tryClickContinue(page);
    if (!clicked) throw new Error('Could not find the Continue button');

    // Give the page time to respond and render any alert
    try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
    await page.waitForTimeout(1200);

    // Try to classify outcome for a few cycles
    const deadline = Date.now() + RESULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const c = await classifyResult(page);
      if (c !== 'unknown') { status = c; break; }
      await page.waitForTimeout(250);
    }
    if (status === 'error' || status === 'unknown') status = await classifyResult(page);

    // EXACT PANEL SHOT (alert + inputs + buttons)
    await screenshotPanel(page, shotPath);

    return { status, screenshotPath: shotPath };
  } catch (err) {
    const reason = err?.message || String(err);
    try {
      // Fallback: capture viewport + write a small note for debugging
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: JPEG_QUALITY, fullPage: false });
      const notePath = shotPath.replace(/\.jpe?g$/i, '.txt');
      await fsp.writeFile(notePath, `Error: ${reason}\nURL: ${await page.url().catch(()=>'?')}\n`, 'utf8');
    } catch {}
    return { status: 'error', screenshotPath: shotPath, error: reason };
  } finally {
    try { await context.close(); } catch {}
  }
}

process.on('beforeExit', async () => { try { if (_browser) await _browser.close(); } catch {} });

module.exports = { runAutomation, normalizeDOB };