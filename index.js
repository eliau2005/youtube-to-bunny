require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

const { BUNNY_LIBRARY_ID, BUNNY_API_KEY } = process.env;

const headers = {
    'AccessKey': BUNNY_API_KEY,
    'Content-Type': 'application/json'
};

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

// ─── Telegram Helpers ────────────────────────────────────────────────────────

// Sends a new message; resolves with the Telegram Message object (contains .message_id) or null
function sendTelegramMessage(text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve(null);
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
                try { resolve(JSON.parse(data).result || null); }
                catch { resolve(null); }
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

// Edits an existing message in-place; handles Telegram 429 rate-limit gracefully
function editTelegramMessage(messageId, text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return Promise.resolve();
    if (Date.now() < tgBackoffUntil) return Promise.resolve(); // in backoff — skip silently
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

// Asks the user (via Telegram inline buttons) whether to download a sub-1080p
// video at its current quality or rotate cookies. Bot-listener catches the
// callback_query and writes `.choice-{id}.json` with the answer; we poll for it.
// Falls back to 'rotate' on timeout (5 min) — safe default that triggers rotation.
async function askUserQualityChoice({ liveId, videoIndex, total, title, maxRes }) {
    const requestId = `${videoIndex}_${Date.now()}`;
    const choiceFile = path.join(__dirname, `.choice-${requestId}.json`);
    const promptText =
        `🎬 *[${videoIndex}/${total}]* ${title}\n\n` +
        `⚠️ *הסרטון הזה מציע מקסימום ${maxRes}p* (לא 1080p)\n` +
        `הסיבה כנראה הסרטון עצמו, לא ה-cookies. מה לעשות?`;
    const buttons = {
        inline_keyboard: [[
            { text: `✅ הורד ב-${maxRes}p`, callback_data: `quality:${requestId}:continue` },
            { text: '🔄 החלף Cookies', callback_data: `quality:${requestId}:rotate` }
        ]]
    };
    if (liveId) await editTelegramMessage(liveId, promptText, buttons);
    else await sendTelegramMessage(promptText, buttons);

    console.warn(`\n⚠️  Video offers max ${maxRes}p. Awaiting choice in Telegram (request ${requestId}). 5-min timeout → 'rotate'.`);

    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    while (Date.now() - startedAt < TIMEOUT_MS) {
        if (fs.existsSync(choiceFile)) {
            try {
                const choice = JSON.parse(fs.readFileSync(choiceFile, 'utf8'));
                fs.unlinkSync(choiceFile);
                console.log(`Choice received: ${choice.answer}`);
                return choice.answer; // 'continue' or 'rotate'
            } catch (_) { /* malformed file — ignore and keep polling */ }
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.warn('Timed out waiting for quality choice. Defaulting to rotate.');
    return 'rotate';
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
        const args = [...cookieArgs, '-F', '--no-playlist', '--js-runtimes', 'node', youtubeUrl];
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
        const args = [
            ...cookieArgs,
            '--no-playlist',
            '--js-runtimes', 'node',
            '--downloader', 'aria2c',
            '--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 5M --console-log-level=info --summary-interval=1',
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

async function processVideo(videoObj, cookieArgs, ctx) {
    const tmpFile = path.join(__dirname, `${videoObj.videoId}.mp4`);
    const partFile = `${tmpFile}.part`;
    const title = videoObj.lessonTitle || videoObj.videoId || 'Unknown';

    // Clean up any existing files from previous failed/interrupted attempts
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    if (fs.existsSync(partFile)) fs.unlinkSync(partFile);

    // Header shown at top of every Telegram message for this video
    const { videoIndex, total, completed, sourceType, sourceLabel, attempt, liveId: providedLiveId } = ctx;
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
    const DL_THROTTLE_MS  = 2000; // download/upload progress: every 2 sec
    const UPL_THROTTLE_MS = 2000;

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
        console.log(`\n--- Processing [${videoIndex}/${total}]: ${title} ---`);
        await initLive(`${header}\n\n📥 מתחיל הורדה מ-YouTube...`);

        console.log('Downloading from YouTube at maximum quality...');
        const maxRes = await listFormats(videoObj.youtubeUrl, cookieArgs);
        if (maxRes > 0 && maxRes < 1080) {
            // Could be either: (a) cookies session is degraded, or (b) the video itself
            // was uploaded below 1080p. Ask the user via Telegram which it is.
            const choice = await askUserQualityChoice({
                liveId, videoIndex, total, title, maxRes
            });
            if (choice === 'rotate') {
                throw new Error(`User chose to rotate — source offers only ${maxRes}p`);
            }
            // 'continue' → fall through and download at the available quality
            console.log(`User chose to continue at ${maxRes}p.`);
        }

        const downloadStart = Date.now();

        await downloadFromYoutube(videoObj.youtubeUrl, tmpFile, cookieArgs, (pct, speed, eta) => {
            updateLive(
                `${header}\n\n` +
                `📥 *הורדה:* ${pct.toFixed(1)}%\n` +
                `\`${telegramBar(pct)}\`\n` +
                `⚡ ${speed} | ETA ${eta}`,
                DL_THROTTLE_MS
            );
        });

        // Compute download stats
        const dlDuration = Math.round((Date.now() - downloadStart) / 1000);
        const dlDurationStr = formatDuration(dlDuration);
        const fileSizeBytes = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
        const fileSize = fileSizeBytes ? formatBytes(fileSizeBytes) : '?';

        // Force-update: download done + file stats
        await forceUpdateLive(
            `${header}\n\n` +
            `📥 הורדה ✅ ${dlDurationStr} | ${fileSize}\n` +
            `☁️ מתחיל העלאה ל-Bunny...`
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
        console.log('Uploading to Bunny...');
        await uploadToBunny(guid, tmpFile, (pct, speed, eta) => {
            updateLive(
                `${header}\n\n` +
                `📥 הורדה ✅ ${dlDurationStr} | ${fileSize}\n` +
                `☁️ *העלאה:* ${pct.toFixed(1)}%\n` +
                `\`${telegramBar(pct)}\`\n` +
                `⚡ ${speed} | ETA ${eta}`,
                UPL_THROTTLE_MS
            );
        });
        const ulDuration = Math.round((Date.now() - uploadStart) / 1000);
        const ulDurationStr = formatDuration(ulDuration);

        const bunnyStreamUrl = `https://iframe.mediadelivery.net/play/${BUNNY_LIBRARY_ID}/${guid}`;
        videoObj.youtubeUrl = bunnyStreamUrl;

        const totalDur = formatDuration(Math.round((Date.now() - videoStart) / 1000));
        const completedAfter = completed + 1;
        const overallPctAfter = total > 0 ? Math.round((completedAfter / total) * 100) : 0;

        doneText =
            `✅ *הושלם [${videoIndex}/${total}]:* ${title}\n` +
            `📥 הורדה ✅ ${dlDurationStr} | ${fileSize}\n` +
            `☁️ העלאה ✅ ${ulDurationStr}\n` +
            `⏱️ זמן כולל: ${totalDur}\n` +
            `📊 סה״כ הושלמו: ${completedAfter}/${total} (${overallPctAfter}%)`;

        await finalizeLive(doneText);
        console.log(`Done: ${title} (${totalDur})`);
        return { success: true, videoObj, liveId, doneText, bytes: fileSizeBytes };

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
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

async function run() {
    const filePath = path.join(__dirname, 'playlist.json');
    if (!fs.existsSync(filePath)) {
        return console.error('playlist.json not found');
    }

    const playlistData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const total = playlistData.length;
    let completed = playlistData.filter(v => v.youtubeUrl && v.youtubeUrl.includes('mediadelivery.net')).length;
    const startedAt = completed; // for session-stats (how many we did THIS run)
    const remaining = total - completed;
    console.log(`Found ${total} videos in the file. Already completed: ${completed}/${total}.`);

    // ── Auth source rotation setup ──────────────────────────────────────────
    // Sticky cookie rotation: cookies1.txt → cookies2.txt → cookies3.txt.
    // Active source stays on whichever last worked; advances only on failure.
    const sources = buildAuthSources();
    if (sources.length === 0) {
        const msg = 'No cookie files found (expected cookies1.txt / cookies2.txt / cookies3.txt). Aborting.';
        console.error(msg);
        await sendTelegram(`❌ *אין קבצי cookies*\nהעלה לפחות \`cookies1.txt\` (שלח את הקובץ בטלגרם או הנח על השרת) ואז Restart.`);
        throw new Error(msg);
    }
    let sourceIdx = 0;
    const activeSource = () => sources[sourceIdx];
    const cookieCount = sources.length;
    console.log(`Auth sources: ${cookieCount} cookie file(s)`);
    console.log(`Order: ${sources.map(s => s.label).join(' → ')}`);

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
        `⏳ נותרו לעיבוד: ${remaining}\n` +
        `🍪 ${cookieCount} cookies (לפי סדר): ${sources.map(s => s.label).join(' → ')}`
    );

    for (let i = 0; i < playlistData.length; i++) {
        const video = playlistData[i];

        if (video.youtubeUrl && video.youtubeUrl.includes('mediadelivery.net')) {
            console.log(`Skipping, already on Bunny: ${video.lessonTitle}`);
            continue;
        }

        let result = null;
        let attempt = 0;

        // ONE telegram message per video — edited throughout (download → switching → success/failure).
        const title = video.lessonTitle || video.videoId || 'Unknown';
        const overallPct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const startMsg = await sendTelegramMessage(
            `🎬 *[${i + 1}/${total}]* ${title}\n` +
            `📈 התקדמות: ${completed}/${total} (${overallPct}%)\n` +
            `🕐 ${nowHHMM()}\n\n` +
            `📥 מתחיל...`
        );
        const liveId = startMsg?.message_id || null;

        const tryWith = async (source) => {
            attempt++;
            if (attempt > 1) {
                const nextHeb = source.type === 'cookie' ? 'Cookie' : 'ישיר';
                console.log(`\n🔄 Switching to ${source.type}:${source.label} (attempt ${attempt}) — waiting 30s...`);
                await sleepWithProgressBar({
                    totalSec: 30,
                    liveId,
                    bodyTop:
                        `🎬 *[${i + 1}/${total}]* ${title}\n` +
                        `🔄 *מחליף ל-${nextHeb}: ${source.label}*\n` +
                        `🔁 ניסיון ${attempt}`,
                    tickMs: 5000
                });
            }
            return await processVideo(video, buildYtdlpAuthArgs(source), {
                videoIndex: i + 1,
                total,
                completed,
                sourceType: source.type,
                sourceLabel: source.label,
                attempt,
                liveId
            });
        };

        // Try current source; on failure, advance through the remaining sources
        result = await tryWith(activeSource());
        while (!result.success && sourceIdx < sources.length - 1) {
            sourceIdx++;
            result = await tryWith(activeSource());
        }

        if (result.success) {
            completed++;
            sessionBytes += result.bytes || 0;
            console.log(`Progress: ${completed}/${total} videos completed.`);
            fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));

            const hasMore = playlistData.slice(i + 1).some(v => !(v.youtubeUrl && v.youtubeUrl.includes('mediadelivery.net')));
            if (hasMore) {
                // Random 2–6 min delay between videos to avoid YouTube bot detection
                const delaySec = Math.floor(Math.random() * (360 - 120 + 1)) + 120;
                console.log(`\n⏱️  Waiting ${(delaySec / 60).toFixed(1)} min before next download...`);
                await sleepWithProgressBar({
                    totalSec: delaySec,
                    liveId: result.liveId,
                    bodyTop: result.doneText + '\n\n⏳ *המתנה לסרטון הבא:*',
                    finalText: result.doneText, // restore clean state at end
                    tickMs: 15000
                });
            }
        } else {
            // All sources exhausted — stop entirely. Use the per-video message for the stop notice.
            sessionFailures++;
            fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
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

    fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
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
