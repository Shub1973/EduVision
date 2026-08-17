// api/diksha.js
// Vercel Serverless Function — DIKSHA (Sunbird) content search proxy
//
// Queries the public DIKSHA content search API for curriculum videos in a
// given regional language (medium) and returns a normalised video list.
// No API key is required — DIKSHA is a government Digital Public Good and
// its discovery endpoints are publicly accessible.
//
// STREAMING-ONLY BY DESIGN: this endpoint returns metadata + original
// source URLs (DIKSHA CDN mp4 or YouTube). Nothing is downloaded or
// re-hosted, and every item carries its licence + source for on-screen
// attribution — keeping usage within CC licence terms.
//
// The browser cannot call diksha.gov.in directly (CORS), hence this proxy.

// ─── Config ──────────────────────────────────────────────────────────────────
// Override via env var if DIKSHA moves the endpoint.
const DIKSHA_SEARCH_URL =
  process.env.DIKSHA_SEARCH_URL ||
  "https://diksha.gov.in/api/content/v1/search";

// lang code (as used by the frontend) → DIKSHA "medium" value
const LANG_TO_MEDIUM = {
  bn: "Bengali",
  hi: "Hindi",
  en: "English",
  mr: "Marathi",
  or: "Odia",
  te: "Telugu",
  ta: "Tamil",
  kn: "Kannada",
  ml: "Malayalam",
};

// Optional board preference per language — used for ranking, not filtering,
// because board naming on DIKSHA varies by state tenant.
const LANG_TO_BOARD_HINT = {
  bn: ["West Bengal", "WBBSE", "WBBPE", "TBSE"],
  hi: ["CBSE", "NCERT"],
};

// ─── In-memory cache (6 h, same pattern as youtube.js) ───────────────────────
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function youTubeIdFrom(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function normaliseItem(item) {
  const mime = item.mimeType || "";
  const artifact = item.artifactUrl || "";
  const streaming = item.streamingUrl || "";

  let kind = null,
    id = null,
    url = null;

  if (mime === "video/x-youtube" || youTubeIdFrom(artifact)) {
    // YouTube-hosted DIKSHA item → play via the existing YouTube iframe
    id = youTubeIdFrom(artifact) || youTubeIdFrom(streaming);
    if (!id) return null;
    kind = "youtube";
  } else if (mime === "video/mp4" || mime === "video/webm") {
    // DIKSHA-hosted file → stream directly from the DIKSHA CDN.
    // Prefer the mp4/webm artifact (plays natively in <video>);
    // streamingUrl is often HLS (.m3u8), which mobile Chrome can't
    // play without a JS player, so only use it as a last resort.
    url = artifact || (streaming.endsWith(".m3u8") ? null : streaming);
    if (!url) return null;
    kind = "mp4";
  } else {
    return null; // not a playable video (pdf, epub, h5p …)
  }

  return {
    kind, // "youtube" | "mp4"
    id, // YouTube video id (kind === "youtube")
    url, // direct stream URL (kind === "mp4")
    title: item.name || "Untitled",
    source:
      (item.orgDetails && item.orgDetails.orgName) ||
      item.creator ||
      item.channel ||
      "DIKSHA",
    license: item.license || "CC BY 4.0",
    board: Array.isArray(item.board) ? item.board.join(", ") : item.board || "",
    grade: Array.isArray(item.gradeLevel)
      ? item.gradeLevel.join(", ")
      : item.gradeLevel || "",
    subject: Array.isArray(item.subject)
      ? item.subject.join(", ")
      : item.subject || "",
    thumb:
      item.appIcon ||
      (id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : ""),
    dikshaId: item.identifier,
  };
}

function boardScore(item, hints) {
  if (!hints || !item.board) return 0;
  const b = item.board.toLowerCase();
  return hints.some((h) => b.includes(h.toLowerCase())) ? 1 : 0;
}

async function searchDiksha(query, medium, filtersVariant) {
  // DIKSHA/Sunbird index has used both "medium" and "se_mediums" facets
  // across versions — we try the classic one first, then the "se_" variant.
  const mediumFilter =
    filtersVariant === "se"
      ? { se_mediums: [medium] }
      : { medium: [medium] };

  const body = {
    request: {
      filters: {
        ...mediumFilter,
        mimeType: ["video/mp4", "video/webm", "video/x-youtube"],
        status: ["Live"],
      },
      query,
      limit: 20,
      fields: [
        "identifier",
        "name",
        "mimeType",
        "artifactUrl",
        "streamingUrl",
        "appIcon",
        "license",
        "board",
        "medium",
        "gradeLevel",
        "subject",
        "creator",
        "channel",
        "orgDetails",
      ],
      softConstraints: { badgeAssertions: 98, channel: 100 },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(DIKSHA_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`DIKSHA search HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.result && data.result.content) || [];
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { topic, subject = "", lang = "bn" } = req.query;
  if (!topic) {
    return res.status(400).json({ error: "Missing topic parameter" });
  }

  const medium = LANG_TO_MEDIUM[lang];
  if (!medium) {
    return res
      .status(400)
      .json({ error: `Unsupported language code for DIKSHA: ${lang}` });
  }

  const cacheKey = `${topic.toLowerCase()}__${subject.toLowerCase()}__${lang}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return res.status(200).json({ videos: cached.videos, source: "cache" });
  }

  // Concept keys from analyze.js are English ("photosynthesis") — DIKSHA
  // item names are frequently bilingual, so an English query still matches.
  const query = subject ? `${topic} ${subject}` : topic;

  try {
    let raw = await searchDiksha(query, medium, "classic");
    if (!raw.length) raw = await searchDiksha(query, medium, "se");
    // Last attempt: topic alone, in case the subject narrowed it to zero.
    if (!raw.length && subject) raw = await searchDiksha(topic, medium, "classic");

    const hints = LANG_TO_BOARD_HINT[lang];
    const videos = raw
      .map(normaliseItem)
      .filter(Boolean)
      .sort((a, b) => boardScore(b, hints) - boardScore(a, hints))
      .slice(0, 5);

    if (!videos.length) {
      // 404 signals the frontend to fall back to the YouTube path.
      return res
        .status(404)
        .json({ error: `No ${medium} videos found on DIKSHA for "${topic}".` });
    }

    cache.set(cacheKey, { videos, cachedAt: Date.now() });
    return res.status(200).json({ videos, source: "diksha" });
  } catch (err) {
    console.error("DIKSHA API error:", err.message);
    // 502 (not 500) → frontend treats any non-ok as "fall back to YouTube".
    return res
      .status(502)
      .json({ error: "DIKSHA search failed: " + err.message });
  }
};
