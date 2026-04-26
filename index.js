const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { BUNNY_LIBRARY_ID, BUNNY_API_KEY } = process.env;

const headers = {
    'AccessKey': BUNNY_API_KEY,
    'Content-Type': 'application/json'
};

// אובייקט לשמירת ה-Collections שכבר קיימים כדי לא ליצור כפילויות
let collectionsMap = {};

/**
 * משיכת כל ה-Collections הקיימים בבאני
 */
async function loadCollections() {
    try {
        const res = await axios.get(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections?itemsPerPage=100`, { headers });
        res.data.items.forEach(c => {
            collectionsMap[c.name] = c.guid;
        });
    } catch (e) {
        console.error("שגיאה בטעינת קולקשנים:", e.message);
    }
}

/**
 * קבלת מזהה קולקשן (או יצירה של חדש אם לא קיים)
 */
async function getOrCreateCollection(name) {
    if (!name) return null;
    if (collectionsMap[name]) return collectionsMap[name]; // קיים

    console.log(`📁 יוצר קולקשן חדש בבאני: ${name}`);
    try {
        const res = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections`,
            { name },
            { headers }
        );
        collectionsMap[name] = res.data.guid;
        return res.data.guid;
    } catch (e) {
        console.error(`❌ שגיאה ביצירת קולקשן ${name}:`, e.message);
        return null;
    }
}

/**
 * הורדה מיוטיוב, העלאה לבאני ועדכון מטא-דאטה
 */
async function processVideo(videoObj) {
    const tmpFile = path.join(__dirname, `${videoObj.videoId}.mp4`);
    try {
        console.log(`\n--- מעבד: ${videoObj.lessonTitle} ---`);

        // 1. הורדה מיוטיוב באיכות המקסימלית (1080p) והמרה ל-MP4
        // אנחנו עושים זאת קודם כדי לא ליצור רשומות ריקות בבאני אם ההורדה נכשלת (למשל עוגיות שפגו)
        console.log(`📥 מוריד מיוטיוב באיכות מקסימלית...`);
        execSync(`yt-dlp --extractor-args "youtube:player_client=android_vr" --js-runtimes node -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${tmpFile}" "${videoObj.youtubeUrl}"`);

        // 2. קבלת Collection ID לפי התת-קטגוריה
        const collectionId = await getOrCreateCollection(videoObj.subCategory);

        // 3. בניית מערך MetaTags מכל שאר הנתונים באובייקט
        const metaTags = Object.keys(videoObj).map(key => ({
            property: key,
            value: String(videoObj[key])
        }));

        // 4. יצירת רשומה בבאני עם הכותרת החדשה, הקולקשן והמטא-דאטה
        console.log(`🔑 יוצר רשומת וידאו...`);
        const createRes = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
            {
                title: videoObj.lessonTitle,
                collectionId: collectionId || "",
                metaTags: metaTags
            },
            { headers }
        );
        const guid = createRes.data.guid;

        // 5. העלאה לבאני
        console.log(`⬆️ מעלה ל-Bunny...`);
        const fileStream = fs.createReadStream(tmpFile);
        await axios.put(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, fileStream, {
            headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity, maxBodyLength: Infinity
        });

        // 6. עדכון האובייקט - שומר על המבנה הקיים ורק מחליף את הערך של ה-URL
        const bunnyStreamUrl = `https://iframe.mediadelivery.net/play/${BUNNY_LIBRARY_ID}/${guid}`;
        videoObj.youtubeUrl = bunnyStreamUrl;

        console.log(`✅ הושלם: ${videoObj.lessonTitle}`);
        return { success: true, videoObj };

    } catch (e) {
        console.error(`❌ נכשל בוידאו ${videoObj.lessonTitle}:`, e.message);
        return { success: false, videoObj };
    } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

/**
 * הפונקציה הראשית שקוראת וכותבת את הקובץ
 */
async function run() {
    // טעינת הקובץ המקומי
    const filePath = path.join(__dirname, 'playlist.json');
    if (!fs.existsSync(filePath)) {
        return console.error("❌ לא נמצא קובץ playlist.json");
    }

    const playlistData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`נמצאו ${playlistData.length} סרטונים בקובץ.`);

    await loadCollections(); // טעינה ראשונית של כל הקולקשנים הקיימים בבאני

    let updatedPlaylist = [];

    // מעבר סדרתי
    for (let i = 0; i < playlistData.length; i++) {
        const video = playlistData[i];

        // בודק אם ה-URL הנוכחי הוא כבר של באני כדי לדלג עליו
        if (video.youtubeUrl && video.youtubeUrl.includes('mediadelivery.net')) {
            console.log(`⏭️ מדלג, כבר עבר ל-Bunny: ${video.lessonTitle}`);
            updatedPlaylist.push(video);
            continue;
        }

        const result = await processVideo(video);
        updatedPlaylist.push(result.videoObj);

        if (!result.success) {
            console.log("🚨 זוהתה שגיאה קריטית (כנראה חסימת עוגיות מיוטיוב) - עוצר הורדות נוספות ועובר לשמירת הקובץ.");
            // נוסיף את שאר הסרטונים שנשארו ללא שינוי
            const remaining = playlistData.slice(i + 1);
            updatedPlaylist.push(...remaining);
            break;
        }
    }

    // שמירת ה-JSON המעודכן בחזרה לקובץ
    fs.writeFileSync(filePath, JSON.stringify(updatedPlaylist, null, 2));
    console.log('\n✨ הסנכרון הסתיים והקובץ המעודכן נשמר בהצלחה!');
}

run();