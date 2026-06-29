const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { google } = require("googleapis");
const multer = require("multer");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Persistent audio storage dir
const AUDIO_DIR = path.join(os.tmpdir(), "yt-audio-store");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: AUDIO_DIR,
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max per file

// Serve uploaded audio files publicly
app.use("/audio", express.static(AUDIO_DIR));

app.get("/health", (_, res) => res.json({ status: "ok" }));

// Upload one or more audio files — returns public URLs
app.post("/upload-audio", upload.array("files", 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No files" });
  const base = `${req.protocol}://${req.get("host")}`;
  const urls = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    url: `${base}/audio/${f.filename}`,
  }));
  res.json({ success: true, files: urls });
});

app.post("/compile-and-upload", async (req, res) => {
  const { audioUrls, backgroundImageUrl, title, description, tags, scheduledFor, channelSlug, videoId, callbackUrl, workerSecret } = req.body;

  res.json({ accepted: true, message: "Job started" });

  processJob({ audioUrls, backgroundImageUrl, title, description, tags, scheduledFor, channelSlug, videoId, callbackUrl, workerSecret })
    .catch(err => {
      console.error("Job failed:", err.message);
      if (callbackUrl) fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId, error: err.message, workerSecret }) }).catch(() => {});
    });
});

async function processJob({ audioUrls, backgroundImageUrl, title, description, tags, scheduledFor, channelSlug, videoId, callbackUrl, workerSecret }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));
  console.log(`[${videoId}] Starting compilation of ${audioUrls.length} audio files`);

  try {
    // Download audio files
    const audioPaths = [];
    for (let i = 0; i < audioUrls.length; i++) {
      const audioPath = path.join(tmpDir, `audio_${i}.mp3`);
      const resp = await axios.get(audioUrls[i], { responseType: "stream", timeout: 60000 });
      await streamToFile(resp.data, audioPath);
      audioPaths.push(audioPath);
      console.log(`[${videoId}] Downloaded audio ${i + 1}/${audioUrls.length}`);
    }

    // Download background image
    const imgPath = path.join(tmpDir, "background.jpg");
    if (backgroundImageUrl) {
      const imgResp = await axios.get(backgroundImageUrl, { responseType: "stream", timeout: 30000 });
      await streamToFile(imgResp.data, imgPath);
    } else {
      // Create a simple black image
      await new Promise((resolve, reject) => {
        ffmpeg().input("color=black:size=1280x720:rate=1").inputOptions(["-f", "lavfi"]).outputOptions(["-t", "1"]).output(imgPath).on("end", resolve).on("error", reject).run();
      });
    }

    // Create concat file for audio
    const concatPath = path.join(tmpDir, "concat.txt");
    const concatContent = audioPaths.map(p => `file '${p}'`).join("\n");
    fs.writeFileSync(concatPath, concatContent);

    // Merge audio files first
    const mergedAudioPath = path.join(tmpDir, "merged.mp3");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .audioCodec("libmp3lame")
        .output(mergedAudioPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    console.log(`[${videoId}] Audio merged`);

    // Create video from image + merged audio
    const videoPath = path.join(tmpDir, "output.mp4");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(imgPath)
        .inputOptions(["-loop", "1"])
        .input(mergedAudioPath)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions(["-tune", "stillimage", "-pix_fmt", "yuv420p", "-shortest", "-movflags", "+faststart"])
        .output(videoPath)
        .on("progress", p => { if (p.percent) console.log(`[${videoId}] Encoding: ${Math.round(p.percent)}%`); })
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    console.log(`[${videoId}] Video compiled`);

    // Upload to YouTube
    const youtubeVideoId = await uploadToYouTube({ videoPath, title, description, tags, scheduledFor, channelSlug });
    console.log(`[${videoId}] Uploaded to YouTube: ${youtubeVideoId}`);

    if (callbackUrl) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, youtubeVideoId, youtubeUrl: `https://youtu.be/${youtubeVideoId}`, success: true, workerSecret })
      });
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function uploadToYouTube({ videoPath, title, description, tags, scheduledFor, channelSlug }) {
  const credsMap = {
    "city-jazz": { clientId: process.env.YOUTUBE_CLIENT_ID, clientSecret: process.env.YOUTUBE_CLIENT_SECRET, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN },
    "lofi-focus": { clientId: process.env.YOUTUBE_CLIENT_ID_LOFI, clientSecret: process.env.YOUTUBE_CLIENT_SECRET_LOFI, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN_LOFI },
    "luxury-deep-house": { clientId: process.env.YOUTUBE_CLIENT_ID_HOUSE, clientSecret: process.env.YOUTUBE_CLIENT_SECRET_HOUSE, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN_HOUSE },
    "chillout-lounge": { clientId: process.env.YOUTUBE_CLIENT_ID_CHILL, clientSecret: process.env.YOUTUBE_CLIENT_SECRET_CHILL, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN_CHILL },
  };
  const creds = credsMap[channelSlug];
  if (!creds || !creds.clientId) throw new Error(`No YouTube credentials for ${channelSlug}`);

  const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  auth.setCredentials({ refresh_token: creds.refreshToken });
  const youtube = google.youtube({ version: "v3", auth });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, tags, categoryId: "10", defaultLanguage: "en" },
      status: { privacyStatus: scheduledFor ? "private" : "public", publishAt: scheduledFor ? new Date(scheduledFor).toISOString() : undefined, selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(videoPath) }
  });

  return response.data.id;
}

function streamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    stream.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Video worker running on port ${PORT}`));