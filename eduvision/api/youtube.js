// api/youtube.js
// Vercel Serverless Function — YouTube Data API proxy
// YOUTUBE_API_KEY is stored in Vercel environment variables, never in the browser.

const https = require("https");

// ─── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ─── Helper: HTTPS GET returning parsed JSON ──────────────────────────────────
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          reject(new Error("JSON parse failed: " + e.message + " | raw: " + raw.slice(0, 200)));
        }
      });
    });
    req.on("error", (e) => reject(new Error("HTTPS error: " + e.message)));
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

// ─── Search query builder ─────────────────────────────────────────────────────
function buildQuery(topic, lang) {
  if (lang === "hi") {
    return topic + " hindi NCERT explanation";
  }
  return topic + " explained educational for students";
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const topic = req.query.topic;
  const lang  = req.query.lang || "en";

  if (!topic) {
    return res.status(400).json({ error: "Missing topic parameter" });
  }

  // Serve from cache if available
  const cacheKey = topic.toLowerCase() + "__" + lang;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
    return res.status(200).json({ videos: cached.videos, source: "cache" });
  }

  // Get API key
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set in environment variables");
    return res.status(500).json({ error: "YouTube API key not configured on server." });
  }

  const query = buildQuery(topic, lang);
  console.log("Searching YouTube for:", query, "| lang:", lang);

  // Build URL manually to avoid any URLSearchParams issues
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const encodedQuery  = encodeURIComponent(query);
  const encodedDate   = encodeURIComponent(thirtyDaysAgo);
  const relLang       = lang === "hi" ? "hi" : "en";

  const url = "https://www.googleapis.com/youtube/v3/search"
    + "?part=snippet"
    + "&q=" + encodedQuery
    + "&type=video"
    + "&maxResults=5"
    + "&order=relevance"
    + "&videoEmbeddable=true"
    + "&safeSearch=strict"
    + "&videoDuration=medium"
    + "&publishedAfter=" + encodedDate
    + "&relevanceLanguage=" + relLang
    + "&key=" + apiKey;

  try {
    console.log("Calling YouTube API...");
    const result = await httpsGetJSON(url);
    console.log("YouTube API response status:", result.status);

    if (result.status !== 200) {
      const errMsg = (result.body && result.body.error && result.body.error.message)
        ? result.body.error.message
        : "YouTube API returned status " + result.status;
      console.error("YouTube API error:", errMsg);
      throw new Error(errMsg);
    }

    const items = result.body.items || [];
    console.log("Videos found:", items.length);

    if (items.length === 0) {
      return res.status(404).json({ error: "No videos found for: " + topic });
    }

    const videos = items.map(function(item) {
      return {
        id:      item.id.videoId,
        title:   item.snippet.title,
        channel: item.snippet.channelTitle,
        thumb:   (item.snippet.thumbnails && item.snippet.thumbnails.medium)
                   ? item.snippet.thumbnails.medium.url
                   : "https://img.youtube.com/vi/" + item.id.videoId + "/mqdefault.jpg",
      };
    });

    cache.set(cacheKey, { videos: videos, cachedAt: Date.now() });
    return res.status(200).json({ videos: videos, source: "api" });

  } catch (err) {
    console.error("YouTube handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
