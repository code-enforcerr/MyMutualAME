// automation.js
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { chromium } = require('playwright');

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  return _browser;
}

function sanitizeFile(s) {
  return String(s || '')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 100);
}

async function ensureWritablePath(p, suffix = '') {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const ext = path.extname(p) || '.jpg';
  const base = path.basename(p, ext);
  const safe = sanitizeFile(base + (suffix ? `_${suffix}` : '')) + ext;
  return path.join(path.dirname(p), safe);
}

function withUniqueSuffix(p) {
  const ext = path.extname(p) || '.jpg';
  const base = p.slice(0, -ext.length);
  const ts = Date.now();
  return `${base}_${ts}${ext}`;
}

// Normalize to MM/DD/YYYY (similar to bot.js)
function normalizeDOB(input) {
  if (!input) return '';
  const s = String(input).trim();

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;

  // M/D/YY(YY) or MM-DD-YYYY
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(s);
  if (m) {
    let [, a, b, c] = m;
    const mm = String(parseInt(a, 10)).padStart(2, '0');
    const dd = String(parseInt(b, 10)).padStart(2, '0');
    let yyyy = c;
    if (yyyy.length === 2) {
      const yy = parseInt(yyyy, 10);
      yyyy = (yy <= 30 ? 2000 + yy : 1900 + yy).toString();
    }
    return `${mm}/${dd}/${yyyy}`;
  }

  // Fallback
  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${mm}/${dd}/${yyyy}`;
  }
  return s;
}

async function uniqueShotPath(last4, zip) {
  const name = `shot_${sanitizeFile(String(last4 || ''))}_${sanitizeFile(String(zip || ''))}.jpg`;
  return path.join(process.cwd(), 'screenshots', name);
}

async function smartScreenshot(page, outPath) {
  try {
    await page.screenshot({ path: outPath, type: 'jpeg', fullPage: true, quality: 80 });
  } catch {
    await page.screenshot({ path: outPath, type: 'jpeg' });
  }
  return outPath;
}

async function tryClickContinue(page) {
  const candidates = [
    'button:has-text("Continue")',
    'input[type="submit"][value*="Continue" i]',
    '[role="button"]:has-text("Continue")',
    // broaden safely:
    'button:has-text("Next")',
    '[role="button"]:has-text("Next")',
    'button:has-text("Submit")',
    'input[type="submit"]',
    'button[type="submit"]',
  ];
  for (const sel of candidates) {
    try {
      const b = page.locator(sel).first();
      await b.waitFor({ state: 'visible', timeout: 2500 });
      await b.click({ timeout: 2500 });
      return true;
    } catch {}
  }
  return false;
}

async function tryFill(page, selectors, value) {
  const v = String(value ?? '');
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 3500 });
      await loc.fill(v, { timeout: 3500 });
      // small nudge for sites that validate on blur
      try { await loc.press('Tab'); } catch {}
      return true;
    } catch {}
  }
  return false;
}

// ---------- Main export ----------
// Signature: (lastName, dob, zip, last4, screenshotPath?)
async function runAutomation(lastName, dob, zip, last4, screenshotPath) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
  });
  // default timeouts to make failures return promptly (bot handles retries)
  context.setDefaultTimeout?.(10000);
  const page = await context.newPage();

  let status = 'error';
  let shotPath;

  if (screenshotPath) {
    const ensured = await ensureWritablePath(screenshotPath, 'shot');
    shotPath = withUniqueSuffix(ensured); // avoids overwrite if multiple passes
  } else {
    shotPath = await uniqueShotPath(last4, zip);
  }

  try {
    const url =
      process.env.TARGET_URL ||
      'https://myaccount.mutualofamerica.com/UserIdentity/Signup';

    if (!/^https?:\/\//i.test(url)) {
      throw new Error('TARGET_URL must be a valid https URL');
    }

    // Go to page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.locator('form').first().waitFor({ state: 'visible', timeout: 8000 });
    } catch {}

    // Fill fields
    const okLast = await tryFill(page, [
      'label:has-text("Last Name") ~ input',
      'input[placeholder*="Last Name" i]',
      'input[name*="last" i]',
      'input[id*="last" i]',
    ], String(lastName).trim());

    const okDOB = await tryFill(page, [
      'label:has-text("Date of Birth") ~ input',
      'input[placeholder*="Date of Birth" i]',
      'input[placeholder*="DOB" i]',
      'input[name*="dob" i]',
      'input[id*="dob" i]',
    ], normalizeDOB(dob));

    const okZIP = await tryFill(page, [
      'label:has-text("Zip") ~ input',
      'input[placeholder*="Zip" i]',
      'input[name*="zip" i]',
      'input[id*="zip" i]',
      'input[name*="postal" i]',
    ], String(zip).trim());

    const okL4 = await tryFill(page, [
      'label:has-text("Last 4") ~ input',
      'label:has-text("Last 4 Digits of SSN") ~ input',
      'input[placeholder*="Last 4" i]',
      'input[name*="last4" i]',
      'input[id*="last4" i]',
      'input[name*="ssn" i][maxlength="4"]',
      'input[name*="ssn" i][aria-label*="Last 4" i]',
    ], String(last4).trim());

    if (!okLast || !okDOB || !okZIP || !okL4) {
      throw new Error(
        `Could not locate all fields (last:${okLast} dob:${okDOB} zip:${okZIP} last4:${okL4})`
      );
    }

    // Submit
    const clicked = await tryClickContinue(page);
    if (!clicked) throw new Error('Could not find a Continue/Next/Submit button');

    // Observe outcome (adjust strings/selectors to your target page)
    await page.waitForTimeout(1500);
    const outcome = await Promise.race([
      page.locator('text=/success|verified|matches/i').first().waitFor({ timeout: 6000 }).then(() => 'valid').catch(() => null),
      page.locator('text=/invalid|not match|could not verify|doesn\'t match/i').first().waitFor({ timeout: 6000 }).then(() => 'incorrect').catch(() => null),
      page.waitForTimeout(6500).then(() => 'unknown'),
    ]);
    status = outcome || 'unknown';

    await smartScreenshot(page, shotPath);
    return { status, screenshotPath: shotPath };
  } catch (err) {
    try { await smartScreenshot(page, shotPath); } catch {}
    return {
      status: 'error',
      screenshotPath: shotPath,
      error: String((err && err.message) || err),
    };
  } finally {
    try { await context.close(); } catch {}
  }
}

process.on('beforeExit', async () => {
  try {
    if (_browser) await _browser.close();
  } catch {}
});

module.exports = { runAutomation, normalizeDOB };