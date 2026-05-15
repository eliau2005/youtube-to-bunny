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
const PLAYLIST_PATH = path.join(__dirname, 'playlist.json');
const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
const STAGED_PLAYLIST = path.join(__dirname, '.playlist-pending.json');
const INDEX_SCRIPT = path.join(__dirname, 'index.js');
const ALLOWED_CHAT_ID = String(TELEGRAM_CHAT_ID);
// Shared with index.js: presence = "no-wait mode" (10s instead of 2-6 min between videos)
const NO_WAIT_FLAG = path.join(__dirname, '.no-wait-mode');
// Shared with index.js: id of the most recent message holding the control buttons.
// Only one message at a time has them — preventing chat clutter.
const ACTIVE_BUTTONS_FILE = path.join(__dirname, '.active-buttons-msg-id');

// Shared with index.js: download-speed tuning knobs. Plain-text files holding one
// of the whitelisted preset values; missing/invalid → fall back to default.
const ARIA2C_PRESET_FILE = path.join(__dirname, '.aria2c-preset');
const PLAYER_CLIENT_FILE = path.join(__dirname, '.player-client-preset');
const PARALLEL_PRESET_FILE = path.join(__dirname, '.parallel-preset');
const ARIA2C_PRESETS = ['6', '8', '12', '16'];
const PLAYER_CLIENT_PRESETS = ['default', 'ios,tv', 'ios', 'tv', 'web'];
const PARALLEL_PRESETS = ['1', '2', '3', '4', '5'];
const ARIA2C_DEFAULT = '16';
const PLAYER_CLIENT_DEFAULT = 'default';
const PARALLEL_DEFAULT = '1';

function isNoWaitMode() { return fs.existsSync(NO_WAIT_FLAG); }

function readAria2cPreset() {
    try {
        if (fs.existsSync(ARIA2C_PRESET_FILE)) {
            const v = fs.readFileSync(ARIA2C_PRESET_FILE, 'utf8').trim();
            if (ARIA2C_PRESETS.includes(v)) return v;
        }
    } catch (_) {}
    return ARIA2C_DEFAULT;
}
function readPlayerClientPreset() {
    try {
        if (fs.existsSync(PLAYER_CLIENT_FILE)) {
            const v = fs.readFileSync(PLAYER_CLIENT_FILE, 'utf8').trim();
            if (PLAYER_CLIENT_PRESETS.includes(v)) return v;
        }
    } catch (_) {}
    return PLAYER_CLIENT_DEFAULT;
}
function readParallelPreset() {
    try {
        if (fs.existsSync(PARALLEL_PRESET_FILE)) {
            const v = fs.readFileSync(PARALLEL_PRESET_FILE, 'utf8').trim();
            if (PARALLEL_PRESETS.includes(v)) return v;
        }
    } catch (_) {}
    return PARALLEL_DEFAULT;
}

function readActiveButtonsId() {
    try {
        if (fs.existsSync(ACTIVE_BUTTONS_FILE)) {
            const id = parseInt(fs.readFileSync(ACTIVE_BUTTONS_FILE, 'utf8').trim(), 10);
            return isNaN(id) ? null : id;
        }
    } catch (_) {}
    return null;
}
function writeActiveButtonsId(id) {
    try {
        if (id) fs.writeFileSync(ACTIVE_BUTTONS_FILE, String(id));
        else if (fs.existsSync(ACTIVE_BUTTONS_FILE)) fs.unlinkSync(ACTIVE_BUTTONS_FILE);
    } catch (_) {}
}

function clearButtonsOnMessage(messageId) {
    if (!messageId) return Promise.resolve();
    return tgRequest('editMessageReplyMarkup', {
        chat_id: ALLOWED_CHAT_ID,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
    });
}

function makeActiveButtons(newMsgId) {
    if (!newMsgId) return;
    const prev = readActiveButtonsId();
    if (prev === newMsgId) return;
    if (prev) clearButtonsOnMessage(prev); // fire-and-forget
    writeActiveButtonsId(newMsgId);
}

function buildSettingsText() {
    const a = readAria2cPreset();
    const p = readPlayerClientPreset();
    const par = readParallelPreset();
    return (
        '⚙️ *הגדרות מהירות הורדה*\n\n' +
        `🔗 חיבורי aria2c: \`${a}\`\n` +
        `🎬 \`player_client\`: \`${p}\`\n` +
        `🔀 הורדה במקביל (אודיו בלבד): \`×${par}\`\n\n` +
        '_השינוי יחול מהסרטון הבא בריצה הנוכחית._'
    );
}

function buildSettingsKeyboard() {
    const a = readAria2cPreset();
    const p = readPlayerClientPreset();
    const par = readParallelPreset();
    const aria2cRow = ARIA2C_PRESETS.map(v => ({
        text: (v === a ? '✓ ' : '') + v,
        callback_data: `set_aria2c:${v}`,
    }));
    const playerRow = PLAYER_CLIENT_PRESETS.map(v => ({
        text: (v === p ? '✓ ' : '') + v,
        callback_data: `set_player_client:${v}`,
    }));
    const parallelRow = PARALLEL_PRESETS.map(v => ({
        text: (v === par ? '✓ ' : '') + `×${v}`,
        callback_data: `set_parallel:${v}`,
    }));
    const noWaitOn = isNoWaitMode();
    const toggleBtn = noWaitOn
        ? { text: '⏸️ הפעל המתנה', callback_data: 'set_wait:on' }
        : { text: '⚡ ללא המתנה', callback_data: 'set_wait:off' };
    const controlsRow = [
        { text: '🛑 Stop', callback_data: 'stop' },
        { text: '🔄 Restart', callback_data: 'restart' },
        toggleBtn,
    ];
    return { inline_keyboard: [aria2cRow, playerRow, parallelRow, controlsRow] };
}

function controlButtons(extraTopRow = null) {
    const noWaitOn = isNoWaitMode();
    const toggleBtn = noWaitOn
        ? { text: '⏸️ הפעל המתנה', callback_data: 'set_wait:on' }
        : { text: '⚡ ללא המתנה', callback_data: 'set_wait:off' };
    const controlsRow = [
        { text: '🛑 Stop', callback_data: 'stop' },
        { text: '🔄 Restart', callback_data: 'restart' },
        toggleBtn
    ];
    const inline_keyboard = [];
    if (extraTopRow) inline_keyboard.push(extraTopRow);
    inline_keyboard.push(controlsRow);
    return { inline_keyboard };
}

let runningChild = null;
let intentionalKill = false;
let lastUpdateId = 0;
let waitingForFilename = false; // when true, the next text message becomes the playlist filename
let pendingPlaylistInfo = null; // { items: number, fileName: string } when a .json is awaiting confirm

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

async function sendMessage(text, opts = {}) {
    const params = {
        chat_id: ALLOWED_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        ...opts
    };
    if (params.reply_markup === undefined) params.reply_markup = controlButtons();
    const hasButtons = !!params.reply_markup?.inline_keyboard?.length;
    const result = await tgRequest('sendMessage', params);
    if (hasButtons && result?.result?.message_id) {
        makeActiveButtons(result.result.message_id);
    }
    return result;
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

// Uploads a local file to Telegram as a document with a custom display name.
// The local file is NOT touched (read-only). Uses multipart/form-data, no extra deps.
function sendDocument(localPath, displayName, caption = '') {
    return new Promise((resolve) => {
        if (!fs.existsSync(localPath)) return resolve({ ok: false, error: 'file missing' });
        const boundary = '----formdata-' + Math.random().toString(36).slice(2);
        const fileContent = fs.readFileSync(localPath);
        const parts = [];
        const addField = (name, value) => parts.push(
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
        );
        addField('chat_id', ALLOWED_CHAT_ID);
        if (caption) addField('caption', caption);
        parts.push(
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="document"; filename="${displayName}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`
            ),
            fileContent,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        );
        const body = Buffer.concat(parts);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
            timeout: 60000
        }, (res) => {
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(body);
        req.end();
    });
}

function sanitizeFilename(name) {
    // Allow letters (Latin + Hebrew U+0590..U+05FF), digits, dot/underscore/dash.
    return name.replace(/[^a-zA-Z0-9_\-.֐-׿]/g, '_').slice(0, 80);
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
        if (code === 0) {
            // On success: ask for a filename to send the playlist back as
            waitingForFilename = true;
            sendMessage(
                '✅ *הריצה הסתיימה בהצלחה.*\n' +
                'איזה שם לתת לקובץ הפלייליסט המעודכן? (לדוגמה: `playlist-2026-05-03`)\n' +
                '_שלח את השם בהודעה הבאה. הקובץ ב-server לא יימחק._'
            );
        } else {
            sendMessage(
                `❌ *הריצה נעצרה* (exit ${code}).\nשלח קובץ \`cookies.txt\` חדש או לחץ Restart.`
            );
        }
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

        // Toggle no-wait mode (responds with toast — no extra messages)
        if (cq.data === 'set_wait:off') {
            try { fs.writeFileSync(NO_WAIT_FLAG, '1'); } catch (_) {}
            await tgRequest('answerCallbackQuery', {
                callback_query_id: cq.id, text: '⚡ מצב ללא המתנה — מופעל (10 שנ׳)'
            });
            return;
        }
        if (cq.data === 'set_wait:on') {
            if (fs.existsSync(NO_WAIT_FLAG)) { try { fs.unlinkSync(NO_WAIT_FLAG); } catch (_) {} }
            await tgRequest('answerCallbackQuery', {
                callback_query_id: cq.id, text: '⏸️ המתנה בין סרטונים — מופעלת'
            });
            return;
        }
        if (cq.data === 'stop') {
            const r = stopScript();
            await tgRequest('answerCallbackQuery', {
                callback_query_id: cq.id, text: r.ok ? '🛑 SIGTERM נשלח' : 'לא רץ כרגע'
            });
            return;
        }

        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id });

        if (cq.data === 'restart') {
            await sendMessage('🔄 מפעיל מחדש...');
            await restartScript();
            await sendMessage('🚀 הופעל מחדש.');
            return;
        }

        if (cq.data === 'overwrite_playlist') {
            if (!pendingPlaylistInfo || !fs.existsSync(STAGED_PLAYLIST)) {
                await sendMessage('אין פלייליסט ממתין להחלפה.');
                return;
            }
            if (runningChild) {
                await sendMessage('⚠️ ריצה פעילה — שלח /stop לפני החלפת פלייליסט.');
                return;
            }
            try {
                fs.copyFileSync(STAGED_PLAYLIST, PLAYLIST_PATH);
                fs.unlinkSync(STAGED_PLAYLIST);
                const info = pendingPlaylistInfo;
                pendingPlaylistInfo = null;
                await sendMessage(
                    `✅ פלייליסט חדש נטען (${info.items} סרטונים).\nלחץ Restart כדי להתחיל ריצה חדשה.`
                );
            } catch (e) {
                await sendMessage(`❌ דריסה נכשלה: \`${e.message}\``);
            }
            return;
        }

        if (cq.data === 'cancel_playlist') {
            if (fs.existsSync(STAGED_PLAYLIST)) {
                try { fs.unlinkSync(STAGED_PLAYLIST); } catch (_) {}
            }
            pendingPlaylistInfo = null;
            await sendMessage('בוטל. הפלייליסט הקיים נשאר ללא שינוי.');
            return;
        }

        if (cq.data.startsWith('set_aria2c:')) {
            const v = cq.data.slice('set_aria2c:'.length);
            if (!ARIA2C_PRESETS.includes(v)) {
                await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: 'ערך לא חוקי' });
                return;
            }
            try { fs.writeFileSync(ARIA2C_PRESET_FILE, v); } catch (_) {}
            await tgRequest('editMessageText', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: buildSettingsText(),
                parse_mode: 'Markdown',
                reply_markup: buildSettingsKeyboard(),
            });
            await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: `aria2c → ${v}` });
            return;
        }
        if (cq.data.startsWith('set_player_client:')) {
            const v = cq.data.slice('set_player_client:'.length);
            if (!PLAYER_CLIENT_PRESETS.includes(v)) {
                await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: 'ערך לא חוקי' });
                return;
            }
            try { fs.writeFileSync(PLAYER_CLIENT_FILE, v); } catch (_) {}
            await tgRequest('editMessageText', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: buildSettingsText(),
                parse_mode: 'Markdown',
                reply_markup: buildSettingsKeyboard(),
            });
            await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: `player → ${v}` });
            return;
        }
        if (cq.data.startsWith('set_parallel:')) {
            const v = cq.data.slice('set_parallel:'.length);
            if (!PARALLEL_PRESETS.includes(v)) {
                await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: 'ערך לא חוקי' });
                return;
            }
            try { fs.writeFileSync(PARALLEL_PRESET_FILE, v); } catch (_) {}
            await tgRequest('editMessageText', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: buildSettingsText(),
                parse_mode: 'Markdown',
                reply_markup: buildSettingsKeyboard(),
            });
            await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: `parallel → ×${v}` });
            return;
        }

        // Quality choice from index.js: callback_data format `quality:{requestId}:{continue|rotate}`
        if (cq.data.startsWith('quality:')) {
            const parts = cq.data.split(':');
            const requestId = parts[1];
            const answer = parts[2];
            if (!requestId || (answer !== 'continue' && answer !== 'rotate')) return;
            const choiceFile = path.join(__dirname, `.choice-${requestId}.json`);
            try {
                fs.writeFileSync(choiceFile, JSON.stringify({ answer }));
            } catch (e) {
                await sendMessage(`❌ כשלון בכתיבת תשובה: \`${e.message}\``);
                return;
            }
            // Clear the inline buttons so they can't be clicked again. Also clear
            // the active-buttons state file if this was the active message — index.js's
            // next progress edit will re-assign active to itself.
            await tgRequest('editMessageReplyMarkup', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                reply_markup: { inline_keyboard: [] }
            });
            if (readActiveButtonsId() === cq.message.message_id) writeActiveButtonsId(null);
            return;
        }
        return;
    }

    const msg = update.message;
    if (!msg || String(msg.chat?.id) !== ALLOWED_CHAT_ID) return;

    // Document upload — route by extension: .txt → cookies; .json → playlist (with confirmation)
    if (msg.document) {
        const doc = msg.document;
        const fileName = doc.file_name || 'unknown';
        const lower = fileName.toLowerCase();

        if (lower.endsWith('.txt')) {
            await sendMessage(`📥 מקבל "${fileName}" כ-cookies...`);
            try {
                const fileInfo = await tgRequest('getFile', { file_id: doc.file_id });
                if (!fileInfo.ok) throw new Error('getFile failed');
                await downloadFile(fileInfo.result.file_path, COOKIES_TARGET);
                const stats = fs.statSync(COOKIES_TARGET);
                await sendMessage(
                    `✅ נשמר כ-\`cookies1.txt\` (${stats.size} bytes).\nלחץ Restart כדי להפעיל מחדש.`
                );
            } catch (e) {
                await sendMessage(`❌ שמירה נכשלה: \`${e.message}\``);
            }
            return;
        }

        if (lower.endsWith('.json')) {
            await sendMessage(`📥 מקבל "${fileName}" כפלייליסט חדש...`);
            try {
                const fileInfo = await tgRequest('getFile', { file_id: doc.file_id });
                if (!fileInfo.ok) throw new Error('getFile failed');
                await downloadFile(fileInfo.result.file_path, STAGED_PLAYLIST);
                // Validate it's a JSON array
                let items;
                try {
                    const parsed = JSON.parse(fs.readFileSync(STAGED_PLAYLIST, 'utf8'));
                    if (!Array.isArray(parsed)) throw new Error('not an array');
                    items = parsed.length;
                } catch (parseErr) {
                    if (fs.existsSync(STAGED_PLAYLIST)) fs.unlinkSync(STAGED_PLAYLIST);
                    throw new Error(`לא JSON תקין: ${parseErr.message}`);
                }
                pendingPlaylistInfo = { items, fileName };
                await sendMessage(
                    `📋 *פלייליסט חדש מוכן:* \`${fileName}\` (${items} סרטונים)\n` +
                    `*אתה בטוח שאתה רוצה לדרוס את הפלייליסט הקיים?*`,
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ כן, דרוס', callback_data: 'overwrite_playlist' },
                                { text: '❌ ביטול', callback_data: 'cancel_playlist' }
                            ]]
                        }
                    }
                );
            } catch (e) {
                await sendMessage(`❌ קליטת פלייליסט נכשלה: \`${e.message}\``);
            }
            return;
        }

        await sendMessage(`קובץ "${fileName}" — מתעלם (קבל רק .txt או .json).`);
        return;
    }

    // Text message
    const text = (msg.text || '').trim();
    if (!text) return;

    // If awaiting a filename (post-success), the next non-command message becomes the name
    if (waitingForFilename && !text.startsWith('/')) {
        waitingForFilename = false;
        const safe = sanitizeFilename(text);
        if (!safe) {
            await sendMessage('שם לא חוקי — נסה שוב עם /restart או שלח קובץ.');
            return;
        }
        const finalName = safe.toLowerCase().endsWith('.json') ? safe : safe + '.json';

        // Archive a copy under playlists/ on the server (creates dir if missing)
        let archived = false;
        let archiveErr = null;
        try {
            if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
            fs.copyFileSync(PLAYLIST_PATH, path.join(PLAYLISTS_DIR, finalName));
            archived = true;
        } catch (e) {
            archiveErr = e.message;
        }

        await sendMessage(`📤 שולח כ-\`${finalName}\`...`);
        const caption = archived
            ? `playlist (${finalName}) — נשמר גם ב-playlists/`
            : `playlist (${finalName}) — ⚠️ ארכוב נכשל: ${archiveErr}`;
        const r = await sendDocument(PLAYLIST_PATH, finalName, caption);
        if (!r.ok) await sendMessage(`❌ שליחה נכשלה: \`${r.error || 'unknown'}\``);
        return;
    }

    if (!text.startsWith('/')) return;
    const cmd = text.split(/\s+/)[0].toLowerCase().split('@')[0];

    switch (cmd) {
        case '/start': {
            waitingForFilename = false;
            const r = startScript();
            await sendMessage(r.ok ? '🚀 הופעל.' : 'כבר רץ.');
            break;
        }
        case '/restart': {
            waitingForFilename = false;
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
        case '/settings': {
            await sendMessage(buildSettingsText(), { reply_markup: buildSettingsKeyboard() });
            break;
        }
        case '/help': {
            await sendMessage(
                '*פקודות:*\n' +
                '/start — הפעל\n' +
                '/restart — הפעל מחדש (הורג את הריצה הנוכחית)\n' +
                '/stop — עצור\n' +
                '/status — סטטוס\n' +
                '/settings — כוונון מהירות (aria2c + `player_client` + מקבילות אודיו)\n' +
                '/help — עזרה\n\n' +
                '*צינור עיבוד דו-פורמטי (לכל סרטון):*\n' +
                '1️⃣ 📥 הורדה — מ-YouTube (חדש) או מ-Bunny Stream (השלמת אודיו)\n' +
                '2️⃣ ☁️ העלאה ל-Bunny Stream (רק במצב מלא)\n' +
                '3️⃣ 🎵 חילוץ MP3 (64k mono 22050Hz)\n' +
                '4️⃣ 📤 העלאה ל-Bunny Storage → שמירת `audioUrl` ב-playlist.json\n\n' +
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
