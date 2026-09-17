// api/_lib/storage.js
// Uploads scan images to Cloudflare R2. R2 speaks the S3 API, so the
// standard @aws-sdk/client-s3 package works against it directly — no
// Cloudflare-specific SDK needed.
//
// Env vars required (set in the Vercel dashboard):
//   R2_ACCOUNT_ID       — Cloudflare account id (dashboard URL / R2 overview page)
//   R2_ACCESS_KEY_ID    — from an R2 API token (Manage R2 API Tokens)
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET_NAME      — the bucket created for scan images
//
// Until all four are set, putScanImage() returns false and does nothing —
// same "no-op until configured" pattern as db.js, so this can ship ahead
// of the R2 bucket existing.

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

let client = null;
let attempted = false;

function getClient() {
  if (!attempted) {
    attempted = true;
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
    if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
      client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      });
    }
  }
  return client;
}

// key e.g. "scans/2026-09-17/<scan-id>.jpg"
// base64Data is the raw base64 payload already sent by the frontend
// (no data-URL prefix — captureNow() strips that before POSTing).
async function putScanImage(key, base64Data, contentType) {
  const c = getClient();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!c || !bucket) return false;

  const body = Buffer.from(base64Data, "base64");
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || "image/jpeg",
    })
  );
  return true;
}

module.exports = { putScanImage };
