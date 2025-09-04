// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const { runAutomation } = require('./automation');

// ================== Config knobs (env-overridable) ==================
const MAX_ENTRIES       = parseInt(process.env.MAX_ENTRIES || '70', 10);
const CONCURRENCY       = parseInt(process.env.CONCURRENCY || '1', 10);       // default 1 (gentle); override via env
const ENTRY_TIMEOUT_MS  = parseInt(process.env.ENTRY_TIMEOUT_MS || '80000', 10);
const RETRY_ERRORS      = parseInt(process.env.RETRY_ERRORS || '1', 10);      // retry passes after the first run
const RETRY_DELAY_MS    = parseInt(process.env.RETRY_DELAY_MS || '2000', 10); // ms between retry passes
const OUTPUT_ROOT       = process.env.OUTPUT_ROOT || path.join(__dirname, 'screenshots');
// ===================================================================

// --- Fail fast if token is missing ---
if (!process.env.TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

console.log('⚙️  CONCURRENCY =', CONCURRENCY);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// --- Parse approved users from env (as strings) ---
const rawApproved = (process.env.APPROVED_USERS || '').trim(); // e.g. "8134029062,123456789"
const approvedUsers = rawApproved
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isApproved(id) {
  const idStr = String(id).trim();
  return approvedUsers.length === 0 || approvedUsers.includes(idStr);
}

// ---------- Small utils ----------
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function normalizeDobToMMDDYYYY(input) {
  if (!input) return null;
  const s = String(input).trim();

  // YYYY-MM-DD -> MM/DD/YYYY
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
    if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31 || +yyyy < 1900 || +yyyy > 2100) return null;
    return `${mm}/${dd}/${yyyy}`;
  }

  // Fallback to Date()
  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${mm}/${dd}/${yyyy}`;
  }
  return null;
}

/**
 * NEW INTAKE FORMAT:
 * Per line (comma OR pipe):
 *   LASTNAME,DOB,ZIP,LAST4
 *   e.g. "Martines,02/23/1961,30331,9631"
 */
function parseEntryLine(raw) {
  if (!raw) return { ok:false, error:'empty_line', raw };
  let s = raw.normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .replace(/[，、]/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = s.split(/[|,]/).map(t => t.trim());
  if (parts.length !== 4) return { ok:false, error:'bad_field_count', raw, got: parts.length };

  const [lastNameRaw, dobRaw, zipRaw, last4Raw] = parts;

  const lastName = lastNameRaw.replace(/[^a-zA-Z' -]/g, '').trim();
  if (!lastName) return { ok:false, error:'invalid_lastname', raw, value:lastNameRaw };

  const dob = normalizeDobToMMDDYYYY(dobRaw);
  if (!dob) return { ok:false, error:'invalid_dob', raw, value:dobRaw };

  const zip = /^\d{5}(?:-\d{4})?$/.test(zipRaw) ? zipRaw : null;
  if (!zip) return { ok:false, error:'invalid_zip', raw, value:zipRaw };

  const last4 = /^\d{4}$/.test(last4Raw) ? last4Raw : null;
  if (!last4) return { ok:false, error:'invalid_last4', raw, value:last4Raw };

  return { ok:true, lastName, dob, zip, last4, raw:s };
}

function parseBulk(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));

  const out = [];
  for (const [i, line] of lines.entries()) {
    const r = parseEntryLine(line);
    out.push({ index: i + 1, input: line, ...r });
  }
  return out;
}

// --- Simple semaphore for concurrency ---
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(v => { active--; resolve(v); next(); })
        .catch(e => { active--; reject(e); next(); });
  };
  return async fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// --- Per-chat workspace helpers ---
async function getBatchDir(chatId) {
  const base = path.join(OUTPUT_ROOT, `chat_${chatId}`, `batch_${nowStamp()}`);
  await ensureDir(base);
  return base;
}
async function latestBatchDir(chatId) {
  const chatDir = path.join(OUTPUT_ROOT, `chat_${chatId}`);
  try {
    const entries = await fsp.readdir(chatDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && e.name.startsWith('batch_')).map(d => d.name).sort();
    if (!dirs.length) return null;
    return path.join(chatDir, dirs[dirs.length - 1]);
  } catch { return null; }
}

async function zipDirectory(sourceDir, outPath) {
  await ensureDir(path.dirname(outPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(outPath));
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// --- CLEAN HELPERS ---
async function removePath(p) {
  if (!p) return;
  await fsp.rm(p, { recursive: true, force: true }); // robust recursive delete
}

// ---------- Telegram Handlers ----------

bot.onText(/^\/start/i, msg => {
  const chatId = msg.chat.id;
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(chatId, '⛔️ You are not approved to use this bot.');
  }
  bot.sendMessage(chatId,
`✅ Bot is ready.

Paste your lines in this exact format (one per line):

LASTNAME,DOB,ZIP,LAST4
e.g.
Martines,02/23/1961,30331,9631
O'Connor,1961-02-23,30331-1234,9631

Commands:
/export  – zip the latest batch results
/clean   – clear stored screenshots/files for this chat
/help    – show help`
  );
});

bot.onText(/^\/help/i, msg => {
  bot.sendMessage(msg.chat.id,
`Format:
LASTNAME,DOB,ZIP,LAST4

• Separators: comma or pipe
• DOB accepted: MM/DD/YYYY, M/D/YY, MM-DD-YYYY, YYYY-MM-DD
• ZIP: 12345 or 12345-6789
• LAST4: exactly 4 digits

Env knobs:
MAX_ENTRIES=${MAX_ENTRIES}, CONCURRENCY=${CONCURRENCY}, TIMEOUT=${ENTRY_TIMEOUT_MS}ms, RETRIES=${RETRY_ERRORS}`);
});

bot.onText(/^\/export/i, async msg => {
  const chatId = msg.chat.id;
  if (!isApproved(msg.from.id)) return;

  const dir = await latestBatchDir(chatId);
  if (!dir) return bot.sendMessage(chatId, 'No batch found to export yet.');

  const zipPath = path.join(dir, '..', 'latest_export.zip');
  try {
    await zipDirectory(dir, zipPath);
    const stat = await fsp.stat(zipPath);
    const MB = stat.size / (1024 * 1024);
    if (MB > 49) {
      return bot.sendMessage(chatId, `⚠️ Export is ${MB.toFixed(1)} MB, too large for Telegram. Please reduce batch size.`);
    }
    await bot.sendDocument(chatId, zipPath, {}, { filename: 'results.zip', contentType: 'application/zip' });
  } catch (e) {
    await bot.sendMessage(chatId, `Export failed: ${e.message}`);
  }
});

// --- /clean: remove all stored files for this chat ---
bot.onText(/^\/clean\b/i, async msg => {
  const chatId = msg.chat.id;
  if (!isApproved(msg.from.id)) return;

  const chatDir = path.join(OUTPUT_ROOT, `chat_${chatId}`);

  try {
    await removePath(chatDir);     // wipe chat folder (all batches, zips, json)
    await ensureDir(chatDir);      // recreate for future runs
    await bot.sendMessage(chatId, '🧹 Cleared all stored screenshots & files for this chat.');
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ Clean failed: ${e.message}`);
  }
});

// Core text handler (bulk processing)
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text ?? '';

  // skip commands
  if (/^\/(start|help|export|clean)\b/i.test(text)) return;

  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(chatId, '⛔️ You are not approved to use this bot.');
  }

  if (!text || typeof text !== 'string') return;

  const parsed = parseBulk(text);

  const valid = parsed.filter(r => r.ok);
  const invalid = parsed.filter(r => !r.ok);

  if (!valid.length) {
    const firstErr = invalid[0];
    return bot.sendMessage(chatId, `❌ No valid lines. Example format:\nMartines,02/23/1961,30331,9631\n\nFirst error: line ${firstErr.index} – ${firstErr.error}${firstErr.value ? ' ('+firstErr.value+')' : ''}`);
  }

  if (valid.length > MAX_ENTRIES) {
    return bot.sendMessage(chatId, `⚠️ You sent ${valid.length} lines. Max per batch is ${MAX_ENTRIES}. Please split and resend.`);
  }

  const batchDir = await getBatchDir(chatId);
  const resultsJsonPath = path.join(batchDir, 'results.json');

  await bot.sendMessage(chatId, `🧾 Received ${parsed.length} lines • Valid: ${valid.length} • Skipped: ${invalid.length}\nStarting ${valid.length} entries with concurrency x${CONCURRENCY}…`);

  // --- SINGLE-LINE PROGRESS COUNTER ---
  let progressMsg = await bot.sendMessage(chatId, `⏳ Progress 0/${valid.length}`);
  let done = 0;

  const limiter = createLimiter(CONCURRENCY);

  // Internal runner with retry passes
  async function runOne(entry) {
    let pass = 0;
    while (true) {
      pass++;
      try {
        const shotName = `${String(entry.index).padStart(3,'0')}_${entry.lastName.replace(/\s+/g,'_')}_${entry.last4}.jpg`;
        const shotPath = path.join(batchDir, shotName);

        const { status, screenshotPath: savedPath } = await Promise.race([
          runAutomation(entry.lastName, entry.dob, entry.zip, entry.last4, shotPath),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ENTRY_TIMEOUT_MS))
        ]);

        return { index: entry.index, input: entry.input, ok: true, status, screenshot: savedPath || shotPath };
      } catch (err) {
        if (pass > 1 + RETRY_ERRORS) {
          return { index: entry.index, input: entry.input, ok: false, error: String(err && err.message || err) };
        }
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  // Kick off all jobs through limiter with optional cool-down when serial
  const results = [];
  await Promise.all(valid.map(v =>
    limiter(async () => {
      if (CONCURRENCY === 1) {
        const cooldownMs = 700 + Math.floor(Math.random() * 900); // 0.7–1.6s, gentler pacing
        await delay(cooldownMs);
      }
      const r = await runOne(v);
      results.push(r);

      // update single-line progress
      done++;
      try {
        await bot.editMessageText(
          `⏳ Progress ${done}/${valid.length}`,
          { chat_id: chatId, message_id: progressMsg.message_id }
        );
      } catch (_) {}

      return r;
    })
  ));

  // Write results
  results.sort((a,b) => a.index - b.index);
  await fsp.writeFile(resultsJsonPath, JSON.stringify({
    meta: {
      when: new Date().toISOString(),
      count: parsed.length,
      valid: valid.length,
      invalid: invalid.length,
      concurrency: CONCURRENCY,
      retries: RETRY_ERRORS
    },
    invalid,
    results
  }, null, 2));

  await bot.sendMessage(chatId, `🎉 Done. Success: ${results.filter(r=>r.ok).length} • Failed: ${results.filter(r=>!r.ok).length}\nUse /export to download the zip of this batch.`);
});

console.log('🤖 Bot is running.');