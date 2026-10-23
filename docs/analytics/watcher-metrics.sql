-- PostHog SQL insights. Filter the project to Watcher; use UTC reporting days.
-- DAU: consenting installations, not unique humans across devices.
SELECT toDate(timestamp) AS day, uniqExact(distinct_id) AS active_installations
FROM events
WHERE properties.app = 'watcher'
  AND event IN ('app_active', 'app_usage', 'app_recording', 'app_feature', 'app_result')
GROUP BY day ORDER BY day;

-- Foreground/non-idle activity plus background dictation, in minutes.
SELECT toDate(timestamp) AS day, sum(toFloat(properties.active_ms)) / 60000 AS active_minutes
FROM events
WHERE properties.app = 'watcher' AND event = 'app_usage'
GROUP BY day ORDER BY day;

-- Captured recording duration, including silence.
SELECT 'N/A — Watcher does not record' AS recording_minutes;

SELECT properties.feature AS feature, count() AS uses
FROM events
WHERE properties.app = 'watcher' AND event = 'app_feature'
GROUP BY feature ORDER BY uses DESC;

SELECT properties.feature AS feature, properties.outcome AS outcome, count() AS attempts
FROM events WHERE properties.app = 'watcher' AND event = 'app_result'
GROUP BY feature, outcome ORDER BY attempts DESC;

SELECT properties.app_version AS app_version, properties.app_platform AS app_platform,
uniqExact(distinct_id) AS active_installations
FROM events WHERE properties.app = 'watcher'
GROUP BY app_version, app_platform ORDER BY active_installations DESC;
