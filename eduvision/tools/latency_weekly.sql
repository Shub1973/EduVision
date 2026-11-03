-- CurioX latency trigger check (Board advice adopted 3 Nov 2026).
-- Review the scan model if, in a week, more than 15% of live scans take over
-- 3 seconds, or if scans over 5 seconds keep recurring. Run in the Neon SQL editor.
SELECT
  date_trunc('week', created_at)                           AS week,
  count(*)                                                 AS scans,
  round(100.0 * avg((ai_ms > 3000)::int), 1)               AS pct_over_3s,
  sum((ai_ms > 5000)::int)                                 AS scans_over_5s,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ai_ms)       AS median_ms,
  max(ai_ms)                                               AS slowest_ms,
  CASE WHEN avg((ai_ms > 3000)::int) > 0.15 THEN 'REVIEW: over 15% slower than 3 s'
       WHEN sum((ai_ms > 5000)::int) >= 3   THEN 'REVIEW: repeated scans over 5 s'
       ELSE 'OK' END                                       AS verdict
FROM scans
WHERE ai_ms IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;
