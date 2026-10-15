// api/_lib/scanLogger.js
// Closes the instrumentation gap documented in curiox-codebase-reference.md:
// every scan writes its image to R2 and a metadata row to Neon; diksha.js
// updates that row with hit-vs-fallback once it knows the answer.
//
// scan_id is generated client-side in index.html (analyzeFrame()) and
// threaded through to both /api/analyze and /api/diksha so the two writes
// join on the same row. If a request arrives with no scan_id (e.g. an old
// cached frontend), analyze.js falls back to generating one server-side —
// that scan just won't have a matching diksha row, which is fine.
//
// Every function here is written to fail soft: if Neon/R2 aren't configured,
// or a write errors, the caller (analyze.js / diksha.js) logs it and moves
// on. Scan logging must never be the reason a child's scan fails.

const { getSql } = require("./db");
const { putScanImage } = require("./storage");

// Postgres error 42703 = "column does not exist". The new model/latency columns
// are added by the migration in neon_scans_schema.sql; until that has been run
// on the database, fall back to the original insert so no scan row is lost.
function isMissingColumn(e) {
  return !!e && (e.code === "42703" || /column .* does not exist/i.test(String(e.message || "")));
}
const intOrNull = (n) => (Number.isFinite(n) ? Math.round(n) : null);

async function logScan({ scanId, lang, imageBase64, mediaType, parsed, model, promptVersion, aiMs, inTokens, outTokens }) {
  const sql = getSql();
  if (!sql) return; // DATABASE_URL not set yet — no-op by design

  const ext = mediaType === "image/png" ? "png" : "jpg";
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const imageKey = `scans/${date}/${scanId}.${ext}`;

  // Store the image first so a failed R2 write still leaves the metadata
  // row honest about it (image_key null) rather than pointing at nothing.
  const stored = await putScanImage(imageKey, imageBase64, mediaType);

  const concept    = parsed.concept || null;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
  const subject    = parsed.subject || null;
  const hasContent = !!parsed.has_educational_content;
  const key        = stored ? imageKey : null;

  try {
    // model, prompt_version, ai_ms (time in the Anthropic call), in_tokens and
    // out_tokens are what let the pilot report real speed and cost per scan.
    await sql`
      INSERT INTO scans (
        id, lang, concept, confidence, subject, has_educational_content, image_key,
        model, prompt_version, ai_ms, in_tokens, out_tokens
      ) VALUES (
        ${scanId}, ${lang || null}, ${concept}, ${confidence}, ${subject}, ${hasContent}, ${key},
        ${model || null}, ${promptVersion || null}, ${intOrNull(aiMs)}, ${intOrNull(inTokens)}, ${intOrNull(outTokens)}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (e) {
    if (!isMissingColumn(e)) throw e;
    console.warn("SCAN_LOG_LEGACY_SCHEMA run the model/latency migration in neon_scans_schema.sql; saving the row without those columns");
    await sql`
      INSERT INTO scans (
        id, lang, concept, confidence, subject, has_educational_content, image_key
      ) VALUES (
        ${scanId}, ${lang || null}, ${concept}, ${confidence}, ${subject}, ${hasContent}, ${key}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

// hit = true  → DIKSHA returned relevant videos
// hit = false → fell back to YouTube, whether from a clean 404 or a DIKSHA error
async function logDikshaResult(scanId, hit) {
  const sql = getSql();
  if (!sql || !scanId) return;

  await sql`
    UPDATE scans
    SET diksha_hit = ${hit}, diksha_checked_at = now()
    WHERE id = ${scanId}
  `;
}

module.exports = { logScan, logDikshaResult };
