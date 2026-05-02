// Fetches free HTTP proxies from multiple public sources, optionally tests each
// for liveness, and writes the working ones to proxies.txt (one per line).
//
// CLI usage:
//   node fetch-free-proxies.js              # fetch + test, write proxies.txt
//   node fetch-free-proxies.js --no-test    # skip liveness test (faster, more proxies)
//   node fetch-free-proxies.js --limit 50   # cap output to 50 proxies
//   node fetch-free-proxies.js --timeout 8  # per-proxy test timeout in seconds (default 5)
//
// Programmatic usage (auto-fetch from index.js):
//   const { fetchAndWriteProxies } = require('./fetch-free-proxies');
//   await fetchAndWriteProxies({ limit: 100, timeoutMs: 4000, concurrency: 200 });

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OUT_FILE = path.join(__dirname, 'proxies.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── HTTP fetch helper (supports redirects, custom UA) ───────────────────────
function fetchUrl(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/plain,*/*', ...(opts.headers || {}) },
            timeout: opts.timeout || 15000
        }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                return fetchUrl(res.headers.location, opts).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', d => data += d.toString());
            res.on('end', () => resolve(data));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });
}

// ─── Proxy list sources ──────────────────────────────────────────────────────
const sources = [
    {
        name: 'proxy5.net',
        fetch: async () => {
            // Cloudflare-protected; loaded via AJAX requiring a cleared browser session.
            // We still attempt — if your IP bypasses CF, great; otherwise it silently fails.
            const html = await fetchUrl('https://proxy5.net/free-proxy', {
                headers: { 'Accept': 'text/html,application/xhtml+xml' }
            });
            return parseIpPort(html);
        }
    },
    {
        name: 'proxyscrape',
        fetch: async () => {
            const url = 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=protocolipport&format=text&timeout=5000';
            const text = await fetchUrl(url);
            return text.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('http'));
        }
    },
    {
        name: 'TheSpeedX/PROXY-List (http)',
        fetch: async () => {
            const text = await fetchUrl('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt');
            return text.split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
                .map(l => `http://${l}`);
        }
    },
    {
        name: 'TheSpeedX/PROXY-List (socks5)',
        fetch: async () => {
            const text = await fetchUrl('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt');
            return text.split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
                .map(l => `socks5://${l}`);
        }
    },
    {
        name: 'clarketm/proxy-list',
        fetch: async () => {
            const text = await fetchUrl('https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt');
            return text.split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
                .map(l => `http://${l}`);
        }
    }
];

function parseIpPort(text) {
    const matches = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[:\s]+\d{2,5}\b/g) || [];
    return matches.map(m => `http://${m.replace(/\s+/, ':')}`);
}

// ─── Proxy liveness test ─────────────────────────────────────────────────────
// HTTP-only test: HEAD to gstatic's tiny 204 endpoint via the proxy.
// SOCKS proxies pass through untested (no agent dep available).
function testProxy(proxyUrl, timeoutMs) {
    return new Promise((resolve) => {
        if (proxyUrl.startsWith('socks')) return resolve(true);
        let host, port;
        try {
            const u = new URL(proxyUrl);
            host = u.hostname;
            port = parseInt(u.port, 10);
            if (!host || !port) return resolve(false);
        } catch {
            return resolve(false);
        }
        const req = http.request({
            host, port, method: 'HEAD',
            path: 'http://www.gstatic.com/generate_204',
            headers: { Host: 'www.gstatic.com', 'User-Agent': UA },
            timeout: timeoutMs
        }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function testInBatches(proxies, timeoutMs, concurrency, log) {
    const alive = [];
    let tested = 0;
    const total = proxies.length;
    const writeStatus = () => {
        if (process.stdout.isTTY && log === console.log) {
            process.stdout.write(`\r  Tested ${tested}/${total} | alive: ${alive.length}    `);
        }
    };
    for (let i = 0; i < proxies.length; i += concurrency) {
        const batch = proxies.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (p) => {
            const ok = await testProxy(p, timeoutMs);
            tested++;
            writeStatus();
            return ok ? p : null;
        }));
        for (const p of results) if (p) alive.push(p);
    }
    if (process.stdout.isTTY && log === console.log) process.stdout.write('\n');
    return alive;
}

// ─── Main exported function ──────────────────────────────────────────────────
async function fetchAndWriteProxies(opts = {}) {
    const noTest = !!opts.noTest;
    const limit = opts.limit || 0;
    const timeoutMs = opts.timeoutMs || 5000;
    const concurrency = opts.concurrency || 100;
    const log = opts.log || console.log;

    log('Fetching free proxies from public sources...');
    const all = new Set();
    const perSource = {};
    for (const src of sources) {
        try {
            const list = await src.fetch();
            list.forEach(p => all.add(p));
            perSource[src.name] = list.length;
            log(`  ${src.name.padEnd(32)} ${list.length} proxies`);
        } catch (e) {
            perSource[src.name] = 0;
            log(`  ${src.name.padEnd(32)} failed (${e.message})`);
        }
    }

    const unique = [...all];
    log(`Total unique: ${unique.length}`);

    let final;
    if (noTest) {
        log('Skipping liveness test.');
        final = unique;
    } else {
        log(`Testing ${unique.length} proxies (${timeoutMs / 1000}s timeout, ${concurrency} parallel)...`);
        final = await testInBatches(unique, timeoutMs, concurrency, log);
        log(`Alive: ${final.length}/${unique.length}`);
    }

    if (limit > 0 && final.length > limit) {
        log(`Capping to first ${limit}.`);
        final = final.slice(0, limit);
    }

    if (final.length === 0) {
        log('No working proxies found. proxies.txt left unchanged.');
        return { count: 0, perSource, written: false };
    }

    const header = `# Generated by fetch-free-proxies.js on ${new Date().toISOString()}\n` +
                   `# ${final.length} proxies (${noTest ? 'untested' : 'tested alive'})\n`;
    fs.writeFileSync(OUT_FILE, header + final.join('\n') + '\n');
    log(`Wrote ${final.length} proxies → ${OUT_FILE}`);
    return { count: final.length, perSource, written: true };
}

module.exports = { fetchAndWriteProxies };

// ─── CLI entry point ─────────────────────────────────────────────────────────
if (require.main === module) {
    const args = process.argv.slice(2);
    const argFlag = (name) => args.includes(name);
    const argVal = (name, def) => {
        const i = args.indexOf(name);
        return i >= 0 && args[i + 1] ? args[i + 1] : def;
    };
    fetchAndWriteProxies({
        noTest: argFlag('--no-test'),
        limit: parseInt(argVal('--limit', '0'), 10),
        timeoutMs: Math.max(1, parseInt(argVal('--timeout', '5'), 10)) * 1000,
        concurrency: 100
    }).then(r => {
        if (r.count === 0) process.exit(1);
    }).catch(e => {
        console.error('Fatal:', e.message);
        process.exit(1);
    });
}
