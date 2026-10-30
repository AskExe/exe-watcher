# Watcher launch observability — E30 check

Scope: Watcher source, installed 0.2.73, the existing data.odd.community collector,
PostHog project 3, Sentry projects 3/4 and central Odd's Watcher backend. No new
service, paid infrastructure, recurring job or public activation is included.

Henry's E30 source is
`/Users/exeai/henrykun/posting/1-ideas/paper-10-scripts.md`, section 20.
The corresponding final-mix transcript is
`posting/2-in-progress/2026-12-e30-observability/paper/qc/transcript.txt`.
It names `observability-setup`: structured logs; rate, errors and duration;
OpenTelemetry tracing; and an error-rate alert. Only that specification was found,
not a companion SKILL.md, in Henrykun, Odd Website/DM or installed skill folders.

## Verified coverage and remaining gates

| Signal | Observed behavior | Remaining launch gate |
| --- | --- | --- |
| Logs | Native refresh/health log rotates near 500 KiB. Supabase Storage logs expose the actual database error, request/trace IDs and duration. | Source follow-up changes local logs to timestamped JSON lines and makes logs/rotation/traces owner-only. Qualify the signed installed artifact after merge. |
| Metrics | Existing PostHog dashboard has daily active installations, active minutes, feature counts, outcomes and version/platform cohorts. Native traces contain fetch-health counters and span duration. Supabase's live Storage report shows request counts/statuses and average response speed; its project overview shows per-service error rates. | Backend rate/errors/duration exist in Supabase. Cross-surface client latency percentiles are absent from PostHog. Usage outcomes cover participating foreground activity, not every background/account request. |
| Traces | Installed native Perfetto trace was valid JSON: 5,516 events, including 1,612 begin/end pairs, health counters and duration fields. Hosted Storage exposes trace_id/span_id and responseTime. | No verified OpenTelemetry client-to-server trace propagation/export. Perfetto refresh traces alone do not meet that requirement. |
| Alerts | Both Watcher Sentry projects were queried directly; each has zero rules. Existing Sentry SMTP transport is configured. | Choose recipient/channel; configure the error-rate rule and prove a marked test alert arrives. The pending user card asks for that destination and test permission. |
| Crashes | Real sanitized handled CLI/native reports reached Sentry during the release audit. | Full native crash capture remains outside current coverage; do not label handled-error reporting as crash qualification. |

No prompts, code, account/session credentials, recovery phrases or private history
may enter a central monitoring payload. Existing usage and diagnostics choices,
revocation and queue limits remain mandatory. Do not switch on general SDK
autocapture or copy auth/storage payloads into traces.

## Concrete findings and corrections

Hosted QA found SQLSTATE 42702 in `watcher_admit_object`: the variable `owner`
conflicted with the real Storage table's `owner` column. `watcher_delete_history`
had the same ambiguity. Central PR79 adds a follow-up migration renaming both
variables, preserving all owner/session/consent/quota/locking and RLS guards.
Both full-chain shims and Watcher's SQL policy fixture now include real owner
columns. All 46 focused Watcher tests pass with the follow-up migration applied.

Installed local refresh/trace files were mode 0644. Source follow-up uses private
directories (0700), append files (0600, no symlink following), private atomic trace
replacement and private rotated logs. Native tests cover existing-file permissions,
structured newline escaping, rotation and symlink refusal. Trace timing now uses a
monotonic clock; serial writes prevent an older snapshot overwriting a newer one.
These changes remain local support artifacts; no new network collection is added.

## Runtime binding and receipts

Read-only live binding: data.odd.community's Caddy mounts
`/opt/odd-intake/Caddyfile` (SHA256
`0e73be2b842979f37d06c9cb771d875991d00e0d23a1a2efc499326a97e7324e`).
Gateway image `fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`
publishes actual loopback 18081 to 8080 and consumes `/opt/odd-analytics/gateway.mjs`
(SHA256 `d9386f2e477dcec30f76cb98f1bda37da63cbc524c9676c2c742f4749e76a70e`).
Sentry ingress publishes actual loopback 19000; dashboards stay private.

Focused logs: `/private/tmp/watcher-owner-final-node.log` and
`/private/tmp/watcher-observability-native.log`. Hosted QA receipt:
`/private/tmp/watcher-hosted-qa-receipt.json`; it contains only exact disposable
owner UUIDs, fixed check names and sanitized status/code classifications.
Every attempted fixture cleanup passed; no real review-account vault was enrolled.

**Not launch-qualified yet:** hosted upload/restore/deletion must pass after the
SQL correction; propagated client-to-server tracing and delivered alert
verification remain open. The existing backend metric report is at
`https://supabase.com/dashboard/project/vjiexzktmduoguxvleiy/observability/storage`.
It exposed the failed owned uploads and their durations during this audit.
Public backup is disabled. Token usage is unavailable.
