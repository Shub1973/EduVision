// api/youtube.js
// Vercel Serverless Function — YouTube Data API proxy
// YOUTUBE_API_KEY is stored in Vercel environment variables, never in the browser.

const https = require("https");

// ─── In-memory cache to save API quota ───────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ─── Helper: HTTPS GET returning parsed JSON ──────────────────────────────────
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          resolve({ status: res.statusCode, ok: res.statusCode < 400, body });
        } catch(e) {
          reject(new Error("Failed to parse YouTube response: " + e.message));
        }
      });
    }).on("error", reject);
  });
}

// ─── Search query builder ─────────────────────────────────────────────────────
function buildQuery(topic, lang) {
  if (lang === "hi") {
    return `${topic} हिंदी में NCERT class explanation`;
  }
  return `${topic} explained educational for students`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { topic, lang = "en" } = req.query;

  if (!topic) {
    return res.status(400).json({ error: "Missing topic parameter" });
  }

  // Check cache first
  const cacheKey = `${topic.toLowerCase()}__${lang}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return res.status(200).json({ videos: cached.videos, source: "cache" });
  }

  // Check API key
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "YouTube API key not configured on server." });
  }

  const query = buildQuery(topic, lang);

  try {
    const params = new URLSearchParams({
      part:              "snippet",
      q:                 query,
      type:              "video",
      maxResults:        "5",
      order:             "relevance",
      videoEmbeddable:   "true",
      safeSearch:        "strict",
      videoDuration:     "medium",
      publishedAfter:    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      relevanceLanguage: lang === "hi" ? "hi" : "en",
      key:               apiKey,
    });

    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    const result = await httpsGetJSON(url);

    if (!result.ok) {
      const msg = result.body?.error?.message || "YouTube API error";
      throw new Error(`YouTube API returned ${result.status}: ${msg}`);
    }

    const items = result.body.items || [];

    if (items.length === 0) {
      return res.status(404).json({ error: "No videos found for this topic." });
    }

    const videos = items.map((item) => ({
      id:      item.id.videoId,
      title:   item.snippet.title,
      channel: item.snippet.channelTitle,
      thumb:   item.snippet.thumbnails?.medium?.url ||
               `https://img.youtube.com/vi/${item.id.videoId}/mqdefault.jpg`,
    }));

    // Store in cache
    cache.set(cacheKey, { videos, cachedAt: Date.now() });

    return res.status(200).json({ videos, source: "api" });

  } catch (err) {
    console.error("YouTube API error:", err.message);
    return res.status(500).json({ error: "YouTube search failed: " + err.message });
  }
};
