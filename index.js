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
 * העלאת הוידאו ועדכון מטא-דאטה
 */
async function processVideo(videoObj) {
    const tmpFile = path.join(__dirname, `${videoObj.videoId}.mp4`);
    try {
        console.log(`\n--- מעבד: ${videoObj.lessonTitle} ---`);
        
        // 1. קבלת Collection ID לפי התת-קטגוריה
        const collectionId = await getOrCreateCollection(videoObj.subCategory);

        // 2. בניית מערך MetaTags מכל שאר הנתונים באובייקט
        const metaTags = Object.keys(videoObj).map(key => ({
            property: key,
            value: String(videoObj[key])
        }));

        // 3. יצירת רשומה בבאני עם הכותרת החדשה, הקולקשן והמטא-דאטה
        console.log(`🔑 יוצר רשומת וידאו...`);
        const createRes = await axios.post(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, 
            { 
                title: videoObj.lessonTitle, // שימוש בכותרת החדשה (lessonTitle)
                collectionId: collectionId || "",
                metaTags: metaTags
            }, 
            { headers }
        );
        const guid = createRes.data.guid;

      // 4. הורדה מיוטיוב לשרת גיטהאב (עם Cookies!)
        console.log(`📥 מוריד מיוטיוב (עם אימות)...`);
        execSync(`yt-dlp --cookies cookies.txt -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${tmpFile}" "${videoObj.youtubeUrl}"`);
       
     // 5. העלאה לבאני
        console.log(`⬆️ מעלה ל-Bunny...`);
        const fileStream = fs.createReadStream(tmpFile);
        await axios.put(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, fileStream, {
            headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity, maxBodyLength: Infinity
        });

        // 6. עדכון האובייקט - מחיקת יוטיוב והוספת קישור באני
        const bunnyStreamUrl = `https://iframe.mediadelivery.net/play/${BUNNY_LIBRARY_ID}/${guid}`;
        
        delete videoObj.youtubeUrl; // מוחק את הקישור הישן
        videoObj.bunnyUrl = bunnyStreamUrl; // מוסיף את הקישור החדש של באני סטרימינג
        videoObj.bunnyVideoId = guid; // שומר גם את המזהה הייחודי למקרה שתצטרך API עתידי

        console.log(`✅ הושלם: ${videoObj.lessonTitle}`);
        return videoObj;

    } catch (e) {
        console.error(`❌ נכשל בוידאו ${videoObj.lessonTitle}:`, e.message);
        return videoObj; // נחזיר את האובייקט המקורי כדי שלא יעלם מה-JSON במקרה של שגיאה
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

    // מעבר סדרתי (חשוב לא לעשות במקביל כדי לא לחרוג מהגבלות API)
    for (const video of playlistData) {
        // אם כבר יש לו bunnyUrl, נדלג (מאפשר להריץ שוב אם משהו נכשל באמצע)
        if (video.bunnyUrl) {
            console.log(`⏭️ מדלג, כבר עבר ל-Bunny: ${video.lessonTitle}`);
            updatedPlaylist.push(video);
            continue;
        }
        const updatedVideo = await processVideo(video);
        updatedPlaylist.push(updatedVideo);
    }

    // שמירת ה-JSON המעודכן בחזרה לקובץ
    fs.writeFileSync(filePath, JSON.stringify(updatedPlaylist, null, 2));
    console.log('\n✨ הסנכרון הסתיים והקובץ העודכן נשמר בהצלחה!');
}

run();