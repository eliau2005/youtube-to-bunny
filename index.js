const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// משיכת סודות מהסביבה (GitHub Secrets)
const {
    YOUTUBE_API_KEY,
    BUNNY_LIBRARY_ID,
    BUNNY_API_KEY,
    PLAYLIST_ID
} = process.env;

async function getAllVideos(playlistId) {
    let allVideos = [];
    let nextPageToken = '';
    try {
        do {
            const url = `https://www.googleapis.com/youtube/v3/playlistItems`;
            const res = await axios.get(url, {
                params: { part: 'snippet', maxResults: 50, playlistId, key: YOUTUBE_API_KEY, pageToken: nextPageToken }
            });
            allVideos.push(...res.data.items.map(i => ({ id: i.snippet.resourceId.videoId, title: i.snippet.title })));
            nextPageToken = res.data.nextPageToken || '';
        } while (nextPageToken);
        return allVideos;
    } catch (e) { console.error("Error fetching playlist", e.message); return []; }
}

async function uploadToBunny(video) {
    const tmpFile = path.join(__dirname, `${video.id}.mp4`);
    try {
        console.log(`\n--- Processing: ${video.title} ---`);
        
        // הורדה בשרת של GitHub (מהירות פסיכית)
        const cookiesArg = fs.existsSync('cookies.txt') ? '--cookies cookies.txt' : '';
        execSync(`yt-dlp --js-runtimes nodejs ${cookiesArg} -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${tmpFile}" "https://www.youtube.com/watch?v=${video.id}"`);

        // יצירת רשומה בבאני
        const createRes = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, 
            { title: video.title }, 
            { headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/json' } }
        );
        const guid = createRes.data.guid;

        // העלאה לבאני
        const fileStream = fs.createReadStream(tmpFile);
        await axios.put(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, fileStream, {
            headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity, maxBodyLength: Infinity
        });

        console.log(`✅ Success: ${video.title}`);
    } catch (e) {
        console.error(`❌ Failed: ${video.title}`, e.message);
    } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

async function run() {
    const videos = await getAllVideos(PLAYLIST_ID);
    console.log(`Found ${videos.length} videos. starting...`);
    for (const v of videos) {
        await uploadToBunny(v);
    }
}

run();