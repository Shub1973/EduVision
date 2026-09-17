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

async function logScan({ scanId, lang, imageBase64, mediaType, parsed }) {
  const sql = getSql();
  if (!sql) return; // DATABASE_URL not set yet — no-op by design

  const ext = mediaType === "image/png" ? "png" : "jpg";
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const imageKey = `scans/${date}/${scanId}.${ext}`;

  // Store the image first so a failed R2 write still leaves the metadata
  // row honest about it (image_key null) rather than pointing at nothing.
  const stored = await putScanImage(imageKey, imageBase64, mediaType);

  await sql`
    INSERT INTO scans (
      id, lang, concept, confidence, subject, has_educational_content, image_key
    ) VALUES (
      ${scanId},
      ${lang || null},
      ${parsed.concept || null},
      ${typeof parsed.confidence === "number" ? parsed.confidence : null},
      ${parsed.subject || null},
      ${!!parsed.has_educational_content},
      ${stored ? imageKey : null}
    )
    ON CONFLICT (id) DO NOTHING
  `;
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
