// api/analyze.js
// Vercel Serverless Function — Secure proxy for Anthropic Vision API
// The ANTHROPIC_API_KEY environment variable is set in the Vercel dashboard,
// never exposed to the browser.

const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("crypto");
const { logScan } = require("./_lib/scanLogger");

// ─── Model ────────────────────────────────────────────────────────────────────
// Chosen 15 Oct 2026 from a 35-photo replay: Haiku 5.5 answered in a median of
// 2.0 s against 3.9 s for Sonnet 5, was at least as accurate, and costs about
// 1/22 as much per scan.
//
// Haiku 5.5 MUST run with thinking off and effort low (set where the request is
// built, further down). Its defaults think before answering, and thinking tokens
// count against max_tokens: with the defaults about 1 in 4 replies were cut off
// mid-JSON and most scans took over 3 s. Never swap in the model name alone.
//
// FALLBACK: to go back to Sonnet 5, comment out the Haiku line and uncomment the
// Sonnet line. The Haiku-only settings are skipped automatically for Sonnet.
const MODEL = "claude-haiku-5-5";
// const MODEL = "claude-sonnet-5";   // fallback: what CurioX launched on

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Vercel functions are stateless, so this resets per cold start.
// For persistent rate limiting across instances, swap this for
// a Vercel KV (Redis) store — see comments below.
const ipHits = new Map(); // ip → { count, windowStart }

// Tunable from the Vercel env without a redeploy.
// The default is sized for a CLASSROOM, not a single user: a whole school sits
// behind one public IP (NAT), so every student shares this budget. 100 students
// at ~4 scans/min needs ~400. The old value of 20 would have throttled a class
// almost immediately. See the note at the bottom of this file before "fixing"
// the limiter with Vercel KV - making it correct also makes it stricter.
const RATE_LIMIT   = Number(process.env.RATE_LIMIT) || 400;
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
    // Nothing else records throttling: the frontend shows a toast and silently
    // drops the scan, so without this line a pilot could be rate-limited and the
    // only signal would be a teacher mentioning it. Search Vercel logs for
    // RATE_LIMIT_HIT. The IP is hashed - children's network addresses should not
    // sit in logs, and a stable pseudonym is enough to count distinct networks.
    const ipRef = crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 8);
    console.warn(
      `RATE_LIMIT_HIT ip=${ipRef} limit=${RATE_LIMIT} window_ms=${WINDOW_MS} lang=${req.body?.lang || "?"}`
    );
    return res.status(429).json({
      error: "Too many requests. Please wait a moment before scanning again.",
    });
  }

  // Validate request body
  const { imageBase64, mediaType = "image/jpeg", lang = "en", scan_id } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64 field" });
  }

  // Size guard — reject frames over ~2 MB (base64)
  if (imageBase64.length > 2_800_000) {
    return res.status(413).json({ error: "Image too large. Max ~2 MB." });
  }

  // Call Anthropic — key lives only here on the server
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const LANG_NAMES = {
    hi: "Hindi (Devanagari script)",
    bn: "Bengali (Bangla script)",
  };
  const langInstruction = LANG_NAMES[lang]
    ? `Return "display_name", "description" and all quiz fields in ${LANG_NAMES[lang]}, in simple language a school student understands. Keep "concept" in English (it is used for search).`
    : 'Return "display_name", "description" and all quiz fields in English.';

  // ─── Prompt versions ──────────────────────────────────────────────────────
  // V1 is the original (~868 input tokens). V2 is trimmed (~300) and adds
  // explicit output-length caps. V3 (the default since 15 Oct 2026) is the
  // prompt tested with Haiku 5.5, plus tougher-but-fair quiz distractors.
  //
  // Why: after capping the uploaded image at 896x504, OUTPUT tokens were
  // 55-61% of the cost of a scan (360 tok English / 463 Hindi at $10/MTok,
  // vs 1,444-1,494 input tokens at $2/MTok). max_tokens:800 was never the
  // binding constraint - the prompt's own verbosity requirements were.
  //
  // Prompt caching is deliberately NOT used: Sonnet 5 requires a 1,024-token
  // minimum to cache and this prompt is below it, so cache_control would be
  // silently ignored. (Haiku 4.5's minimum is 4,096 - further out of reach.)
  //
  // Set PROMPT_VERSION=v1 or v2 in the Vercel env to fall back (then redeploy so
  // the new value is picked up). Delete V1 and V2 once V3 is confirmed good in
  // the field.
  const PROMPT_V1 = `You are an educational concept detector for a real-time learning app.
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

  const PROMPT_V2 = `Identify the single most prominent educational concept in this camera frame: a physical object (lever, pulley, magnet, drawing compass), a diagram (fraction bar, cell, circuit), text on a board, or a recognisable scene.

${langInstruction}

Reply with ONLY this JSON object - no markdown, no preamble:
{"concept":"lowercase english key","display_name":"friendly name","description":"...","confidence":0.9,"subject":"Physics / Biology / Mathematics / Geography / Chemistry / etc","related_topics":["a","b","c"],"has_educational_content":true,"quiz_question":{"question":"...","options":["A","B","C"],"answer_index":0}}

LENGTH LIMITS - keep every field tight:
- description: ONE sentence, 25 words maximum
- question: 20 words maximum
- each option: 6 words maximum, and all three similar in length
- related_topics: exactly 3, one or two words each

QUIZ RULES:
- Test a specific mechanism or detail, never the definition. Not "What is photosynthesis?" but "Which gas does photosynthesis release?"
- All 3 options must look plausible to a student who has not studied the topic: use common misconceptions or closely related terms. Never absurd or unrelated distractors.

If there is no clear educational content (blank wall, random clutter, a person's face): set has_educational_content false, confidence below 0.4, and quiz_question null.`;

  // ─── Prompt V3 ────────────────────────────────────────────────────────────
  // This is the "v3.2" prompt from the 15 Oct 2026 replay (broad range of
  // subjects, short Hindi/Bengali output, stable concept keys, "name only what
  // you can see"), with new QUIZ RULES that make wrong options tempting but
  // still fair. tools/replay_compare.js reads everything from LANG_NAMES down to
  // the `const prompt` line below, so test changes with:  --prompt prod
  const TEXTBOOK_TERMS = {
    bn: 'Use the standard terms from Bengali-medium school textbooks, not transliterated English (for example: কপিকল for pulley, ভগ্নাংশ for fraction, সালোকসংশ্লেষ for photosynthesis, কীলক for wedge).',
    hi: 'Use the standard terms from Hindi-medium school textbooks, not transliterated English (for example: घिरनी for pulley, भिन्न for fraction, प्रकाश संश्लेषण for photosynthesis, उत्तोलक for lever).',
  };
  const V3_LIMITS = (lang === "bn" || lang === "hi")
    ? { name: 3, desc: 12, q: 10, opt: 3 }
    : { name: 4, desc: 18, q: 15, opt: 5 };

  const PROMPT_V3 = `Identify the educational concept in this camera frame. A concept counts when the main subject of the picture is clearly visible and is something taught or studied in school or college, in ANY subject:
- science and maths: lever, pulley, magnet, circuit, cell, leaf, fraction bar, equation, polygon
- computing: program code, flowcharts, and computer hardware such as a keyboard or a scanner
- how everyday objects work: scissors, a lock, a tap, a zipper, a clock, a coin
- languages and literature: a word puzzle, a poem, a page of text in a textbook
- history, civics and geography: a map, a flag, a monument, a national day, the freedom struggle
- art, culture and traditions: a festival or idol (for example a Ganesh idol), a handicraft or sculpture (for example a clay pot), a musical instrument (for example a flute or tabla)

Name only what you can actually see, and name it specifically. Do not stretch an object into a loosely related concept it is not an example of. A person, hand, face, street, vehicle, empty room or clutter on its own is not a concept; a recognisable cultural, historical or art object is. If nothing qualifies, answer "none".

${langInstruction}
Write ONLY in the requested language and script. Do not mix in words or characters from any other language (only "concept" and "subject" and "related_topics" stay in English).${TEXTBOOK_TERMS[lang] ? "\n" + TEXTBOOK_TERMS[lang] : ""}

Reply with ONLY this JSON object - no markdown, no preamble:
{"concept":"lowercase english key","display_name":"friendly name","description":"...","confidence":0.9,"subject":"Physics / Biology / Mathematics / Computer Science / Language / History / Civics / Geography / Art & Culture / etc","related_topics":["a","b","c"],"has_educational_content":true,"quiz_question":{"question":"...","options":["A","B","C"],"answer_index":0}}

CONCEPT KEY: the general, standard English name, singular, lowercase, underscores for spaces (lever, pulley, magnet, fraction_bar, zipper, tabla, bar_graph). No suffixes such as _diagram, no "simple_machine_" prefix.

LENGTH LIMITS - hard limits, count the words:
- display_name: ${V3_LIMITS.name} words maximum
- description: ONE short sentence, ${V3_LIMITS.desc} words maximum
- question: ${V3_LIMITS.q} words maximum
- each option: ${V3_LIMITS.opt} words maximum, all three similar in length
- related_topics: exactly 3, one or two English words each

QUIZ RULES:
- Test general knowledge of the concept (its purpose, how it works, a key fact). Do NOT ask about details you would have to read off the picture, such as a value, colour, brand or count.
- Exactly ONE option is correct and must be factually accurate. The other two must be wrong, but tempting to a student who has only half understood the concept. Build each wrong option from one of these:
  a) a common misconception about this concept;
  b) a closely related term, part, step or quantity from the same topic (for example the neighbouring part of a lever, the opposite direction, the next stage of a process);
  c) a true fact that answers a different question.
- All three options must be the same kind of thing (all gases, all parts, all directions, all causes) and about the same length. The correct option must not be the longest, the most detailed, or the only specific one.
- Never use absurd or unrelated options (food, animals, feelings, daily chores) and never use a joke option.
- Be fair: a student who understands the concept must find the correct option clearly right and each wrong option clearly wrong. No trick wording, no negatives ("which is NOT"), no "all of the above" or "none of these", no options that overlap or are partly correct, and no question that depends on a debatable fact.
- answer_index is 0-based; vary which position is correct.

If no concept qualifies: concept "none", has_educational_content false, confidence below 0.4, display_name "None", description "", subject "General", related_topics [], quiz_question null.`;

  const prompt = process.env.PROMPT_VERSION === "v1" ? PROMPT_V1
               : process.env.PROMPT_VERSION === "v2" ? PROMPT_V2
               : PROMPT_V3;
  // Recorded with every scan so pilot data says which prompt produced it.
  const promptVersion = process.env.PROMPT_VERSION === "v1" ? "v1"
                      : process.env.PROMPT_VERSION === "v2" ? "v2"
                      : "v3";

  const tStart = Date.now();
  try {
    const params = {
      model:      MODEL,   // see "Model" at the top of this file
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
    };
    // Haiku 5.5 only: no thinking, low effort (the reason is at MODEL above).
    // Skipped for any other model, so the Sonnet 5 fallback sends what it always did.
    if (MODEL.startsWith("claude-haiku-5")) {
      params.thinking      = { type: "disabled" };
      params.output_config = { effort: "low" };
    }
    const message = await client.messages.create(params);

    // ── Latency measurement ─────────────────────────────────────────────────
    // aiMs = time spent in the Anthropic call only (the number the 3s budget
    // applies to). Cold starts add extra time to the first request after idle,
    // so judge on the median of several warm scans, not on a single reading.
    // aiMs, the model and token counts are also saved on the scan's Neon row
    // (below), so pilot data outlives the ~3 days Vercel keeps logs.
    const aiMs = Date.now() - tStart;
    const LATENCY_BUDGET_MS = 3000;
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

    // ── Force-shuffle quiz options ──────────────────────────────────────────
    // Claude is asked to randomise the answer position, but LLMs tend to drift
    // toward a default pattern (usually always placing the correct answer first)
    // over many calls. Shuffling here in code guarantees true randomness
    // regardless of what position Claude picked.
    if (
      parsed.quiz_question &&
      Array.isArray(parsed.quiz_question.options) &&
      typeof parsed.quiz_question.answer_index === "number"
    ) {
      const q = parsed.quiz_question;
      // Track correctness per option BEFORE shuffling (handles duplicate text safely)
      const indexed = q.options.map((text, i) => ({ text, correct: i === q.answer_index }));

      // Fisher-Yates shuffle
      for (let i = indexed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
      }

      q.options = indexed.map((o) => o.text);
      q.answer_index = indexed.findIndex((o) => o.correct);
    }

    // Scan/event logging — see curiox-codebase-reference.md, "Scan/event
    // logging" section, for the design this implements. Synchronous
    // (awaited) on purpose: Vercel Node serverless functions can be frozen
    // right after the response is sent, so a fire-and-forget write here
    // risks silently losing the row. Wrapped so a logging failure never
    // turns into a failed scan for the child.
    const scanId = scan_id || crypto.randomUUID();
    try {
      await logScan({
        scanId, lang, imageBase64, mediaType, parsed,
        model:         message.model || MODEL,   // the model the API says it used
        promptVersion,
        aiMs,
        inTokens:      message.usage && message.usage.input_tokens,
        outTokens:     message.usage && message.usage.output_tokens,
      });
    } catch (e) {
      console.error("SCAN_LOG_FAILED", e.message);
    }

    // totalMs also includes the R2 + Neon logging writes above.
    const totalMs = Date.now() - tStart;
    const latencyInfo = {
      model:      message.model,
      prompt:     promptVersion,
      lang,
      ai_ms:      aiMs,
      total_ms:   totalMs,
      in_tokens:  message.usage && message.usage.input_tokens,
      out_tokens: message.usage && message.usage.output_tokens,
      over_3s:    aiMs > LATENCY_BUDGET_MS,
    };
    // Grep Vercel logs for AI_LATENCY; slow ones are also logged as warnings
    // so the Warning filter in the Logs tab isolates them.
    console.log("AI_LATENCY " + JSON.stringify(latencyInfo));
    if (aiMs > LATENCY_BUDGET_MS) {
      console.warn("AI_LATENCY_SLOW " + JSON.stringify(latencyInfo));
    }
    // Also visible in the browser: DevTools > Network > /api/analyze > Headers.
    res.setHeader("X-AI-Latency-Ms", String(aiMs));
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

   READ THIS FIRST. The in-memory Map below is *leaky*: it is per-instance and
   resets on every cold start, so the real ceiling is roughly RATE_LIMIT x the
   number of warm instances. Moving to KV makes the limiter CORRECT - one shared
   counter - which also makes it STRICTER. Deploying KV while the limit is keyed
   on IP would hard-block a classroom, because a whole school shares one IP.

   So do not treat this as a straight swap. Either keep a classroom-sized
   RATE_LIMIT, or better, key the limiter on a per-device id sent by the client
   instead of on the IP - that limits each student rather than penalising them
   for sharing a network, and tightens abuse protection rather than loosening it.
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
