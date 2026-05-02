// Fetches free HTTP proxies from multiple public sources, optionally tests each
// for liveness, and writes the working ones to proxies.txt (one per line). Run
// before a youtube-to-bunny session to refresh the rotation pool.
//
//   node fetch-free-proxies.js              # fetch + test, write proxies.txt
//   node fetch-free-proxies.js --no-test    # skip liveness test (faster, more proxies)
//   node fetch-free-proxies.js --limit 50   # cap output to 50 proxies
//   node fetch-free-proxies.js --timeout 8  # per-proxy test timeout in seconds (default 5)

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const NO_TEST = args.includes('--no-test');
const LIMIT = (() => {
    const i = args.indexOf('--limit');
    return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 0;
})();
const TEST_TIMEOUT_MS = (() => {
    const i = args.indexOf('--timeout');
    const sec = i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 5;
    return Math.max(1, sec) * 1000;
})();
const TEST_CONCURRENCY = 100;
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
// Each source returns an array of proxy URLs ("http://IP:PORT" or "socks5://IP:PORT").
const sources = [
    {
        name: 'proxy5.net',
        fetch: async () => {
            // proxy5.net is Cloudflare-protected, the proxy table is loaded via AJAX
            // that requires a CF-cleared browser session. We still attempt — if your
            // IP happens to bypass CF, great; otherwise the source silently fails.
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
// HTTP-only test: send a HEAD to gstatic's tiny 204 endpoint via the proxy.
// SOCKS proxies are not testable without an extra dep, so we pass them through.
function testProxy(proxyUrl) {
    return new Promise((resolve) => {
        if (proxyUrl.startsWith('socks')) return resolve(true); // can't test, assume ok
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
            timeout: TEST_TIMEOUT_MS
        }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function testInBatches(proxies) {
    const alive = [];
    let tested = 0;
    const total = proxies.length;
    const writeStatus = () => {
        if (process.stdout.isTTY) {
            process.stdout.write(`\r  Tested ${tested}/${total} | alive: ${alive.length}    `);
        }
    };
    for (let i = 0; i < proxies.length; i += TEST_CONCURRENCY) {
        const batch = proxies.slice(i, i + TEST_CONCURRENCY);
        const results = await Promise.all(batch.map(async (p) => {
            const ok = await testProxy(p);
            tested++;
            writeStatus();
            return ok ? p : null;
        }));
        for (const p of results) if (p) alive.push(p);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
    return alive;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
    console.log('Fetching free proxies from public sources...\n');
    const all = new Set();
    for (const src of sources) {
        process.stdout.write(`  ${src.name.padEnd(32)} `);
        try {
            const list = await src.fetch();
            list.forEach(p => all.add(p));
            console.log(`${list.length} proxies`);
        } catch (e) {
            console.log(`failed (${e.message})`);
        }
    }

    const unique = [...all];
    console.log(`\nTotal unique: ${unique.length}`);

    let final;
    if (NO_TEST) {
        console.log('Skipping liveness test (--no-test).');
        final = unique;
    } else {
        console.log(`Testing ${unique.length} proxies (${TEST_TIMEOUT_MS / 1000}s timeout, ${TEST_CONCURRENCY} parallel)...`);
        final = await testInBatches(unique);
        console.log(`Alive: ${final.length}/${unique.length}`);
    }

    if (LIMIT > 0 && final.length > LIMIT) {
        console.log(`Capping to first ${LIMIT} per --limit.`);
        final = final.slice(0, LIMIT);
    }

    if (final.length === 0) {
        console.log('\nNo proxies to write. proxies.txt left unchanged.');
        process.exit(1);
    }

    const header = `# Generated by fetch-free-proxies.js on ${new Date().toISOString()}\n` +
                   `# ${final.length} proxies (${NO_TEST ? 'untested' : 'tested alive'})\n`;
    fs.writeFileSync(OUT_FILE, header + final.join('\n') + '\n');
    console.log(`\nWrote ${final.length} proxies → ${OUT_FILE}`);
})().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
