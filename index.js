require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { BUNNY_LIBRARY_ID, BUNNY_API_KEY } = process.env;

const headers = {
    'AccessKey': BUNNY_API_KEY,
    'Content-Type': 'application/json'
};

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

function downloadFromYoutube(youtubeUrl, outputFile) {
    return new Promise((resolve, reject) => {
        const args = [
            '--downloader', 'aria2c',
            '--downloader-args', 'aria2c:-x 4 -s 4 -j 4 -k 5M --console-log-level=info --summary-interval=1',
            '--sleep-requests', '2',
            '--extractor-args', 'youtube:player_client=web,web_embedded',
            '--js-runtimes', 'node',
            '-f', 'bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
            '--merge-output-format', 'mp4',
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
                }
            } else if (line.startsWith('[#')) {
                const pctMatch = line.match(/\((\d+(?:\.\d+)?)%\)/);
                if (pctMatch) {
                    const dlMatch = line.match(/DL:(\S+?)(?=[\s\]])/);
                    const etaMatch = line.match(/ETA:(\S+?)(?=[\s\]])/);
                    const percent = parseFloat(pctMatch[1]);
                    const speed = dlMatch ? dlMatch[1] + '/s' : 'N/A';
                    const eta = etaMatch ? etaMatch[1] : '--:--';
                    renderProgressBar('Downloading', percent, speed, eta);
                    activeBar = true;
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

function uploadToBunny(guid, filePath) {
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

async function processVideo(videoObj) {
    const tmpFile = path.join(__dirname, `${videoObj.videoId}.mp4`);
    try {
        console.log(`\n--- Processing: ${videoObj.lessonTitle} ---`);

        console.log('Downloading from YouTube at maximum quality...');
        await downloadFromYoutube(videoObj.youtubeUrl, tmpFile);

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

        console.log('Uploading to Bunny...');
        await uploadToBunny(guid, tmpFile);

        const bunnyStreamUrl = `https://iframe.mediadelivery.net/play/${BUNNY_LIBRARY_ID}/${guid}`;
        videoObj.youtubeUrl = bunnyStreamUrl;

        console.log(`Done: ${videoObj.lessonTitle}`);
        return { success: true, videoObj };

    } catch (e) {
        console.error(`Failed on video ${videoObj.lessonTitle}:`, e.message);
        if (e.response) {
            console.error('  status:', e.response.status);
            console.error('  body:', JSON.stringify(e.response.data));
        }
        return { success: false, videoObj };
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
    console.log(`Found ${playlistData.length} videos in the file.`);

    await loadCollections();

    for (let i = 0; i < playlistData.length; i++) {
        const video = playlistData[i];

        if (video.youtubeUrl && video.youtubeUrl.includes('mediadelivery.net')) {
            console.log(`Skipping, already on Bunny: ${video.lessonTitle}`);
            continue;
        }

        const result = await processVideo(video);

        if (result.success) {
            // Save progress after each success
            fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));

            if (i < playlistData.length - 1) {
                console.log("⏳ waiting 2.5 min to not block...");
                await new Promise(resolve => setTimeout(resolve, 150000));
            }
        } else {
            console.log('Critical error detected (likely YouTube cookie block) - stopping further downloads and saving file.');
            break;
        }
    }

    fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
    console.log('\nSync complete and updated file saved successfully!');
}

run();
