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
  const { imageBase64, mediaType = "image/jpeg", lang = "en" } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64 field" });
  }

  // Size guard — reject frames over ~2 MB (base64)
  if (imageBase64.length > 2_800_000) {
    return res.status(413).json({ error: "Image too large. Max ~2 MB." });
  }

  // Call Anthropic — key lives only here on the server
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const langInstruction = lang === "hi"
    ? 'IMPORTANT: Return "display_name", "description", and all quiz fields in Hindi (Devanagari script). Use clear Hindi that a school student can understand. Keep "concept" in English (it is used for search).'
    : 'Return "display_name", "description", and all quiz fields in English.';

  const prompt = `You are an educational concept detector for a real-time learning app.
Look at this camera frame and identify the most prominent educational concept visible.
This could be a physical object (lever, pulley, magnet, drawing compass), a diagram (fraction bar, cell diagram, circuit), text on a board, or a recognisable scene.

${langInstruction}

Respond ONLY with a valid JSON object — no markdown, no preamble:
{
  "concept": "lowercase concept key in English (e.g. lever, fractions, photosynthesis, drawing compass)",
  "display_name": "Friendly name in the requested language",
  "description": "2 sentence explanation for a student in the requested language",
  "confidence": 0.90,
  "subject": "subject area (Physics / Biology / Mathematics / Geography etc.)",
  "related_topics": ["topic1","topic2","topic3"],
  "has_educational_content": true,
  "quiz_question": {
    "question": "A conceptual question in the requested language that tests UNDERSTANDING, not just recognition. Use 'why' or 'how' framing where possible. The question must require knowledge of the concept to answer correctly — it should NOT be answerable by common sense or process of elimination alone.",
    "options": ["Option A", "Option B", "Option C"],
    "answer_index": 0
  }
}

STRICT RULES FOR quiz_question:
1. All 3 options must be PLAUSIBLE — a student who hasn't watched the video should find all 3 believable, not obviously wrong.
2. The wrong options must be CLOSELY RELATED to the concept — common misconceptions, similar-sounding terms, or partially correct ideas. Never use absurd or unrelated distractors.
3. The question must test a SPECIFIC DETAIL or mechanism from the concept — not just the definition. For example, instead of "What is photosynthesis?", ask "Which gas is released as a byproduct of photosynthesis?" with options like Oxygen / Carbon Dioxide / Nitrogen.
4. Avoid questions where one option is obviously longer or more detailed than others — keep options similar in length.
5. The correct answer_index is 0-based (0 = first option is correct). Randomise which position the correct answer appears in.
6. Target difficulty: a student who watched the video attentively should get it right; a student who didn't watch should find all 3 options plausible.

If there is NO clear educational content (blank wall, random clutter, person's face), set has_educational_content to false, confidence below 0.4, and quiz_question to null.`;

  try {
    const message = await client.messages.create({
      model:      "claude-sonnet-5",
      max_tokens: 800,
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
