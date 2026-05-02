// Telegram bot listener: receives uploaded cookie files, saves them as
// cookies1.txt, and starts/stops/restarts the main index.js script on command.
//
//   node bot-listener.js
//
// Commands (in the configured Telegram chat):
//   /start    — spawn index.js if not already running
//   /restart  — kill the current run and spawn a fresh one
//   /stop     — kill the current run
//   /status   — report whether index.js is running
//   /help     — list commands
//
// Sending any .txt document → saved as cookies1.txt (overwrites existing).
// On script exit (success or failure), the listener posts a message with an
// inline "🔄 Restart" button.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
    process.exit(1);
}

const COOKIES_TARGET = path.join(__dirname, 'cookies1.txt');
const INDEX_SCRIPT = path.join(__dirname, 'index.js');
const ALLOWED_CHAT_ID = String(TELEGRAM_CHAT_ID);

let runningChild = null;
let intentionalKill = false;
let lastUpdateId = 0;

// ─── Telegram API helpers ────────────────────────────────────────────────────

function tgRequest(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const body = JSON.stringify(params);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: timeoutMs
        }, (res) => {
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ ok: false }); }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => { resolve({ ok: false, error: e.message }); });
        req.write(body);
        req.end();
    });
}

const restartButton = { inline_keyboard: [[{ text: '🔄 Restart', callback_data: 'restart' }]] };

function sendMessage(text, opts = {}) {
    return tgRequest('sendMessage', {
        chat_id: ALLOWED_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        ...opts
    });
}

function downloadFile(filePath, destPath) {
    return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
        https.get(url, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            const out = fs.createWriteStream(destPath);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
        }).on('error', reject);
    });
}

// ─── Process management ─────────────────────────────────────────────────────

function startScript() {
    if (runningChild) return { ok: false, reason: 'already running' };
    console.log('Spawning index.js...');
    intentionalKill = false;
    runningChild = spawn('node', [INDEX_SCRIPT], { stdio: 'inherit', shell: false });

    runningChild.on('exit', (code, signal) => {
        const wasIntentional = intentionalKill;
        runningChild = null;
        intentionalKill = false;
        console.log(`index.js exited (code=${code}, signal=${signal})`);
        if (wasIntentional) return; // user-triggered kill — index.js sends its own messages
        const text = code === 0
            ? '✅ *הריצה הסתיימה.*'
            : `❌ *הריצה נעצרה* (exit ${code}).\nשלח קובץ \`cookies.txt\` חדש או לחץ Restart.`;
        sendMessage(text, { reply_markup: restartButton });
    });

    return { ok: true };
}

function stopScript() {
    if (!runningChild) return { ok: false, reason: 'not running' };
    console.log('Killing index.js...');
    intentionalKill = true;
    runningChild.kill();
    return { ok: true };
}

async function restartScript() {
    if (runningChild) {
        intentionalKill = true;
        runningChild.kill();
        await new Promise(r => {
            const check = setInterval(() => {
                if (!runningChild) { clearInterval(check); r(); }
            }, 200);
        });
    }
    return startScript();
}

// ─── Update handling ─────────────────────────────────────────────────────────

async function handleUpdate(update) {
    if (update.callback_query) {
        const cq = update.callback_query;
        if (String(cq.message?.chat?.id) !== ALLOWED_CHAT_ID) return;
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id });
        if (cq.data === 'restart') {
            await sendMessage('🔄 מפעיל מחדש...');
            await restartScript();
            await sendMessage('🚀 הופעל מחדש.');
        }
        return;
    }

    const msg = update.message;
    if (!msg || String(msg.chat?.id) !== ALLOWED_CHAT_ID) return;

    // Document upload (cookies file)
    if (msg.document) {
        const doc = msg.document;
        const fileName = doc.file_name || 'unknown';
        if (!fileName.toLowerCase().endsWith('.txt')) {
            await sendMessage(`קובץ "${fileName}" לא .txt — מתעלם.`);
            return;
        }
        await sendMessage(`📥 מקבל "${fileName}"...`);
        try {
            const fileInfo = await tgRequest('getFile', { file_id: doc.file_id });
            if (!fileInfo.ok) throw new Error('getFile failed');
            await downloadFile(fileInfo.result.file_path, COOKIES_TARGET);
            const stats = fs.statSync(COOKIES_TARGET);
            await sendMessage(
                `✅ נשמר כ-\`cookies1.txt\` (${stats.size} bytes).\nלחץ Restart כדי להפעיל מחדש.`,
                { reply_markup: restartButton }
            );
        } catch (e) {
            await sendMessage(`❌ שמירה נכשלה: \`${e.message}\``);
        }
        return;
    }

    // Text command
    const text = (msg.text || '').trim();
    if (!text.startsWith('/')) return;
    const cmd = text.split(/\s+/)[0].toLowerCase().split('@')[0];

    switch (cmd) {
        case '/start': {
            const r = startScript();
            await sendMessage(r.ok ? '🚀 הופעל.' : 'כבר רץ.');
            break;
        }
        case '/restart': {
            await sendMessage('🔄 מפעיל מחדש...');
            await restartScript();
            await sendMessage('🚀 הופעל מחדש.');
            break;
        }
        case '/stop': {
            const r = stopScript();
            await sendMessage(r.ok ? '🛑 נעצר.' : 'לא רץ כרגע.');
            break;
        }
        case '/status': {
            await sendMessage(runningChild ? '🟢 רץ.' : '⚪ לא רץ.');
            break;
        }
        case '/help': {
            await sendMessage(
                '*פקודות:*\n' +
                '/start — הפעל\n' +
                '/restart — הפעל מחדש (הורג את הריצה הנוכחית)\n' +
                '/stop — עצור\n' +
                '/status — סטטוס\n' +
                '/help — עזרה\n\n' +
                'גם אפשר לשלוח קובץ `.txt` ואני אשמור אותו כ-`cookies1.txt`.'
            );
            break;
        }
    }
}

// ─── Long polling loop ──────────────────────────────────────────────────────

async function pollLoop() {
    while (true) {
        try {
            const result = await tgRequest('getUpdates', {
                offset: lastUpdateId + 1,
                timeout: 30,
                allowed_updates: ['message', 'callback_query']
            }, 60000);
            if (result.ok && Array.isArray(result.result)) {
                for (const update of result.result) {
                    lastUpdateId = update.update_id;
                    try { await handleUpdate(update); }
                    catch (e) { console.error('handleUpdate error:', e.message); }
                }
            } else if (!result.ok) {
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (e) {
            console.warn('Poll error:', e.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('Bot listener started. Polling Telegram...');
sendMessage('🤖 *bot listener רץ*\nשלח /help לרשימת פקודות.');
pollLoop();

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (runningChild) { intentionalKill = true; runningChild.kill(); }
    setTimeout(() => process.exit(0), 500);
});
