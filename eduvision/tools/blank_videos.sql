-- CurioX blank-video check (backlog C1, 3 Nov 2026). Run in the Neon SQL editor.
-- A scan had no video when YouTube failed (youtube_hit = FALSE) and DIKSHA did not
-- find one either (diksha_hit is not TRUE). Recognised scans only; "not recognised"
-- scans always get a fixed fallback video.
SELECT
  date_trunc('week', created_at)                                        AS week,
  lang,
  count(*) FILTER (WHERE has_educational_content)                       AS recognised_scans,
  count(*) FILTER (WHERE diksha_hit)                                    AS diksha_video,
  count(*) FILTER (WHERE youtube_hit)                                   AS youtube_video,
  count(*) FILTER (WHERE youtube_hit = FALSE AND diksha_hit IS NOT TRUE) AS blank_video
FROM scans
WHERE created_at >= '2026-11-03'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- The blank scans themselves:
-- SELECT created_at, lang, concept, subject FROM scans
-- WHERE youtube_hit = FALSE AND diksha_hit IS NOT TRUE ORDER BY created_at DESC;
