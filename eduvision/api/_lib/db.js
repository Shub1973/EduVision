// api/_lib/db.js
// Thin wrapper around @neondatabase/serverless. Uses Neon's HTTP driver
// (the `neon()` tagged-template function), not a pooled TCP connection —
// that's the right fit for Vercel serverless functions, which are
// short-lived and would otherwise exhaust a connection pool under load.
//
// Set DATABASE_URL in the Vercel env to the Neon connection string
// (Neon dashboard → Connection Details → "Pooled connection" or the plain
// one both work with the HTTP driver). Until DATABASE_URL is set,
// getSql() returns null and every caller in this app is written to treat
// that as "logging is not configured yet" and skip silently — so this
// can ship and be deployed before Neon is even set up, with zero effect
// on the app until the env var is added.

const { neon } = require("@neondatabase/serverless");

let sql = null;
let attempted = false;

function getSql() {
  if (!attempted) {
    attempted = true;
    if (process.env.DATABASE_URL) {
      sql = neon(process.env.DATABASE_URL);
    }
  }
  return sql;
}

module.exports = { getSql };
