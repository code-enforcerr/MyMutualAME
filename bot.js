// bot.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const { runAutomation } = require('./automation');

// ================== Config knobs ==================
const CONCURRENCY      = parseInt(process.env.CONCURRENCY || '3', 10);
const ENTRY_TIMEOUT_MS = parseInt(process.env.ENTRY_TIMEOUT_MS || '120000', 10); // generous wrapper timeout
const RETRY_ERRORS     = parseInt(process.env.RETRY_ERRORS || '1', 10);
const RETRY_DELAY_MS   = parseInt(process.env.RETRY_DELAY_MS || '2000', 10);
const MAX_ENTRIES      = parseInt(process.env.MAX_ENTRIES || '70', 10);
const SCREENSHOT_DIR   = process.env.SHOT_DIR || path.resolve('screenshots');
// ==================================================

// --- Fail fast if token is missing ---
if (!process.env.TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is not set.');
  process.exit(1);
}

// Start with polling disabled; delete webhook then start polling to avoid 409s
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    try { await bot.stopPolling(); } catch {}
    await bot.startPolling({ params: { allowed_updates: ['message'] } });
    console.log('🤖 Bot is running (polling started cleanly).');
  } catch (e) {
    console.error('Failed to start polling:', e?.message || e);
    process.exit(1);
  }
})();

// ---- 409 conflict auto-recovery ----
bot.on('polling_error', async (err) => {
  const msg = err?.response?.body || err?.message || String(err);
  console.error('error: [polling_error]', msg);
  if (err?.code === 'ETELEGRAM' && /409/.test(msg)) {
    console.log('🔁 409 detected: attempting recovery…');
    try {
      await bot.stopPolling().catch(() => {});
      await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      await bot.startPolling({ params: { allowed_updates: ['message'] } });
      console.log('✅ Recovered from 409; polling restarted.');
    } catch (e) {
      console.error('❌ 409 recovery failed:', e?.message || e);
    }
  }
});

// --- Approved users from env ---
const rawApproved = (process.env.APPROVED_USERS || '').trim(); // "123,456"
const approvedUsers = rawApproved.split(',').map(s => s.trim()).filter(Boolean);
function isApproved(id) {
  const idStr = String(id).trim();
  return approvedUsers.length === 0 || approvedUsers.includes(idStr);
}

// ---------- Helpers ----------
function delay(ms){ return new Promise(res => setTimeout(res, ms)); }

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); return dir; }

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function pickWritableBaseDir() {
  const preferred = SCREENSHOT_DIR;
  const fallback  = path.resolve('screenshots');
  try { await ensureDir(preferred); return preferred; }
  catch (e) {
    console.warn(`SHOT_DIR not writable (${preferred}): ${e.code}. Falling back to ${fallback}`);
    await ensureDir(fallback);
    return fallback;
  }
}

async function getBatchDir(chatId) {
  const baseRoot = await pickWritableBaseDir();
  const base = path.join(baseRoot, `chat_${chatId}`, `batch_${nowStamp()}`);
  await ensureDir(base);
  return base;
}
async function latestBatchDir(chatId) {
  const baseRoot = await pickWritableBaseDir();
  const chatDir = path.join(baseRoot, `chat_${chatId}`);
  try {
    const entries = await fsp.readdir(chatDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && e.name.startsWith('batch_')).map(d => d.name).sort();
    if (!dirs.length) return null;
    return path.join(chatDir, dirs[dirs.length - 1]);
  } catch { return null; }
}

// ---- Safer zipDirectory (glob) ----
async function zipDirectory(sourceDir, outPath) {
  await ensureDir(path.dirname(outPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(outPath));
    archive.on('warning', (err) => console.warn('archiver warning:', err));
    archive.on('error', reject);

    archive.pipe(output);
    archive.glob('**/*', {
      cwd: sourceDir,
      dot: true,
      nodir: false,
      ignore: ['**/*.zip']
    });
    archive.finalize();
  });
}

// ---------- Commands ----------
bot.setMyCommands([
  { command: '/start',   description: 'Start the bot & instructions' },
  { command: '/help',    description: 'Show format & settings' },
  { command: '/export',  description: 'Download latest batch as ZIP' },
  { command: '/clean',   description: 'Clear stored screenshots' },
  { command: '/whoami',  description: 'Show your chat id' },
  { command: '/status',  description: 'Service status & counters' },
]);

bot.onText(/^\/whoami$/, (msg) => {
  const cid = String(msg.chat.id);
  const uname = msg.from?.username ? '@' + msg.from.username : '';
  console.log('🔧 /whoami →', cid, uname);
  bot.sendMessage(cid, `chat_id: ${cid} ${uname}`);
});

bot.onText(/^\/start$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied: You are not an approved user.');
  await bot.sendMessage(chatId,
`👋 Welcome!

📌 Send your data (one per line) in this exact format:
LASTNAME,DOB,ZIP,LAST4

Examples:
Martines,02/23/1961,30331,9631
O'Connor,1961-02-23,30331-1234,9631

Then send /export to download results.`);
});

bot.onText(/^\/help$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
`Format:
LASTNAME,DOB,ZIP,LAST4

• Separators: comma or pipe
• DOB accepted: MM/DD/YYYY, M/D/YY, MM-DD-YYYY, YYYY-MM-DD
• ZIP: 12345 or 12345-6789
• LAST4: exactly 4 digits

Env knobs:
MAX_ENTRIES=${MAX_ENTRIES}, CONCURRENCY=${CONCURRENCY}, TIMEOUT=${ENTRY_TIMEOUT_MS}ms, RETRIES=${RETRY_ERRORS}`);
});

bot.onText(/^\/clean$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!isApproved(chatId)) return bot.sendMessage(chatId, '🚫 Access Denied.');
  try {
    const baseRoot = await pickWritableBaseDir();
    const chatDir = path.join(baseRoot, `chat_${chatId}`);
    await fsp.rm(chatDir, { recursive: true, force: true });
    await bot.sendMessage(chatId, '🧹 Cleaned stored screenshots.');
  } catch (e) {
    console.error('clean error', e);
    await bot.sendMessage(chatId, '⚠️ Could not clean screenshots.');
  }
});

bot.onText(/^\/status$/, async (msg) => {
  const chatId = String(msg.chat.id);
  const baseRoot = await pickWritableBaseDir();
  const dir = path.join(baseRoot, `chat_${chatId}`);
  let batchCount = 0, fileCount = 0;
  try {
    const batches = await fsp.readdir(dir, { withFileTypes: true });
    batchCount = batches.filter(x => x.isDirectory()).length;
    for (const b of batches) {
      if (!b.isDirectory()) continue;
      const files = await fsp.readdir(path.join(dir, b.name));
      fileCount += files.length;
    }
  } catch {}
  bot.sendMessage(chatId, `✅ Running.\nBatches: ${batchCount}\nFiles: ${fileCount}\nConcurrency: x${CONCURRENCY}`);
});

// ---------- /export ----------
bot.onText(/^\/export$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isApproved(msg.from.id)) return;

  const dir = await latestBatchDir(chatId);
  if (!dir) return bot.sendMessage(chatId, 'No batch found to export yet.');

  const zipPath = path.join(dir, '..', 'latest_export.zip');
  try {
    // debug: list files
    try {
      const files = await fsp.readdir(dir);
      await bot.sendMessage(chatId, `📂 Batch has ${files.length} items:\n` + files.slice(0, 10).join('\n') + (files.length > 10 ? '\n…' : ''));
    } catch {}

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

// ---------- Core text handler (bulk) ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ?? '';
  if (/^\/(start|help|export|clean|whoami|status)\b/i.test(text)) return;

  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(chatId, '⛔️ You are not approved to use this bot.');
  }
  if (!text || typeof text !== 'string') return;

  const parsed = parseBulk(text);
  const valid = parsed.filter(r => r.ok);
  const invalid = parsed.filter(r => !r.ok);

  if (!valid.length) {
    const firstErr = invalid[0];
    return bot.sendMessage(
      chatId,
      `❌ No valid lines. Example:\nMartines,02/23/1961,30331,9631\n\nFirst error: line ${firstErr.index} – ${firstErr.error}${firstErr.value ? ' ('+firstErr.value+')' : ''}`
    );
  }

  if (valid.length > MAX_ENTRIES) {
    return bot.sendMessage(chatId, `⚠️ You sent ${valid.length} lines. Max per batch is ${MAX_ENTRIES}. Please split and resend.`);
  }

  const batchDir = await getBatchDir(chatId);
  const resultsJsonPath = path.join(batchDir, 'results.json');

  await bot.sendMessage(
    chatId,
    `🧾 Received ${parsed.length} lines • Valid: ${valid.length} • Skipped: ${invalid.length}\nStarting with concurrency x${CONCURRENCY}…`
  );

  // Live progress message
  let done = 0;
  let validCount = 0, incorrectCount = 0, unknownCount = 0, errorCount = 0;
  const total = valid.length;

  const progressMsg = await bot.sendMessage(chatId, `⏳ 0/${total} done`);
  const progressIdent = { chat_id: chatId, message_id: progressMsg.message_id };

  const updateProgress = async () => {
    try {
      await bot.editMessageText(
        `${done === total ? '✅' : '⏳'} ${done}/${total} done`,
        { chat_id: progressIdent.chat_id, message_id: progressIdent.message_id }
      );
    } catch {}
  };

  const limiter = createLimiter(CONCURRENCY);

  async function runOne(entry) {
    let pass = 0;
    while (true) {
      pass++;
      try {
        const shotName = `${String(entry.index).padStart(3,'0')}_${entry.lastName.replace(/\s+/g,'_')}_${entry.last4}.jpg`;
        const shotPath = path.join(batchDir, shotName);

        const { status, screenshotPath: savedPath, error } = await Promise.race([
          runAutomation(entry.lastName, entry.dob, entry.zip, entry.last4, shotPath),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ENTRY_TIMEOUT_MS))
        ]);

        if (status === 'valid') validCount++;
        else if (status === 'incorrect') incorrectCount++;
        else if (status === 'unknown') unknownCount++;
        else errorCount++;

        return { index: entry.index, input: entry.input, ok: true, status, screenshot: savedPath || shotPath, error };
      } catch (err) {
        if (pass > 1 + RETRY_ERRORS) {
          errorCount++;
          return { index: entry.index, input: entry.input, ok: false, error: String(err?.message || err) };
        }
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  const results = [];
  await Promise.all(valid.map(v =>
    limiter(() => runOne(v)).then(r => {
      results.push(r);
      done++;
      updateProgress();
    })
  ));

  // Persist results
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

  const errorReasons = results
    .filter(r => !r.ok || r.status === 'error')
    .map(r => (r.error || '').slice(0, 200))
    .filter(Boolean)
    .slice(0, 3);

  let reasonsBlock = '';
  if (errorReasons.length) {
    reasonsBlock = '\n\n🧪 Sample error reasons:\n' + errorReasons.map((e, i) => ` ${i+1}. ${e}`).join('\n');
  }

  const finalSummary =
`✅ Valid: ${validCount}
❌ Incorrect: ${incorrectCount}
❓ Unknown: ${unknownCount}
⚠️ Errors: ${errorCount}
⛔ Invalid: ${invalid.length}` + reasonsBlock;

  try {
    await bot.editMessageText(`✅ ${total}/${total} done`, { chat_id: progressIdent.chat_id, message_id: progressIdent.message_id });
  } catch {}

  await bot.sendMessage(chatId, finalSummary);

  // Auto-export ZIP (write OUTSIDE the batch folder)
  try {
    const parentDir = path.join(batchDir, '..');
    await ensureDir(parentDir);
    const zipPath = path.join(parentDir, `export_${Date.now()}.zip`);

    // small listing before zipping
    try {
      const files = await fsp.readdir(batchDir);
      await bot.sendMessage(chatId, `📂 Batch has ${files.length} items:\n` + files.slice(0, 10).join('\n') + (files.length > 10 ? '\n…' : ''));
    } catch {}

    await zipDirectory(batchDir, zipPath);
    const stat = await fsp.stat(zipPath);
    const MB = stat.size / (1024 * 1024);
    if (MB > 49) {
      await bot.sendMessage(chatId, `⚠️ Export is ${MB.toFixed(1)} MB, too large for Telegram. Use /export after shrinking batch size.`);
    } else {
      await bot.sendDocument(chatId, zipPath, {}, { filename: path.basename(zipPath), contentType: 'application/zip' });
      await bot.sendMessage(chatId, `Export (${results.length} files)`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `Export failed: ${e.message}`);
  }
});

console.log('🤖 Bot is running.');

// ---------- Parsers (helpers) ----------
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

function normalizeDobToMMDDYYYY(input) {
  if (!input) return null;
  const s = String(input).trim();

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;

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

  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${mm}/${dd}/${yyyy}`;
  }
  return null;
}

// --- Simple concurrency limiter ---
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