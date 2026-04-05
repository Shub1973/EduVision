// api/youtube.js
// Vercel Serverless Function — YouTube Data API proxy
// YOUTUBE_API_KEY is stored in Vercel environment variables, never in the browser.

// ─── In-memory cache to save API quota ───────────────────────────────────────
// Caches search results for 6 hours per topic+lang combination
const cache = new Map(); // key → { videos, cachedAt }
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Search query builder ─────────────────────────────────────────────────────
// Builds the best YouTube search query for a given topic and language
function buildQuery(topic, lang) {
  const hindiSuffixes = "हिंदी में NCERT class explanation";
  const englishSuffixes = "explained educational for students";

  if (lang === "hi") {
    return `${topic} ${hindiSuffixes}`;
  }
  return `${topic} ${englishSuffixes}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Log file to see all env variables available to the server (for debugging, remove in production)
  //console.log("All env keys:", Object.keys(process.env).join(", "));

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

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

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "YouTube API key not configured on server." });
  }

  const query = buildQuery(topic, lang);

  try {
    const params = new URLSearchParams({
      part:       "snippet",
      q:          query,
      type:       "video",
      maxResults: 5,
      order:      "viewCount", // most viewed first
      videoEmbeddable: "true",
      safeSearch: "strict",       // safe for students
      //UPDATED CRITERIA - Video Duration: Medium (4-20 mins)      
      videoDuration: "medium",
      //Updated criteria - Upload Date:  Last month
      publishedAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), 
      relevanceLanguage: lang === "hi" ? "hi" : "en",
      key:        apiKey,
    });

    const ytRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params}`
    );

    if (!ytRes.ok) {
      const err = await ytRes.json();
      throw new Error(err?.error?.message || "YouTube API error");
    }

    const data = await ytRes.json();

    if (!data.items || data.items.length === 0) {
      return res.status(404).json({ error: "No videos found for this topic." });
    }

    // Map to simple video objects
    const videos = data.items.map((item) => ({
      id:      item.id.videoId,
      title:   item.snippet.title,
      channel: item.snippet.channelTitle,
      thumb:   item.snippet.thumbnails?.medium?.url || `https://img.youtube.com/vi/${item.id.videoId}/mqdefault.jpg`,
    }));

    // Store in cache
    cache.set(cacheKey, { videos, cachedAt: Date.now() });

    return res.status(200).json({ videos, source: "api" });

  } catch (err) {
    console.error("YouTube API error:", err.message);
    return res.status(500).json({ error: "YouTube search failed: " + err.message });
  }
};
