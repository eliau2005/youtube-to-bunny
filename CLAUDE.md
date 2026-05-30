# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A YouTube → Bunny.net media pipeline for Hebrew Torah lessons, operated live over Telegram.
For each entry in `playlist.json` it: downloads from YouTube → uploads to Bunny **Stream** (video)
→ extracts a small MP3 → uploads to Bunny **Storage** (audio) → writes the resulting URLs back
into `playlist.json`. There are only two source files and no build step.

## Commands

```bash
npm install            # axios + dotenv are the only deps
node bot-listener.js   # (or `npm run bot`) start the Telegram control bot — the normal entry point
node index.js          # run the pipeline once directly (bot-listener spawns this for you)
```

There are no tests, linter, or build. `yt-dlp`, `aria2c`, `ffmpeg`, and `ffprobe` must be on PATH.

## Required environment (.env)

`index.js` aborts at startup if any Bunny Storage var is missing:
- `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY` — Bunny **Stream** (video) library
- `BUNNY_STORAGE_API_KEY`, `BUNNY_STORAGE_ZONE_NAME`, `BUNNY_PULL_ZONE_URL` — Bunny **Storage** (MP3s)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — Telegram is silently disabled if absent; bot-listener exits without them

## Architecture

### Two processes, file-based IPC
`bot-listener.js` is the supervisor: it long-polls Telegram, handles commands/uploads, and
`spawn`s `index.js` as a child (stdio inherited). They share **no memory** — all coordination
is through sentinel/state files in the project root, and both files redefine the same readers
(`readAria2cPreset`, `readParallelPreset`, `readPlayerClientPreset`, `isNoWaitMode`,
`controlButtons`, active-buttons helpers). **If you change a preset name, set of valid values,
default, or a control-button layout, you must edit BOTH files** or they silently diverge.

Coordination files (all in project root, all transient):
- `.no-wait-mode` — presence = 10s inter-video delay instead of random 2–6 min
- `.active-buttons-msg-id` — the one Telegram message currently showing control buttons (kept unique to avoid chat clutter)
- `.aria2c-preset`, `.player-client-preset`, `.parallel-preset` — speed knobs written by `/settings`, re-read per video so changes apply mid-run without restart
- `.choice-<requestId>.json` — bot-listener writes the user's quality choice here; `index.js` polls for it
- `.playlist-pending.json` — staged uploaded playlist awaiting overwrite confirmation
- `cookies1.txt` / `cookies2.txt` / `cookies3.txt` (or plain `cookies.txt`) — YouTube auth

### Per-entry pipeline (`processVideo` in index.js)
`classifyMode(videoObj)` decides the branch from the two URL fields:
- **`skip`** — invalid/empty `youtubeUrl`, OR already on `mediadelivery.net` AND has `audioUrl` (fully done)
- **`audio-only`** — already on Bunny Stream but missing `audioUrl`; re-download audio from Bunny and back-fill the MP3 (no YouTube, no cookies)
- **`full`** — a real YouTube URL; run the whole download → Stream → MP3 → Storage chain

`youtubeUrl` is **overwritten in place** with the Bunny Stream iframe URL after a successful full
upload, which is what flips an entry from `full` to `skip`/`audio-only` on the next run. This is
the resume mechanism — re-running picks up where it left off.

MP3s are organized in Storage under `audio/{subCategory}/{slug}.mp3` (mirrors the Stream
collection layout), falling back to `audio/{slug}.mp3` when `subCategory` is empty.

### Concurrency model (the subtle part)
- **`audio-only` entries run in parallel** via `audioPool` (a `Set` of in-flight promises), capped by `.parallel-preset` — Bunny CDN tolerates concurrency and there are no cookies to protect.
- **`full` entries run strictly sequentially.** Before any full entry the code calls `drainAudioPool()` so YouTube isn't hit concurrently under one cookie pool (which accelerates bot detection).
- Playlist writes are serialized through a `writeChain` promise so parallel audio entries don't trample each other's snapshots.
- Inter-video cooldown (`maybeInterVideoWait`) fires **only when the next pending entry is `full`** — audio→audio transitions skip it.

### Cookie rotation
`buildAuthSources()` collects `cookies{1,2,3}.txt`. Rotation is **sticky**: the active source
stays on whatever last worked and only advances to the next file when the current one fails for
an entry. A full entry that fails on *all* cookie files is fatal — the run throws and stops.
Below-1080p detection prompts the user (10s window) to rotate cookies or continue.

### Telegram UX conventions
- One live message **per video**, edited in place across phases/attempts (not a stream of new messages).
- All user-facing strings are **Hebrew**; keep that when editing messages.
- Edits are rate-limited: a shared client-side 429 backoff (`tgBackoffUntil`) plus a per-video
  throttle that scales with pool size to stay under Telegram's ~1 msg/s per-chat limit.
- bot-listener's `tgRequest` adds 429-aware retry on top for its own one-off sends.

### GitHub Actions (`.github/workflows/sync.yml`)
A separate, manually-dispatched (`workflow_dispatch`) path that installs yt-dlp/ffmpeg, runs
`node index.js`, and commits the updated `playlist.json`. It uses only `BUNNY_LIBRARY_ID` /
`BUNNY_API_KEY` (Stream) — it predates the Storage/MP3 + Telegram features and will abort on the
missing Storage env vars. Treat the Telegram-driven local run as the source of truth.

## Playlist entry shape
Array of objects in `playlist.json`. Key fields: `videoId`, `youtubeUrl` (mutated to the Stream
URL after upload), `audioUrl` (added after MP3 upload), `lessonTitle`, `subCategory` (→ Stream
collection name + Storage subfolder), `slug` (→ MP3 filename). The temp-file stem falls back
`videoId → Bunny GUID → slug → entry-N`; `cleanupStemFiles` sweeps all `{stem}.*` debris in the
`finally` block to clear yt-dlp fragment leftovers. `playlist(mezuza).json` /
`playlist(tzimchonot).json` are alternate datasets, not read at runtime.
