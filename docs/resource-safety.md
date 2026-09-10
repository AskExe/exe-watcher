# Watcher resource safety

The September 2026 audit traced filesystem events, timer/wake recovery, badge/detail refresh, CLI process ownership, provider discovery, parsing and cache writes with MCP code_context, then reproduced failures with executable tests.

## Controls

- The existing 30-second completion cooldown coalesces automatic refreshes. Badge and detail share per-key ownership, with one lane each and a global maximum of two CLI fetch processes. Each queue is capped at 32; cancelled waiters never launch later.
- Failed requests back off from 30 seconds to five minutes per key across all refresh entry points; health recovery cannot bypass that deadline.
- Cancellation, timeout and output overflow terminate the child, escalate to SIGKILL and reap it before releasing its permit. Live pipes enforce 20 MiB stdout and 256 KiB stderr limits. Child lifetime is at most 60 seconds plus termination/reaping.
- A PID lease serializes status ingestion across processes, with bounded waiting and dead-owner recovery.
- Unchanged parsed files survive process restarts in a versioned disk cache, invalidated by source identity, size, timestamps, WAL changes and pricing. Changed snapshots are not cached. Cache entries are at most 16 MiB and the disk budget is 256 MiB. Yesterday is revalidated every five minutes; identical index/daily-cache writes are skipped.
- Codex, Pi and OMP discovery read bounded headers. JSONL parsing streams a fixed file snapshot with linear chunk buffering and a 32 MiB record limit. Prompt prefixes retain 512 characters with classification signals from the complete prompt.
- A scan allows 1 GiB input, 200,000 usage records and 30 seconds. SQLite results stop at 100,000 rows or 32 MiB. The executable launcher and macOS child environment configure a 256 MiB V8 old-space limit; this is not a total RSS limit. Explicit `node dist/cli.js` invocation bypasses shebang flags.
- Budget exhaustion fails visibly rather than publishing partial successful totals. The app keeps its last successful payload. A cold large history can need several bounded refreshes to populate durable caches. A permanently oversized record requires reducing the input or a future format-specific parser; retries cannot fix it.

## Verification

Regression tests cover overlapping badge/detail requests, five concurrent period requests, cancellation, ignored SIGTERM, output overflow, cancelled queued permits, snapshot growth, oversized records, cache invalidation, stable-cache no-write behavior, lock contention and dead owners. macOS CI runs the Swift suite in addition to the Node suite.

Local verification on September 10: 613 JavaScript tests (isolated home provider discovery), 62 Swift tests, TypeScript compilation, universal macOS app build. A successful warm Today/All refresh against the actual local history took 3.05 seconds, 1.91 seconds user CPU and 255 MB peak RSS. These are measurements on one computer, not universal performance guarantees.

The app and CLI are version 0.2.51. Local installation does not distribute fixes to other users; a public release remains a separate delivery step.

## Full Report correction (0.2.52)

The terminal dashboard previously started optimization eagerly and retained full per-call results across period changes. Selecting All Time could exhaust the 256 MiB V8 heap and abort Node. Report scans now compact each session into exact daily/model/category/working-style summaries, retaining no per-call arrays after aggregation. Repeated fragments of the same provider session are merged. The ordinary parser remains available for consumers that require individual turns.

Startup, keyboard period/provider changes and refresh timers share a serialized latest-request loader. Superseded scans receive cancellation through the filesystem budget; queued intermediate selections do not run. Optimization starts on demand and reads files serially. Errors render a recoverable panel with retry and period-navigation controls, and automatic failure retries back off. The heap guard derives its threshold from the actual V8 heap limit, rather than exceeding the configured heap ceiling. The executable exposes GC so the guard first collects discarded per-file JSON, avoiding false budget failures from collectible allocations. Under-budget disk caches are no longer pruned to half their size on every new process.

Foreground summary scans allow up to 8 GiB read and two million processed records while retaining the 30-second and heap bounds. Background scans retain their 1 GiB and 200,000-record limits. Explicit reports have a larger input working set without retaining the full history in memory.

Verification: 618 JavaScript tests; exact raw-versus-summary total, activity and comparison assertions; cancellation/coalescing/error-retry tests. A real PTY run switched Week → All Time → Today and exited normally, rendering 295,989 local calls across 674 projects without resource errors. The summary scan retained about 90 MB heap; the interactive process peaked around 475 MB RSS, including transient parsing and runtime memory. V8 old space remained capped at 256 MiB.
