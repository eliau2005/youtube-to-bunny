require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { fetchAndWriteProxies } = require('./fetch-free-proxies');

const { BUNNY_LIBRARY_ID, BUNNY_API_KEY } = process.env;

const headers = {
    'AccessKey': BUNNY_API_KEY,
    'Content-Type': 'application/json'
};

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

// ─── Telegram Helpers ────────────────────────────────────────────────────────

// Sends a new message; resolves with the Telegram Message object (contains .message_id) or null
function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve(null);
    return new Promise((resolve) => {
        const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
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
function editTelegramMessage(messageId, text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !messageId) return Promise.resolve();
    if (Date.now() < tgBackoffUntil) return Promise.resolve(); // in backoff — skip silently
    return new Promise((resolve) => {
        const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: 'Markdown' });
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

// ─── Auth Source Rotation (proxies first, cookies as fallback) ───────────────
// Order: try every proxy in proxies.txt without cookies; if all fail, fall back
// through cookie files (cookies1.txt → cookies2.txt → cookies3.txt → plain
// cookies.txt → browser cookies). Each source is tried per-video before giving up.

function getProxies() {
    const proxiesFile = path.join(__dirname, 'proxies.txt');
    if (!fs.existsSync(proxiesFile)) return [];
    return fs.readFileSync(proxiesFile, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
}

function getCookieFiles() {
    const numbered = [1, 2, 3]
        .map(n => path.join(__dirname, `cookies${n}.txt`))
        .filter(f => fs.existsSync(f));
    if (numbered.length > 0) return numbered;
    const plain = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(plain)) return [plain];
    return [];
}

function maskProxyUrl(url) {
    try {
        const u = new URL(url);
        return u.username ? `${u.protocol}//***@${u.host}` : `${u.protocol}//${u.host}`;
    } catch {
        return url;
    }
}

function buildYtdlpAuthArgs(source) {
    if (source.type === 'proxy') return ['--proxy', source.value];
    if (source.type === 'cookie') return ['--cookies', source.value];
    return ['--cookies-from-browser', 'chrome'];
}

function sourceEmoji(type) {
    return type === 'proxy' ? '🌐' : type === 'cookie' ? '🍪' : '💻';
}

// Concurrent proxy pool: each proxy is checked out by at most one worker at a
// time. checkout() blocks until a proxy is available or the pool is permanently
// exhausted (fetcher done, no in-flight checkouts that might be returned).
function createProxyPool() {
    const available = [];
    const signals = [];
    let inUse = 0;
    let fetcherDone = false;
    let totalAdded = 0;

    const notify = () => { while (signals.length) signals.shift()(); };

    return {
        add(url) {
            available.push({ type: 'proxy', value: url, label: maskProxyUrl(url) });
            totalAdded++;
            notify();
        },
        markFetcherDone() {
            fetcherDone = true;
            notify();
        },
        async checkout() {
            while (true) {
                if (available.length > 0) {
                    inUse++;
                    return available.shift();
                }
                if (fetcherDone && inUse === 0) return null; // permanently exhausted
                await new Promise(r => signals.push(r));
            }
        },
        return(source) { inUse--; available.push(source); notify(); },
        discard() { inUse--; notify(); },
        get count() { return totalAdded; },
        get availableCount() { return available.length; },
        get inUseCount() { return inUse; },
        get done() { return fetcherDone; }
    };
}
// ─────────────────────────────────────────────────────────────────────────────

function listFormats(youtubeUrl, cookieArgs) {
    return new Promise((resolve) => {
        const args = [
            ...cookieArgs, '-F', '--no-playlist', '--js-runtimes', 'node',
            '--no-check-certificate',
            // Fast-fail when proxy is bad: don't internally retry (let the rotation try the next one)
            '--retries', '1', '--extractor-retries', '1', '--socket-timeout', '15',
            youtubeUrl
        ];
        const child = spawn('yt-dlp', args, { shell: process.platform === 'win32' });
        let output = '';
        child.stdout.on('data', d => output += d.toString());
        child.stderr.on('data', d => output += d.toString());
        child.on('close', () => {
            // Extract the highest resolution available
            const resolutions = [...output.matchAll(/(\d{3,4})p/g)].map(m => parseInt(m[1]));
            const maxRes = resolutions.length ? Math.max(...resolutions) : 0;
            console.log(`Available formats (max resolution found: ${maxRes}p):`);
            // Print only the resolution table lines
            const lines = output.split('\n').filter(l =>
                l.match(/^\d+\s/) || l.includes('ID') || l.includes('---')
            );
            lines.slice(0, 30).forEach(l => console.log('  ', l));
            resolve(maxRes);
        });
        child.on('error', () => resolve(0));
    });
}

function downloadFromYoutube(youtubeUrl, outputFile, cookieArgs, onProgress) {
    return new Promise((resolve, reject) => {
        const args = [
            ...cookieArgs,
            '--no-check-certificate',
            '--no-continue',
            '--no-playlist',
            '--js-runtimes', 'node',
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
        if (maxRes > 0 && maxRes < 720) {
            console.warn(`⚠️  WARNING: YouTube is only offering ${maxRes}p - cookies may be expired or invalid!`);
            await sendTelegram(`⚠️ *אזהרה:* YouTube מציע רק ${maxRes}p — ייתכן שה-cookies פגי תוקף.`);
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

    // ── Streaming proxy fetcher + concurrent worker pool ────────────────────
    // The fetcher writes proxies.txt incrementally as each proxy passes its
    // liveness test. YouTube downloads begin as soon as the first proxy is
    // alive; the fetcher keeps populating the pool in the background.
    //
    // Up to PARALLEL_DOWNLOADS videos are processed concurrently — each worker
    // checks out a different proxy from the pool, so videos never share an IP.
    // Cookies/browser are tried only after the proxy pool is fully exhausted.
    // Skip the fetcher with SKIP_PROXY_FETCH=1.
    const skipFetch = process.env.SKIP_PROXY_FETCH === '1';
    const MAX_PARALLEL = Math.max(1, parseInt(process.env.PARALLEL_DOWNLOADS || '3', 10));

    const proxyPool = createProxyPool();

    if (skipFetch) {
        for (const url of getProxies()) proxyPool.add(url);
    }

    const cookieList = [];
    for (const file of getCookieFiles()) {
        cookieList.push({ type: 'cookie', value: file, label: path.basename(file) });
    }
    if (cookieList.length === 0) {
        cookieList.push({ type: 'browser', value: null, label: 'browser' });
    }

    let firstProxyResolve;
    const firstProxyReady = new Promise(r => { firstProxyResolve = r; });

    const fetchPromise = skipFetch
        ? Promise.resolve({ count: proxyPool.count, written: false, skipped: true })
        : (async () => {
            console.log('\n🌐 Starting proxy pool refresh in background...');
            try {
                return await fetchAndWriteProxies({
                    limit: 100,
                    timeoutMs: 4000,
                    concurrency: 200,
                    onAlive: (url) => {
                        proxyPool.add(url);
                        if (firstProxyResolve) { firstProxyResolve('proxy'); firstProxyResolve = null; }
                    }
                });
            } catch (e) {
                console.warn(`Proxy fetch failed: ${e.message}`);
                return { count: 0, written: false, error: e.message };
            }
        })();

    fetchPromise.then(() => {
        proxyPool.markFetcherDone();
        if (firstProxyResolve) { firstProxyResolve('done'); firstProxyResolve = null; }
    });

    await loadCollections();

    if (skipFetch) {
        console.log(`SKIP_PROXY_FETCH=1 → using ${proxyPool.count} existing proxies from proxies.txt.`);
        proxyPool.markFetcherDone();
    } else {
        console.log('Waiting for first alive proxy (or fetcher to finish)...');
        const why = await firstProxyReady;
        if (why === 'proxy') {
            console.log(`✅ First proxy ready (${proxyPool.count} so far). Starting downloads — fetcher continues in background.`);
        } else {
            console.log(`⚠️  Fetcher finished with 0 working proxies. Falling back to ${cookieList.length} cookie source(s).`);
        }
    }

    console.log(`Workers: ${MAX_PARALLEL} parallel | Cookie/browser fallback(s): ${cookieList.length}`);
    // ────────────────────────────────────────────────────────────────────────

    // ── Session stats ────────────────────────────────────────────────────────
    const sessionStart = Date.now();
    let sessionBytes = 0;
    let sessionFailures = 0;
    // ────────────────────────────────────────────────────────────────────────

    await sendTelegram(
        `🚀 *youtube-to-bunny התחיל*\n` +
        `🕐 ${nowHHMM()}\n` +
        `📊 סה״כ בפלייליסט: ${total}\n` +
        `✅ כבר הועלו: ${completed}\n` +
        `⏳ נותרו לעיבוד: ${remaining}\n` +
        `🌐 פרוקסיים מוכנים: ${proxyPool.count}${proxyPool.done ? '' : ' (גדל תוך כדי)'} | ⚙️ עיבוד מקבילי: ${MAX_PARALLEL} | 🍪 cookies fallback: ${cookieList.length}`
    );

    // ── Worker pool: each worker pulls next video, then next proxy, processes it ──
    const todo = [];
    for (let i = 0; i < playlistData.length; i++) {
        const v = playlistData[i];
        if (v.youtubeUrl && v.youtubeUrl.includes('mediadelivery.net')) {
            console.log(`Skipping, already on Bunny: ${v.lessonTitle}`);
            continue;
        }
        todo.push({ video: v, globalIdx: i });
    }
    let cursor = 0;
    let stopReason = null;

    const processOneVideo = async (video, globalIdx) => {
        let result = null;
        let attempt = 0;

        // ONE Telegram message per video — edited throughout (waiting → switching →
        // download → upload → success/failure). Created here, passed via ctx.liveId
        // into processVideo so all updates land on the same message.
        const title = video.lessonTitle || video.videoId || 'Unknown';
        const overallPct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const startMsg = await sendTelegramMessage(
            `🎬 *[${globalIdx + 1}/${total}]* ${title}\n` +
            `📈 התקדמות: ${completed}/${total} (${overallPct}%)\n` +
            `🕐 ${nowHHMM()}\n\n` +
            `⏳ ממתין לפרוקסי זמין...`
        );
        const liveId = startMsg?.message_id || null;

        const tryWith = async (source) => {
            attempt++;
            if (attempt > 1) {
                // Different IP per proxy → 5s is enough. Cookies/browser keep 30s anti-bot pause.
                const isProxy = source.type === 'proxy';
                const waitSec = isProxy ? 5 : 30;
                const nextHeb = source.type === 'proxy' ? 'Proxy' : source.type === 'cookie' ? 'Cookie' : 'Browser';
                console.log(`\n🔄 [${globalIdx + 1}] Switching to ${source.type}:${source.label} (attempt ${attempt}) — waiting ${waitSec}s...`);
                if (liveId) {
                    await editTelegramMessage(liveId,
                        `🎬 *[${globalIdx + 1}/${total}]* ${title}\n` +
                        `🔄 *מחליף ל-${nextHeb}: ${source.label}*\n` +
                        `🔁 ניסיון ${attempt} — המתנה ${waitSec} שנ׳`
                    );
                }
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
            return await processVideo(video, buildYtdlpAuthArgs(source), {
                videoIndex: globalIdx + 1,
                total,
                completed,
                sourceType: source.type,
                sourceLabel: source.label,
                attempt,
                liveId
            });
        };

        // Phase 1: try proxies via the pool (each worker holds at most one)
        while (!stopReason) {
            const proxy = await proxyPool.checkout();
            if (!proxy) break;
            result = await tryWith(proxy);
            if (result.success) {
                proxyPool.return(proxy); // good — back into the pool for other workers
                break;
            }
            proxyPool.discard(proxy); // bad — drop forever
        }

        // Phase 2: cookies/browser fallback (only if proxy pool fully exhausted)
        if (!result?.success && !stopReason) {
            for (const source of cookieList) {
                result = await tryWith(source);
                if (result.success) break;
            }
        }

        if (result?.success) {
            completed++;
            sessionBytes += result.bytes || 0;
            console.log(`Progress: ${completed}/${total} videos completed.`);
            fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
        } else if (!stopReason) {
            // All sources exhausted for this video — flag the run to stop;
            // other in-flight workers finish their current video then exit.
            // Edit the per-video message to the final stop notice (one message per video).
            sessionFailures++;
            fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
            const failedTitle = video.lessonTitle || video.videoId || 'לא ידוע';
            const sessionDur = formatDuration(Math.round((Date.now() - sessionStart) / 1000));
            const stopText =
                `❌ *youtube-to-bunny נעצרה!*\n` +
                `🎬 [${globalIdx + 1}/${total}] ${failedTitle}\n` +
                `🔁 נכשל על כל הפרוקסיים שנוסו + ${cookieList.length} fallback(s)\n` +
                `📊 הושלמו ${completed}/${total} (${completed - startedAt} בסשן זה)\n` +
                `⏱️ זמן ריצה: ${sessionDur}\n` +
                `🕐 ${nowHHMM()}`;
            if (liveId) await editTelegramMessage(liveId, stopText);
            else await sendTelegram(stopText);
            stopReason = `Video failed on all auth sources: ${failedTitle}`;
        }
    };

    const worker = async (workerId) => {
        while (!stopReason) {
            const myIdx = cursor++;
            if (myIdx >= todo.length) return;
            const { video, globalIdx } = todo[myIdx];
            console.log(`\n[Worker ${workerId}] Picking up [${globalIdx + 1}/${total}]: ${video.lessonTitle || video.videoId}`);
            await processOneVideo(video, globalIdx);
        }
    };

    const workers = [];
    for (let w = 0; w < MAX_PARALLEL; w++) workers.push(worker(w + 1));
    await Promise.all(workers);

    if (stopReason) throw new Error(stopReason);

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
