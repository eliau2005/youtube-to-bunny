require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

const {
    BUNNY_LIBRARY_ID,
    BUNNY_API_KEY,
    BUNNY_STORAGE_API_KEY,
    BUNNY_STORAGE_ZONE_NAME,
    BUNNY_PULL_ZONE_URL,
} = process.env;

const headers = {
    'AccessKey': BUNNY_API_KEY,
    'Content-Type': 'application/json'
};

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

// Shared with bot-listener.js: presence of this file = "no-wait mode" is on
// (inter-video delay → 10s instead of random 2-6 min).
const NO_WAIT_FLAG = path.join(__dirname, '.no-wait-mode');
function isNoWaitMode() { return fs.existsSync(NO_WAIT_FLAG); }

// Shared with bot-listener.js: the most recent message_id that has the control
// buttons. We keep at most one such message at any time — when a new one gets
// buttons, we clear the old one so the chat doesn't accumulate visual clutter.
const ACTIVE_BUTTONS_FILE = path.join(__dirname, '.active-buttons-msg-id');
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

// Shared with bot-listener.js: download-speed tuning knobs. Bot writes these on
// /settings clicks; yt-dlp spawn sites here read them per video so changes apply
// from the next video without a restart.
const ARIA2C_PRESET_FILE = path.join(__dirname, '.aria2c-preset');
const PLAYER_CLIENT_FILE = path.join(__dirname, '.player-client-preset');
const PARALLEL_PRESET_FILE = path.join(__dirname, '.parallel-preset');
const ARIA2C_PRESETS = ['6', '8', '12', '16'];
const PLAYER_CLIENT_PRESETS = ['default', 'ios,tv', 'ios', 'tv', 'web'];
const PARALLEL_PRESETS = ['1', '2', '3', '4', '5'];
const ARIA2C_DEFAULT = '16';
const PLAYER_CLIENT_DEFAULT = 'default';
const PARALLEL_DEFAULT = '1';

function readAria2cPreset() {
    try {
        if (fs.existsSync(ARIA2C_PRESET_FILE)) {
            const v = fs.readFileSync(ARIA2C_PRESET_FILE, 'utf8').trim();
            if (ARIA2C_PRESETS.includes(v)) return v;
        }
    } catch (_) {}
    return ARIA2C_DEFAULT;
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
function readPlayerClientPreset() {
    try {
        if (fs.existsSync(PLAYER_CLIENT_FILE)) {
            const v = fs.readFileSync(PLAYER_CLIENT_FILE, 'utf8').trim();
            if (PLAYER_CLIENT_PRESETS.includes(v)) return v;
        }
    } catch (_) {}
    return PLAYER_CLIENT_DEFAULT;
}

// Standard 3-button row appended to every Telegram message we send/edit.
// Pass `extraTopRow` for context-specific buttons (e.g. quality "Switch Cookies").
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

// ─── Telegram Helpers ────────────────────────────────────────────────────────

// Sends a new message; resolves with the Telegram Message object (contains .message_id) or null
function sendTelegramMessage(text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve(null);
    if (replyMarkup === null) replyMarkup = controlButtons(); // default: standard control buttons
    const hasButtons = !!replyMarkup?.inline_keyboard?.length;
    return new Promise((resolve) => {
        const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => {
                try {
                    const result = JSON.parse(data).result || null;
                    if (result && hasButtons) makeActiveButtons(result.message_id);
                    resolve(result);
                } catch { resolve(null); }
            });
        });
        req.on('error', (e) => { console.warn('Telegram send failed:', e.message); resolve(null); });
        req.write(body);
        req.end();
    });
}

// Adaptive backoff state shared by editTelegramMessage. When Telegram returns
// 429 with retry_after=N, all edits are skipped client-side until that window
// elapses — saves wasted HTTP requests and keeps the console clean.
let tgBackoffUntil = 0;
let tgBackoffWarned = false;

// Clears the inline keyboard from a message (no text change).
function clearButtonsOnMessage(messageId) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return Promise.resolve();
    if (Date.now() < tgBackoffUntil) return Promise.resolve();
    return new Promise((resolve) => {
        const body = JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// Marks `newMsgId` as the only message currently bearing the control buttons.
// If a different message previously had them, clears its buttons. Idempotent.
function makeActiveButtons(newMsgId) {
    if (!newMsgId) return;
    const prev = readActiveButtonsId();
    if (prev === newMsgId) return; // already active — nothing to do
    if (prev) clearButtonsOnMessage(prev); // fire-and-forget
    writeActiveButtonsId(newMsgId);
}

// Edits an existing message in-place; handles Telegram 429 rate-limit gracefully
function editTelegramMessage(messageId, text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return Promise.resolve();
    if (Date.now() < tgBackoffUntil) return Promise.resolve(); // in backoff — skip silently
    if (replyMarkup === null) replyMarkup = controlButtons(); // default: standard control buttons
    if (replyMarkup?.inline_keyboard?.length) makeActiveButtons(messageId);
    return new Promise((resolve) => {
        const payload = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: 'Markdown' };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => {
                if (res.statusCode === 429) {
                    try {
                        const parsed = JSON.parse(data);
                        const wait = parsed?.parameters?.retry_after || 1;
                        // Add a 5-sec safety buffer on top of Telegram's retry_after
                        // so we don't bump back into the limit and earn longer bans.
                        const totalWait = wait + 5;
                        tgBackoffUntil = Date.now() + totalWait * 1000;
                        if (!tgBackoffWarned) {
                            tgBackoffWarned = true;
                            process.stderr.write(`\nTelegram rate-limited — Telegram asked ${wait}s, backing off ${totalWait}s (+5s buffer)\n`);
                            setTimeout(() => { tgBackoffWarned = false; }, totalWait * 1000 + 100);
                        }
                    } catch {}
                }
                resolve();
            });
        });
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// Fire-and-forget wrapper (used for one-off alerts)
function sendTelegram(message) { return sendTelegramMessage(message).then(() => {}); }

// 20-char ASCII progress bar for Telegram messages
function telegramBar(percent) {
    const filled = Math.min(20, Math.round(percent / 5));
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

// ─────────────────────────────────────────────────────────────────────────────

let collectionsMap = {};

function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes.toFixed(0) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/s';
}

function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Notifies the user (Telegram + terminal) that a video is below 1080p and gives
// them 10 seconds to press "Switch Cookies"; otherwise auto-continues at the
// available quality. Bot-listener writes `.choice-{id}.json` on click; we poll.
async function askUserQualityChoice({ liveId, videoIndex, total, title, maxRes }) {
    const requestId = `${videoIndex}_${Date.now()}`;
    const choiceFile = path.join(__dirname, `.choice-${requestId}.json`);
    const promptText =
        `🎬 *[${videoIndex}/${total}]* ${title}\n\n` +
        `⚠️ *הסרטון מציע מקסימום ${maxRes}p* (לא 1080p)\n` +
        `אם לא תלחץ תוך 10 שנ׳ — מוריד אוטומטית ב-${maxRes}p.`;
    const buttons = controlButtons([
        { text: '🔄 החלף Cookies', callback_data: `quality:${requestId}:rotate` }
    ]);
    if (liveId) await editTelegramMessage(liveId, promptText, buttons);
    else await sendTelegramMessage(promptText, buttons);

    console.warn(`\n⚠️  Video offers max ${maxRes}p. 10-sec window for "Switch Cookies"; auto-continue otherwise.`);

    const startedAt = Date.now();
    const TIMEOUT_MS = 10 * 1000;
    while (Date.now() - startedAt < TIMEOUT_MS) {
        if (fs.existsSync(choiceFile)) {
            try {
                const choice = JSON.parse(fs.readFileSync(choiceFile, 'utf8'));
                fs.unlinkSync(choiceFile);
                console.log(`Choice received: ${choice.answer}`);
                return choice.answer; // 'continue' or 'rotate'
            } catch (_) { /* malformed file — ignore and keep polling */ }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('No response within 10s — auto-continuing at available quality.');
    return 'continue';
}

// Sleeps for totalSec seconds, editing a Telegram message with a live progress
// bar (elapsed/total in M:SS plus seconds count and percent). When done,
// optionally edits to `finalText` to clean up. Used for both inter-cookie waits
// and inter-video waits.
function sleepWithProgressBar({ totalSec, liveId, bodyTop = '', bodyBottom = '', finalText = null, tickMs = 5000 }) {
    const startedAt = Date.now();
    const fmtTime = (s) => {
        const m = Math.floor(s / 60);
        return `${String(m).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
    };
    const render = (remaining) => {
        if (!liveId) return;
        const elapsed = totalSec - remaining;
        const pct = Math.max(0, Math.min(100, (elapsed / totalSec) * 100));
        const text =
            (bodyTop ? bodyTop + '\n' : '') +
            `⏳ ${fmtTime(elapsed)} / ${fmtTime(totalSec)}  (${Math.floor(elapsed)}s / ${totalSec}s)\n` +
            `\`${telegramBar(pct)}\` ${pct.toFixed(0)}%` +
            (bodyBottom ? '\n' + bodyBottom : '');
        editTelegramMessage(liveId, text); // fire-and-forget
    };
    render(totalSec); // immediate render at 0%
    const interval = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const remaining = totalSec - elapsed;
        if (remaining > 0) render(remaining);
    }, tickMs);
    return new Promise((resolve) => {
        setTimeout(() => {
            clearInterval(interval);
            if (liveId && finalText !== null) editTelegramMessage(liveId, finalText);
            resolve();
        }, totalSec * 1000);
    });
}

function renderProgressBar(label, percent, speed, eta) {
    const barWidth = 30;
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round(barWidth * clamped / 100);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const line = `${label} [${bar}] ${clamped.toFixed(1).padStart(5)}% | ${speed} | ETA ${eta}`;
    if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(line);
    } else {
        process.stdout.write(line + '\n');
    }
}

function endProgressLine() {
    if (process.stdout.isTTY) process.stdout.write('\n');
}

async function loadCollections() {
    try {
        const res = await axios.get(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections?itemsPerPage=100`, { headers });
        res.data.items.forEach(c => {
            collectionsMap[c.name] = c.guid;
        });
    } catch (e) {
        console.error('Error loading collections:', e.message);
    }
}

async function getOrCreateCollection(name) {
    if (!name) return null;
    if (collectionsMap[name]) return collectionsMap[name];

    console.log(`Creating new Bunny collection: ${name}`);
    try {
        const res = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections`,
            { name },
            { headers }
        );
        collectionsMap[name] = res.data.guid;
        return res.data.guid;
    } catch (e) {
        console.error(`Failed to create collection ${name}:`, e.message);
        if (e.response) {
            console.error('  status:', e.response.status);
            console.error('  body:', JSON.stringify(e.response.data));
        }
        return null;
    }
}

// ─── Auth Source Rotation ────────────────────────────────────────────────────
// Try direct (no auth) first; on failure, fall back through cookies1.txt →
// cookies2.txt → cookies3.txt → plain cookies.txt. The active source is sticky
// across videos: only advances when the current one fails for a video.

function getCookieFiles() {
    const numbered = [1, 2, 3]
        .map(n => path.join(__dirname, `cookies${n}.txt`))
        .filter(f => fs.existsSync(f));
    if (numbered.length > 0) return numbered;
    const plain = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(plain)) return [plain];
    return [];
}

function buildAuthSources() {
    const sources = [];
    for (const file of getCookieFiles()) {
        sources.push({ type: 'cookie', value: file, label: path.basename(file) });
    }
    return sources;
}

function buildYtdlpAuthArgs(source) {
    if (source.type === 'cookie') return ['--cookies', source.value];
    return []; // direct: no auth args
}

function sourceEmoji(type) {
    return type === 'cookie' ? '🍪' : '🌐';
}
// ─────────────────────────────────────────────────────────────────────────────

function listFormats(youtubeUrl, cookieArgs) {
    return new Promise((resolve, reject) => {
        const playerClient = readPlayerClientPreset();
        const extractorArgs = playerClient === 'default'
            ? []
            : ['--extractor-args', `youtube:player_client=${playerClient}`];
        const args = [...cookieArgs, ...extractorArgs, '-F', '--no-playlist', '--js-runtimes', 'node', youtubeUrl];
        const child = spawn('yt-dlp', args, { shell: process.platform === 'win32' });
        let output = '';
        let stderr = '';
        child.stdout.on('data', d => output += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`yt-dlp format list failed with code ${code}. ${stderr.trim().split('\n').slice(-1)}`));
            }
            // Extract the highest resolution available
            const resolutions = [...output.matchAll(/(\d{3,4})p/g)].map(m => parseInt(m[1]));
            const maxRes = resolutions.length ? Math.max(...resolutions) : 0;
            
            if (maxRes === 0) {
                return reject(new Error(`No valid formats found (max resolution 0p).`));
            }

            console.log(`Available formats (max resolution found: ${maxRes}p):`);
            // Print only the resolution table lines
            const lines = output.split('\n').filter(l =>
                l.match(/^\d+\s/) || l.includes('ID') || l.includes('---')
            );
            lines.slice(0, 30).forEach(l => console.log('  ', l));
            resolve(maxRes);
        });
        child.on('error', (err) => reject(err));
    });
}

function downloadFromYoutube(youtubeUrl, outputFile, cookieArgs, onProgress) {
    return new Promise((resolve, reject) => {
        const aria2cConns = readAria2cPreset();
        const playerClient = readPlayerClientPreset();
        const extractorArgs = playerClient === 'default'
            ? []
            : ['--extractor-args', `youtube:player_client=${playerClient}`];
        console.log(`Download settings: aria2c x${aria2cConns}, player_client=${playerClient}`);
        const args = [
            ...cookieArgs,
            ...extractorArgs,
            '--no-playlist',
            '--js-runtimes', 'node',
            '--downloader', 'aria2c',
            '--downloader-args', `aria2c:-x ${aria2cConns} -s ${aria2cConns} -j ${aria2cConns} -k 5M --console-log-level=info --summary-interval=1`,
            '--sleep-requests', '2',
            '-f', 'bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best',
            '-S', 'res:1080,fps,vcodec:h264:vp9,acodec:m4a',
            '--merge-output-format', 'mp4',
            '--print', 'before_dl:Downloading format: %(format_id)s | %(height)sp | %(vcodec)s',
            '--newline',
            '--progress-template', 'PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s',
            '-o', outputFile,
            youtubeUrl
        ];

        const child = spawn('yt-dlp', args, { shell: process.platform === 'win32' });
        let stderrTail = '';
        let activeBar = false;

        const handleLine = (line) => {
            if (!line) return;
            if (line.startsWith('PROGRESS|')) {
                const parts = line.split('|');
                const percentStr = (parts[1] || '').trim();
                const speedStr = (parts[2] || '').trim();
                const etaStr = (parts[3] || '').trim();
                const percent = parseFloat(percentStr.replace('%', ''));
                if (!isNaN(percent)) {
                    renderProgressBar('Downloading', percent, speedStr || 'N/A', etaStr || '--:--');
                    activeBar = true;
                    if (onProgress) onProgress(percent, speedStr || 'N/A', etaStr || '--:--');
                }
            } else if (line.startsWith('[#')) {
                // aria2c summary line: [#abc 12345/67890MiB(18%) CN:1 DL:5MiB ETA:30s]
                const pctMatch = line.match(/\((\d+(?:\.\d+)?)%\)/);
                if (pctMatch) {
                    const dlMatch = line.match(/DL:(\S+?)(?=[\s\]])/);
                    const etaMatch = line.match(/ETA:(\S+?)(?=[\s\]])/);
                    const percent = parseFloat(pctMatch[1]);
                    const speed = dlMatch ? dlMatch[1] + '/s' : 'N/A';
                    const eta = etaMatch ? etaMatch[1] : '--:--';
                    renderProgressBar('Downloading', percent, speed, eta);
                    activeBar = true;
                    if (onProgress) onProgress(percent, speed, eta);
                }
            } else if (line.includes('[Merger]')) {
                if (activeBar) { endProgressLine(); activeBar = false; }
                console.log('Merging audio and video...');
            } else if (line.includes('[ExtractAudio]') || line.includes('[FixupM4a]')) {
                if (activeBar) { endProgressLine(); activeBar = false; }
                console.log('Post-processing...');
            }
        };

        const consume = (buf, isErr) => {
            const text = buf.toString();
            if (isErr) stderrTail = (stderrTail + text).slice(-2000);
            const lines = text.split(/\r\n|\r|\n/);
            for (const l of lines) handleLine(l);
        };

        child.stdout.on('data', (d) => consume(d, false));
        child.stderr.on('data', (d) => consume(d, true));

        child.on('close', (code) => {
            if (activeBar) endProgressLine();
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp exited with code ${code}. ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
        });

        child.on('error', reject);
    });
}

function uploadToBunny(guid, filePath, onProgress) {
    return new Promise((resolve, reject) => {
        const fileSize = fs.statSync(filePath).size;
        let uploadedBytes = 0;
        let lastTime = Date.now();
        let lastLoaded = 0;
        let lastSpeed = 0;
        let activeBar = false;

        const fileStream = fs.createReadStream(filePath);

        fileStream.on('data', (chunk) => {
            uploadedBytes += chunk.length;
            const now = Date.now();
            const dt = (now - lastTime) / 1000;
            if (dt >= 0.3 || uploadedBytes === fileSize) {
                lastSpeed = (uploadedBytes - lastLoaded) / Math.max(dt, 0.001);
                const percent = (uploadedBytes / fileSize) * 100;
                const remaining = lastSpeed > 0 ? (fileSize - uploadedBytes) / lastSpeed : Infinity;
                renderProgressBar('Uploading  ', percent, formatSpeed(lastSpeed), formatEta(remaining));
                activeBar = true;
                if (onProgress) onProgress(percent, formatSpeed(lastSpeed), formatEta(remaining));
                lastTime = now;
                lastLoaded = uploadedBytes;
            }
        });

        axios.put(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, fileStream, {
            headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        })
            .then(() => {
                if (activeBar) endProgressLine();
                resolve();
            })
            .catch((err) => {
                if (activeBar) endProgressLine();
                reject(err);
            });
    });
}

// ─── Bunny Stream → MP4 download (audio-only re-process path) ────────────────
// Parse the GUID out of an iframe URL: https://iframe.mediadelivery.net/play/{libId}/{guid}
function extractBunnyGuid(streamUrl) {
    if (!streamUrl || typeof streamUrl !== 'string') return null;
    const m = streamUrl.match(/\/play\/\d+\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
}

// Downloads from a Bunny Stream iframe URL. yt-dlp handles BunnyCDN's HLS
// playlist natively, no cookies needed. We only need the audio for MP3
// extraction, so -f "bestaudio/best" saves significant bandwidth vs. the full
// 1080p video. --remux-video mp4 forces a predictable container so the
// ffmpeg input path is stable.
function downloadFromBunny(streamUrl, outputFile, onProgress) {
    return new Promise((resolve, reject) => {
        // Bunny Stream is HLS (m3u8 + many small .ts segments). yt-dlp's
        // native HLS downloader is single-threaded by default, which is the
        // dominant cause of slow Bunny downloads. --concurrent-fragments
        // parallelizes segment fetches for a 5-10x speedup. aria2c can't be
        // used here — it doesn't understand HLS manifests.
        const args = [
            '--no-playlist',
            '-f', 'bestaudio/best',
            '--concurrent-fragments', '16',
            '--remux-video', 'mp4',
            '--newline',
            '--progress-template', 'PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s',
            '-o', outputFile,
            streamUrl,
        ];

        const child = spawn('yt-dlp', args, { shell: process.platform === 'win32' });
        let stderrTail = '';
        let activeBar = false;

        const handleLine = (line) => {
            if (!line) return;
            if (line.startsWith('PROGRESS|')) {
                const parts = line.split('|');
                const percentStr = (parts[1] || '').trim();
                const speedStr = (parts[2] || '').trim();
                const etaStr = (parts[3] || '').trim();
                const percent = parseFloat(percentStr.replace('%', ''));
                if (!isNaN(percent)) {
                    renderProgressBar('Downloading', percent, speedStr || 'N/A', etaStr || '--:--');
                    activeBar = true;
                    if (onProgress) onProgress(percent, speedStr || 'N/A', etaStr || '--:--');
                }
            }
        };

        const consume = (buf, isErr) => {
            const text = buf.toString();
            if (isErr) stderrTail = (stderrTail + text).slice(-2000);
            const lines = text.split(/\r\n|\r|\n/);
            for (const l of lines) handleLine(l);
        };

        child.stdout.on('data', (d) => consume(d, false));
        child.stderr.on('data', (d) => consume(d, true));

        child.on('close', (code) => {
            if (activeBar) endProgressLine();
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp (Bunny) exited with code ${code}. ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
        });

        child.on('error', reject);
    });
}

// ─── ffmpeg-based MP3 extraction ─────────────────────────────────────────────
// Probes input duration with ffprobe (fail-soft: indeterminate progress on
// failure), then runs ffmpeg to produce a lightweight MP3 (64k mono 22050Hz).
// Parses -progress pipe:1 output (out_time_ms=… progress=continue|end) to
// drive the Telegram live message. Progress is clamped to 99% until the
// process reports progress=end, at which point we emit 100%.
function probeDurationMs(inputFile) {
    return new Promise((resolve) => {
        const child = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            inputFile,
        ], { shell: process.platform === 'win32' });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('close', () => {
            try {
                const parsed = JSON.parse(out);
                const sec = parseFloat(parsed?.format?.duration);
                if (!isNaN(sec) && sec > 0) return resolve(Math.round(sec * 1000));
            } catch (_) {}
            resolve(null); // signal "unknown duration"
        });
        child.on('error', () => resolve(null));
    });
}

function extractAudio(inputFile, outputFile, onProgress) {
    return new Promise(async (resolve, reject) => {
        const totalMs = await probeDurationMs(inputFile);

        const args = [
            '-y', '-hide_banner',
            '-i', inputFile,
            '-vn',
            '-ac', '1',
            '-ar', '22050',
            '-b:a', '64k',
            '-progress', 'pipe:1',
            '-nostats',
            outputFile,
        ];

        const child = spawn('ffmpeg', args, { shell: process.platform === 'win32' });
        let stderrTail = '';
        let buffered = '';

        const emit = (outTimeMs, ended) => {
            if (!onProgress) return;
            if (ended) return onProgress(100);
            if (totalMs && totalMs > 0) {
                const pct = Math.min(99, (outTimeMs / totalMs) * 100);
                onProgress(pct);
            } else {
                onProgress(null); // indeterminate
            }
        };

        child.stdout.on('data', (d) => {
            buffered += d.toString();
            let idx;
            while ((idx = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, idx).trim();
                buffered = buffered.slice(idx + 1);
                if (line.startsWith('out_time_ms=')) {
                    const us = parseInt(line.slice('out_time_ms='.length), 10);
                    if (!isNaN(us)) emit(us / 1000, false);
                } else if (line === 'progress=end') {
                    emit(0, true);
                }
            }
        });
        child.stderr.on('data', (d) => {
            stderrTail = (stderrTail + d.toString()).slice(-2000);
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}. ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
        });
        child.on('error', reject);
    });
}

// ─── Bunny Storage upload (MP3 → Storage Zone) ───────────────────────────────
// PUT to storage.bunnycdn.com/{zone}/{fileName}. Content-Type MUST be
// audio/mpeg — anything else makes the Pull-Zone URL behave as a download
// attachment instead of an inline playable stream, breaking <audio> tags
// and mobile players.
function uploadToBunnyStorage(filePath, fileName, onProgress) {
    return new Promise((resolve, reject) => {
        const fileSize = fs.statSync(filePath).size;
        let uploadedBytes = 0;
        let lastTime = Date.now();
        let lastLoaded = 0;
        let lastSpeed = 0;
        let activeBar = false;

        const fileStream = fs.createReadStream(filePath);

        fileStream.on('data', (chunk) => {
            uploadedBytes += chunk.length;
            const now = Date.now();
            const dt = (now - lastTime) / 1000;
            if (dt >= 0.3 || uploadedBytes === fileSize) {
                lastSpeed = (uploadedBytes - lastLoaded) / Math.max(dt, 0.001);
                const percent = (uploadedBytes / fileSize) * 100;
                const remaining = lastSpeed > 0 ? (fileSize - uploadedBytes) / lastSpeed : Infinity;
                renderProgressBar('Storage    ', percent, formatSpeed(lastSpeed), formatEta(remaining));
                activeBar = true;
                if (onProgress) onProgress(percent, formatSpeed(lastSpeed), formatEta(remaining));
                lastTime = now;
                lastLoaded = uploadedBytes;
            }
        });

        // URL-encode each path segment so spaces/Unicode survive (slug is
        // ASCII-safe today, but this guard keeps us safe if that ever changes).
        const encodedPath = fileName.split('/').map(encodeURIComponent).join('/');
        const url = `https://storage.bunnycdn.com/${BUNNY_STORAGE_ZONE_NAME}/${encodedPath}`;

        axios.put(url, fileStream, {
            headers: {
                'AccessKey': BUNNY_STORAGE_API_KEY,
                'Content-Type': 'audio/mpeg',
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        })
            .then(() => {
                if (activeBar) endProgressLine();
                const publicUrl = `https://${BUNNY_PULL_ZONE_URL}/${encodedPath}`;
                resolve(publicUrl);
            })
            .catch((err) => {
                if (activeBar) endProgressLine();
                reject(err);
            });
    });
}

// ─── Entry classification ────────────────────────────────────────────────────
// Inspect the playlist entry's two URL fields and decide which pipeline branch
// applies. Order matters — invalid URL first so we never feed garbage to
// yt-dlp/ffmpeg; then 'skip' for fully-done entries; then 'audio-only' for
// back-fill; else 'full'.
function classifyMode(videoObj) {
    const url = videoObj && videoObj.youtubeUrl;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return 'skip';
    const onBunny = url.includes('mediadelivery.net');
    const hasAudio = !!(videoObj.audioUrl && typeof videoObj.audioUrl === 'string' && videoObj.audioUrl.length);
    if (onBunny && hasAudio) return 'skip';
    if (onBunny && !hasAudio) return 'audio-only';
    return 'full';
}

// Sweep every file in the project root whose name starts with `${stem}.` and
// delete it. yt-dlp's HLS downloader produces a constellation of side files
// per download (`{stem}.mp4.part-FragN`, `{stem}.mp4.part-FragN.part`,
// `{stem}.mp4.ytdl`, `{stem}.temp.mp4`) that the previous narrow cleanup
// missed — under parallel dispatch with occasional yt-dlp crashes, these
// accumulate into hundreds of leftover files. Stems are UUIDs / YouTube IDs /
// slugs, so the prefix is unique enough that this sweep can't collide with
// unrelated files (cookies.txt, playlist.json, etc).
function cleanupStemFiles(stem) {
    if (!stem) return 0;
    const prefix = `${stem}.`;
    let removed = 0;
    try {
        for (const f of fs.readdirSync(__dirname)) {
            if (!f.startsWith(prefix)) continue;
            try {
                fs.unlinkSync(path.join(__dirname, f));
                removed++;
            } catch (cleanupErr) {
                console.warn(`Cleanup failed for ${f}: ${cleanupErr.message}`);
            }
        }
    } catch (e) {
        console.warn(`Cleanup readdir failed: ${e.message}`);
    }
    return removed;
}

async function processVideo(videoObj, cookieArgs, ctx) {
    // Stable per-entry filename stem. Falling back through this chain matters
    // for two reasons: (1) empty videoId would resolve to ".mp4" — a hidden
    // file in the project root — and (2) under parallel dispatch, two entries
    // with empty videoId would collide on the same temp file AND on yt-dlp's
    // ".mp4.part-FragN.part" fragment files, causing rename failures. The
    // priority order also keeps temp filenames human-debuggable.
    const stem = (videoObj.videoId && String(videoObj.videoId).trim())
        || extractBunnyGuid(videoObj.youtubeUrl)
        || (videoObj.slug && String(videoObj.slug).trim())
        || `entry-${ctx && ctx.videoIndex ? ctx.videoIndex : Date.now()}`;
    const tmpFile = path.join(__dirname, `${stem}.mp4`);
    const mp3File = path.join(__dirname, `${stem}.mp3`);
    const partFile = `${tmpFile}.part`;
    const title = videoObj.lessonTitle || videoObj.videoId || 'Unknown';

    // Sweep all stale files from prior failed attempts for this stem. Catches
    // not just .mp4 / .mp3 / .mp4.part but also yt-dlp's .ytdl resume state
    // and any leftover .mp4.part-FragN fragments — without this, yt-dlp would
    // try to resume an old session and likely crash on a missing fragment.
    cleanupStemFiles(stem);

    // Header shown at top of every Telegram message for this video
    const { videoIndex, total, completed, sourceType, sourceLabel, attempt, liveId: providedLiveId, mode } = ctx;
    const isAudioOnly = mode === 'audio-only';
    const overallPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const sourceTag = sourceLabel ? ` | ${sourceEmoji(sourceType)} ${sourceLabel}` : '';
    const attemptLabel = attempt > 1 ? ` (ניסיון ${attempt})` : '';
    const header =
        `🎬 *[${videoIndex}/${total}]* ${title}${attemptLabel}\n` +
        `📈 התקדמות כוללת: ${completed}/${total} (${overallPct}%)${sourceTag}\n` +
        `🕐 ${nowHHMM()}`;

    // ── Live Telegram progress message ─────────────────────────────────────
    // If ctx supplies a liveId, reuse it (one message per video, edited across
    // attempts). Otherwise create a fresh one (legacy/standalone behavior).
    let liveId = providedLiveId || null;
    let lastEditAt = 0;
    // Throttle scales with the active parallel-pool size to keep the
    // chat-wide edit rate under Telegram's ~1 msg/s per-chat limit. With N
    // parallel entries each editing at 1/throttle, the chat-wide rate is
    // N * (1000 / throttle); pinning throttle to N * 1500 keeps that at
    // ~0.67/s regardless of parallelism. At N=1 the floor of 2000ms keeps
    // single-stream UX unchanged.
    const parallelN = parseInt(readParallelPreset(), 10) || 1;
    const DL_THROTTLE_MS  = Math.max(2000, parallelN * 1500);
    const UPL_THROTTLE_MS = Math.max(2000, parallelN * 1500);

    const initLive = async (text) => {
        if (liveId) {
            lastEditAt = Date.now();
            return editTelegramMessage(liveId, text);
        }
        const msg = await sendTelegramMessage(text);
        liveId = msg?.message_id || null;
        lastEditAt = Date.now();
    };

    const updateLive = (text, throttleMs) => {
        const now = Date.now();
        if (!liveId || now - lastEditAt < throttleMs) return;
        lastEditAt = now;
        return editTelegramMessage(liveId, text);
    };

    const forceUpdateLive = (text) => {
        if (!liveId) return;
        lastEditAt = Date.now();
        return editTelegramMessage(liveId, text);
    };

    const finalizeLive = (text) => editTelegramMessage(liveId, text);
    // ───────────────────────────────────────────────────────────────────────

    let doneText = ''; // summary text after completion (reused in countdown)
    const videoStart = Date.now();

    try {
        console.log(`\n--- Processing [${videoIndex}/${total}] (${mode}): ${title} ---`);

        // ── Phase 1: Download ─────────────────────────────────────────────
        let downloadedRes = null;     // YouTube only — tracked for the summary
        let downloadLabel;            // 'הורדה (YouTube)' or 'הורדה (Bunny)'

        if (isAudioOnly) {
            downloadLabel = 'הורדה (Bunny)';
            const guidLog = extractBunnyGuid(videoObj.youtubeUrl);
            console.log(`Audio-only re-process: pulling MP4 from Bunny${guidLog ? ` (guid=${guidLog})` : ''}`);
            await initLive(`${header}\n\n📥 מתחיל הורדה מ-Bunny...`);
        } else {
            downloadLabel = 'הורדה (YouTube)';
            await initLive(`${header}\n\n📥 מתחיל הורדה מ-YouTube...`);
            console.log('Downloading from YouTube at maximum quality...');
            const maxRes = await listFormats(videoObj.youtubeUrl, cookieArgs);
            if (maxRes > 0 && maxRes < 1080) {
                // Could be either: (a) cookies session is degraded, or (b) the video
                // itself was uploaded below 1080p. Ask the user which it is.
                const choice = await askUserQualityChoice({
                    liveId, videoIndex, total, title, maxRes
                });
                if (choice === 'rotate') {
                    throw new Error(`User chose to rotate — source offers only ${maxRes}p`);
                }
                console.log(`User chose to continue at ${maxRes}p.`);
            }
            // Quality actually downloaded: capped at 1080p by the format selector.
            downloadedRes = maxRes > 0 ? Math.min(maxRes, 1080) : null;
        }

        const downloadStart = Date.now();
        const onDlProgress = (pct, speed, eta) => {
            updateLive(
                `${header}\n\n` +
                `📥 *${downloadLabel}:* ${pct.toFixed(1)}%\n` +
                `\`${telegramBar(pct)}\`\n` +
                `⚡ ${speed} | ETA ${eta}`,
                DL_THROTTLE_MS
            );
        };
        if (isAudioOnly) {
            await downloadFromBunny(videoObj.youtubeUrl, tmpFile, onDlProgress);
        } else {
            await downloadFromYoutube(videoObj.youtubeUrl, tmpFile, cookieArgs, onDlProgress);
        }

        const dlDuration = Math.round((Date.now() - downloadStart) / 1000);
        const dlDurationStr = formatDuration(dlDuration);
        const fileSizeBytes = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
        const fileSize = fileSizeBytes ? formatBytes(fileSizeBytes) : '?';

        // ── Phase 2: Bunny Stream upload (full mode only) ─────────────────
        let ulDurationStr = null;
        let streamLine = '';
        if (!isAudioOnly) {
            await forceUpdateLive(
                `${header}\n\n` +
                `📥 ${downloadLabel} ✅ ${dlDurationStr} | ${fileSize}\n` +
                `☁️ מתחיל העלאה ל-Bunny Stream...`
            );

            const collectionId = await getOrCreateCollection(videoObj.subCategory);
            const metaTags = Object.keys(videoObj).map(key => ({
                property: key,
                value: String(videoObj[key])
            }));

            console.log('Creating video record...');
            const createRes = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
                {
                    title: videoObj.lessonTitle,
                    collectionId: collectionId || '',
                    metaTags: metaTags
                },
                { headers }
            );
            const guid = createRes.data.guid;

            const uploadStart = Date.now();
            console.log('Uploading to Bunny Stream...');
            await uploadToBunny(guid, tmpFile, (pct, speed, eta) => {
                updateLive(
                    `${header}\n\n` +
                    `📥 ${downloadLabel} ✅ ${dlDurationStr} | ${fileSize}\n` +
                    `☁️ *Bunny Stream:* ${pct.toFixed(1)}%\n` +
                    `\`${telegramBar(pct)}\`\n` +
                    `⚡ ${speed} | ETA ${eta}`,
                    UPL_THROTTLE_MS
                );
            });
            ulDurationStr = formatDuration(Math.round((Date.now() - uploadStart) / 1000));
            videoObj.youtubeUrl = `https://iframe.mediadelivery.net/play/${BUNNY_LIBRARY_ID}/${guid}`;
            streamLine = `☁️ Bunny Stream ✅ ${ulDurationStr}\n`;
        }

        // ── Phase 3: MP3 extraction ──────────────────────────────────────
        // ffmpeg on a short rip can complete inside one throttle window, so we
        // force a "started" and "completed" message regardless of the throttle.
        const baseSummary =
            `${header}\n\n` +
            `📥 ${downloadLabel} ✅ ${dlDurationStr} | ${fileSize}\n` +
            (streamLine ? streamLine : '');

        await forceUpdateLive(baseSummary + `🎵 *חילוץ אודיו:* התחיל...`);

        const audioStart = Date.now();
        console.log('Extracting MP3 (64k mono 22050Hz)...');
        await extractAudio(tmpFile, mp3File, (pct) => {
            if (pct == null) {
                updateLive(baseSummary + `🎵 *חילוץ אודיו:* מעבד...`, DL_THROTTLE_MS);
                return;
            }
            updateLive(
                baseSummary +
                `🎵 *חילוץ אודיו:* ${pct.toFixed(1)}%\n` +
                `\`${telegramBar(pct)}\``,
                DL_THROTTLE_MS
            );
        });
        const audioDur = Math.round((Date.now() - audioStart) / 1000);
        const audioDurStr = formatDuration(audioDur);
        const mp3SizeBytes = fs.existsSync(mp3File) ? fs.statSync(mp3File).size : 0;
        const mp3Size = mp3SizeBytes ? formatBytes(mp3SizeBytes) : '?';

        const afterExtract = baseSummary + `🎵 אודיו ✅ ${audioDurStr} | ${mp3Size}\n`;
        await forceUpdateLive(afterExtract + `📤 מתחיל העלאה ל-Bunny Storage...`);

        // ── Phase 4: Bunny Storage upload ────────────────────────────────
        // Mirror Bunny Stream's collection layout: organize MP3s under a
        // subfolder named after subCategory (same value used for the Stream
        // collection). Falls back to flat `audio/{slug}.mp3` if subCategory
        // is missing/empty. uploadToBunnyStorage URL-encodes each path
        // segment so Hebrew subCategory names roundtrip safely.
        const subFolder = videoObj.subCategory && String(videoObj.subCategory).trim();
        const audioFileName = subFolder
            ? `audio/${subFolder}/${videoObj.slug}.mp3`
            : `audio/${videoObj.slug}.mp3`;
        const storageStart = Date.now();
        console.log(`Uploading MP3 to Bunny Storage as ${audioFileName}...`);
        const audioPublicUrl = await uploadToBunnyStorage(mp3File, audioFileName, (pct, speed, eta) => {
            updateLive(
                afterExtract +
                `📤 *Bunny Storage:* ${pct.toFixed(1)}%\n` +
                `\`${telegramBar(pct)}\`\n` +
                `⚡ ${speed} | ETA ${eta}`,
                UPL_THROTTLE_MS
            );
        });
        const storageDurStr = formatDuration(Math.round((Date.now() - storageStart) / 1000));
        videoObj.audioUrl = audioPublicUrl;

        // ── Wrap up ──────────────────────────────────────────────────────
        const totalDur = formatDuration(Math.round((Date.now() - videoStart) / 1000));
        const completedAfter = completed + 1;
        const overallPctAfter = total > 0 ? Math.round((completedAfter / total) * 100) : 0;
        const qualityTag = downloadedRes ? ` | 📺 ${downloadedRes}p` : '';

        doneText =
            `✅ *הושלם [${videoIndex}/${total}]:* ${title}\n` +
            `📥 ${downloadLabel} ✅ ${dlDurationStr} | ${fileSize}${qualityTag}\n` +
            (streamLine ? streamLine : '') +
            `🎵 אודיו ✅ ${audioDurStr} | ${mp3Size}\n` +
            `📤 Bunny Storage ✅ ${storageDurStr}\n` +
            `⏱️ זמן כולל: ${totalDur}\n` +
            `📊 סה״כ הושלמו: ${completedAfter}/${total} (${overallPctAfter}%)`;

        await finalizeLive(doneText);
        console.log(`Done: ${title} (${totalDur})`);
        return { success: true, videoObj, liveId, doneText, bytes: fileSizeBytes + mp3SizeBytes };

    } catch (e) {
        console.error(`Failed on video ${title}:`, e.message);
        if (e.response) {
            console.error('  status:', e.response.status);
            console.error('  body:', JSON.stringify(e.response.data));
        }
        await finalizeLive(
            `❌ *נכשל [${videoIndex}/${total}]:* ${title}${attemptLabel}\n` +
            (sourceLabel ? `${sourceEmoji(sourceType)} ${sourceType}: ${sourceLabel}\n` : '') +
            `\`${e.message.slice(0, 300)}\``
        );
        return { success: false, videoObj, liveId: null, doneText: '', bytes: 0 };
    } finally {
        // Broad sweep: deletes everything matching `{stem}.*` so yt-dlp's
        // fragment debris (`.part-FragN`, `.part-FragN.part`, `.ytdl`,
        // `.temp.mp4`) doesn't accumulate when yt-dlp crashes mid-run.
        const removed = cleanupStemFiles(stem);
        if (removed > 0) console.log(`Cleaned up ${removed} temp file(s) for ${stem}`);
    }
}

async function run() {
    // Stale active-buttons id from a previous run is no longer reachable
    // (message id is per-chat but the prev session's UX is over) — start clean.
    writeActiveButtonsId(null);

    // ── Required env vars for the new Bunny Storage pipeline ────────────────
    const missing = [];
    if (!BUNNY_STORAGE_API_KEY)  missing.push('BUNNY_STORAGE_API_KEY');
    if (!BUNNY_STORAGE_ZONE_NAME) missing.push('BUNNY_STORAGE_ZONE_NAME');
    if (!BUNNY_PULL_ZONE_URL)    missing.push('BUNNY_PULL_ZONE_URL');
    if (missing.length) {
        const msg = `Missing required env var(s): ${missing.join(', ')}`;
        console.error(msg);
        await sendTelegram(`❌ *משתני סביבה חסרים*\n\`${missing.join(', ')}\`\nהוסף אותם ל-.env ואז Restart.`);
        throw new Error(msg);
    }

    const filePath = path.join(__dirname, 'playlist.json');
    if (!fs.existsSync(filePath)) {
        return console.error('playlist.json not found');
    }

    const playlistData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const total = playlistData.length;
    // Completion now requires BOTH a Bunny Stream URL AND an audioUrl. Entries
    // that have only the Stream URL count as remaining (audio-only re-process).
    const isDone = (v) => classifyMode(v) === 'skip' && !!v.youtubeUrl && v.youtubeUrl.includes('mediadelivery.net');
    let completed = playlistData.filter(isDone).length;
    const startedAt = completed; // for session-stats (how many we did THIS run)
    const remaining = total - completed;
    const fullCount = playlistData.filter(v => classifyMode(v) === 'full').length;
    const audioOnlyCount = playlistData.filter(v => classifyMode(v) === 'audio-only').length;
    console.log(`Found ${total} videos. Done: ${completed}. Pending: full=${fullCount}, audio-only=${audioOnlyCount}.`);

    // ── Auth source rotation setup ──────────────────────────────────────────
    // Sticky cookie rotation: cookies1.txt → cookies2.txt → cookies3.txt.
    // Active source stays on whichever last worked; advances only on failure.
    // Cookies are required only when at least one entry needs the YouTube path.
    const sources = buildAuthSources();
    if (sources.length === 0 && fullCount > 0) {
        const msg = 'No cookie files found (expected cookies1.txt / cookies2.txt / cookies3.txt). Aborting.';
        console.error(msg);
        await sendTelegram(`❌ *אין קבצי cookies*\nהעלה לפחות \`cookies1.txt\` (שלח את הקובץ בטלגרם או הנח על השרת) ואז Restart.`);
        throw new Error(msg);
    }
    let sourceIdx = 0;
    const activeSource = () => sources[sourceIdx] || null;
    const cookieCount = sources.length;
    console.log(`Auth sources: ${cookieCount} cookie file(s)`);
    if (cookieCount) console.log(`Order: ${sources.map(s => s.label).join(' → ')}`);

    await loadCollections();

    // ── Session stats ──────────────────────────────────────────────────────
    const sessionStart = Date.now();
    let sessionBytes = 0;
    let sessionFailures = 0;

    await sendTelegram(
        `🚀 *youtube-to-bunny התחיל*\n` +
        `🕐 ${nowHHMM()}\n` +
        `📊 סה״כ בפלייליסט: ${total}\n` +
        `✅ כבר הועלו: ${completed}\n` +
        `⏳ נותרו לעיבוד: ${remaining}  (full=${fullCount}, audio-only=${audioOnlyCount})\n` +
        `🔀 הורדה במקביל (אודיו): ×${readParallelPreset()}\n` +
        (cookieCount
            ? `🍪 ${cookieCount} cookies (לפי סדר): ${sources.map(s => s.label).join(' → ')}`
            : `🍪 ללא cookies (אין כניסות שדורשות YouTube)`)
    );

    // ── Concurrent dispatch infrastructure ─────────────────────────────────
    // Audio-only entries can run in parallel (Bunny CDN handles concurrency
    // fine and there are no cookies to manage). Full-mode entries stay
    // strictly sequential — cookie rotation depends on a known-good cookie
    // state, and parallel YouTube hits under one cookie pool accelerate
    // bot detection. The pool's size is re-read per dispatch so a /settings
    // change takes effect on the next entry.
    const audioPool = new Set();
    const drainAudioPool = async () => {
        while (audioPool.size > 0) {
            try { await Promise.race(audioPool); } catch (_) {}
        }
    };
    // Serialize playlist writes through a promise chain so concurrent audio
    // entries can't trample each other's snapshots.
    let writeChain = Promise.resolve();
    const writePlaylist = () => {
        writeChain = writeChain.then(() => {
            try { fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2)); }
            catch (e) { console.error('Playlist write failed:', e.message); }
        });
        return writeChain;
    };
    // Mode of the next non-skip entry after index i, or null if none.
    const nextPendingMode = (i) => {
        for (let j = i + 1; j < playlistData.length; j++) {
            const m = classifyMode(playlistData[j]);
            if (m !== 'skip') return m;
        }
        return null;
    };
    // Inter-video wait fires only when the next pending entry is full-mode.
    // Audio→Audio skips the wait entirely (Bunny doesn't need anti-bot pacing).
    // Audio→Full and Full→Full keep the 2-6 min (or 10s no-wait) cooling-off.
    const maybeInterVideoWait = async (i, doneText, liveId) => {
        const nextMode = nextPendingMode(i);
        if (nextMode !== 'full') return;
        const noWait = isNoWaitMode();
        const delaySec = noWait ? 10 : Math.floor(Math.random() * (360 - 120 + 1)) + 120;
        console.log(`\n⏱️  Waiting ${noWait ? '10s (no-wait mode)' : (delaySec / 60).toFixed(1) + ' min'} before next download...`);
        await sleepWithProgressBar({
            totalSec: delaySec,
            liveId,
            bodyTop: doneText + '\n\n⏳ *המתנה לסרטון הבא:*',
            finalText: doneText,
            tickMs: 15000,
        });
    };

    // Per-entry orchestration shared by both audio-only (pool) and full
    // (sequential) branches. Builds the live message, then runs processVideo
    // with cookie rotation for full mode or single-attempt for audio-only.
    const dispatchEntry = async (video, i, mode) => {
        let result = null;
        let attempt = 0;

        const title = video.lessonTitle || video.videoId || 'Unknown';
        const overallPct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const startMsg = await sendTelegramMessage(
            `🎬 *[${i + 1}/${total}]* ${title}\n` +
            `📈 התקדמות: ${completed}/${total} (${overallPct}%)\n` +
            `🕐 ${nowHHMM()}\n` +
            `🛠️ מצב: ${mode === 'audio-only' ? 'אודיו בלבד (Bunny→MP3)' : 'מלא (YouTube→Stream+MP3)'}\n\n` +
            `📥 מתחיל...`
        );
        const liveId = startMsg?.message_id || null;

        const tryWith = async (source) => {
            attempt++;
            if (attempt > 1) {
                const nextHeb = source && source.type === 'cookie' ? 'Cookie' : 'ישיר';
                const label = source ? source.label : '—';
                console.log(`\n🔄 Switching to ${source ? source.type + ':' + label : 'no-auth'} (attempt ${attempt}) — waiting 30s...`);
                await sleepWithProgressBar({
                    totalSec: 30,
                    liveId,
                    bodyTop:
                        `🎬 *[${i + 1}/${total}]* ${title}\n` +
                        `🔄 *מחליף ל-${nextHeb}: ${label}*\n` +
                        `🔁 ניסיון ${attempt}`,
                    tickMs: 5000
                });
            }
            return await processVideo(video, source ? buildYtdlpAuthArgs(source) : [], {
                videoIndex: i + 1,
                total,
                completed,
                sourceType: source ? source.type : 'none',
                sourceLabel: source ? source.label : '',
                attempt,
                liveId,
                mode,
            });
        };

        if (mode === 'audio-only') {
            // Bunny doesn't need cookies — single attempt, no rotation.
            result = await tryWith(null);
        } else {
            // Full mode: try current cookie source; on failure, advance through the rest.
            result = await tryWith(activeSource());
            while (!result.success && sourceIdx < sources.length - 1) {
                sourceIdx++;
                result = await tryWith(activeSource());
            }
        }

        return { result, liveId };
    };

    for (let i = 0; i < playlistData.length; i++) {
        const video = playlistData[i];
        const mode = classifyMode(video);

        if (mode === 'skip') {
            const reason = video.audioUrl ? 'already complete' : 'invalid/empty youtubeUrl';
            console.log(`Skipping (${reason}): ${video.lessonTitle || video.videoId}`);
            continue;
        }

        if (mode === 'audio-only') {
            // Pool dispatch: respect the live /settings concurrency cap. No
            // inter-video wait — the outer loop fans out the next entry as
            // soon as a slot frees up.
            const N = parseInt(readParallelPreset(), 10) || 1;
            while (audioPool.size >= N) {
                try { await Promise.race(audioPool); } catch (_) {}
            }
            const idx = i;
            const promise = (async () => {
                try {
                    const { result } = await dispatchEntry(video, idx, 'audio-only');
                    if (result.success) {
                        completed++;
                        sessionBytes += result.bytes || 0;
                        console.log(`Progress: ${completed}/${total} videos completed.`);
                        await writePlaylist();
                    } else {
                        // Non-fatal: log, persist, and let the next run retry.
                        sessionFailures++;
                        await writePlaylist();
                    }
                } catch (err) {
                    console.error(`Audio-only dispatch crashed for entry ${idx + 1}:`, err.message);
                    sessionFailures++;
                }
            })();
            audioPool.add(promise);
            promise.finally(() => audioPool.delete(promise));
            continue;
        }

        // Full mode: drain any in-flight audio first so cookies aren't being
        // exercised concurrently with stragglers and the playlist state is
        // fully flushed before we start the next sequential entry.
        await drainAudioPool();

        const { result, liveId } = await dispatchEntry(video, i, 'full');

        if (result.success) {
            completed++;
            sessionBytes += result.bytes || 0;
            console.log(`Progress: ${completed}/${total} videos completed.`);
            await writePlaylist();
            await maybeInterVideoWait(i, result.doneText, result.liveId);
        } else {
            // All cookie sources exhausted — fatal. Drain in-flight audio
            // first so their temp files clean up via their own finally blocks.
            sessionFailures++;
            await writePlaylist();
            await drainAudioPool();
            const failedTitle = video.lessonTitle || video.videoId || 'לא ידוע';
            const sessionDur = formatDuration(Math.round((Date.now() - sessionStart) / 1000));
            const stopText =
                `❌ *youtube-to-bunny נעצרה!*\n` +
                `🎬 [${i + 1}/${total}] ${failedTitle}\n` +
                `🔁 נכשל עם כל ${cookieCount} קבצי ה-cookies\n` +
                `📊 הושלמו ${completed}/${total} (${completed - startedAt} בסשן זה)\n` +
                `⏱️ זמן ריצה: ${sessionDur}\n` +
                `🕐 ${nowHHMM()}`;
            if (liveId) await editTelegramMessage(liveId, stopText);
            else await sendTelegram(stopText);
            throw new Error(`Video failed on all auth sources: ${failedTitle}`);
        }
    }

    // Drain any audio-only entries still in flight from the tail of the list.
    await drainAudioPool();
    await writePlaylist();
    console.log('\nSync complete and updated file saved successfully!');

    const sessionDur = formatDuration(Math.round((Date.now() - sessionStart) / 1000));
    const doneThisSession = completed - startedAt;
    await sendTelegram(
        `🎉 *youtube-to-bunny הסתיים בהצלחה!*\n` +
        `✅ סה״כ הושלמו: ${completed}/${total}\n` +
        `🆕 הועלו בסשן זה: ${doneThisSession}\n` +
        `📦 נתונים שעובדו: ${formatBytes(sessionBytes)}\n` +
        `⏱️ זמן ריצה: ${sessionDur}\n` +
        `🕐 ${nowHHMM()}`
    );
}

run().catch(async (err) => {
    console.error('Fatal error:', err.message);
    await sendTelegram(`🚨 *youtube-to-bunny קרסה!*\n\`${err.message}\``);
    process.exit(1);
});
