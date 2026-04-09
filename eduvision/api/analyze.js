// api/analyze.js
// Vercel Serverless Function — Secure proxy for Anthropic Vision API
// The ANTHROPIC_API_KEY environment variable is set in the Vercel dashboard,
// never exposed to the browser.

const Anthropic = require("@anthropic-ai/sdk");

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Vercel functions are stateless, so this resets per cold start.
// For persistent rate limiting across instances, swap this for
// a Vercel KV (Redis) store — see comments below.
const ipHits = new Map(); // ip → { count, windowStart }

const RATE_LIMIT   = 20;   // max requests per window
const WINDOW_MS    = 60_000; // 1 minute window

function isRateLimited(ip) {
  const now  = Date.now();
  const data = ipHits.get(ip);

  if (!data || now - data.windowStart > WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  if (data.count >= RATE_LIMIT) return true;
  data.count++;
  return false;
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",   // tighten to your domain in production
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limit by IP
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: "Too many requests. Please wait a moment before scanning again.",
    });
  }

  // Validate request body
  const { imageBase64, mediaType = "image/jpeg" } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64 field" });
  }

  // Size guard — reject frames over ~2 MB (base64)
  if (imageBase64.length > 2_800_000) {
    return res.status(413).json({ error: "Image too large. Max ~2 MB." });
  }

  // Call Anthropic — key lives only here on the server
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an educational concept detector for a real-time learning app.
Look at this camera frame and identify the most prominent educational concept visible.
This could be a physical object (lever, pulley, magnet,drawing compass), a diagram (fraction bar, cell diagram, circuit), text on a board, or a recognisable scene.

Respond ONLY with a valid JSON object — no markdown, no preamble:
{
  "concept": "lowercase concept key (e.g. lever, fractions, photosynthesis, drawing compass)",
  "display_name": "Friendly name",
  "description": "2 sentence explanation for a student",
  "confidence": 0.90,
  "subject": "subject area (Physics / Biology / Mathematics / Geography etc.)",
  "related_topics": ["topic1","topic2","topic3"],
  "has_educational_content": true
}

If there is NO clear educational content (blank wall, random clutter, person's face), set has_educational_content to false and confidence below 0.4.`;

  try {
    const message = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type:   "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const raw   = message.content.map((b) => b.text || "").join("").trim();
    const clean = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]+\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed) {
      return res.status(502).json({ error: "Could not parse AI response" });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    console.error("Anthropic error:", err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: "API key invalid or missing on server." });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: "AI quota exceeded. Try again shortly." });
    }
    return res.status(500).json({ error: "AI analysis failed: " + err.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   UPGRADE: Persistent rate limiting with Vercel KV (Redis)
   Install: npm i @vercel/kv
   Then replace the isRateLimited function above with:

   import { kv } from "@vercel/kv";

   async function isRateLimited(ip) {
     const key   = `rl:${ip}`;
     const count = await kv.incr(key);
     if (count === 1) await kv.expire(key, 60); // 60 second window
     return count > RATE_LIMIT;
   }
───────────────────────────────────────────────────────────────────────────── */
