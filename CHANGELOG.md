# Changelog

## 0.2.54 (2026-10-03)

- Refresh the macOS menu bar when usage files change, with one bounded worker and spaced retries instead of recurring usage scans.
- Preserve the last successful total when a scan fails; never turn a timeout into a successful $0 result.
- Count retained Claude usage across account switches, configured profile folders, and Desktop sessions; deduplicate streaming messages and recover identifiable historical totals from local statistics.
- Include Codex archives and uncapped retained history. Missing logs remain missing rather than being invented.
- Reprice retained history using the latest available model API rates, with official provider overrides, cache-write durations, context tiers, and explicit warnings for unknown models. These are API-equivalent estimates, not historical invoices.
- Bound scan memory, runtime, output, disk caches, and background refresh frequency; cancel workers when the app exits.

## 0.2.38 (2026-05-25)

### Fixes
- Refresh the full visible popover selection after wake, screen wake, unlock, and popover open instead of refreshing only the Today/All badge.
- Stop showing the first-load loading overlay when no fetch is actually in flight, preventing post-lock blank/loading states from lasting until manual Refresh.
- Recover from lock/sleep while a CLI scan is in flight by clearing stale refresh guards on resume and ignoring pre-resume results, preventing the menubar/popover from getting stuck on "Loading".

## 0.2.37 (2026-05-23)

### Fixes
- Remove the indefinite animated loading overlay that could keep SwiftUI re-rendering NSImage content and make the menubar look crashed.
- Cache the programmatically drawn owl icon so refreshes/loading states reuse one template image instead of rebuilding image representations during layout.

## 0.2.36 (2026-05-22)

### Fixes
- Keep automatic badge refreshes alive after timer/popover reschedules by preventing cancellation from stranding the refresh coalescing lock.
- Run timer and file-watch refreshes as independent MainActor tasks so the menu bar stays current without manual Refresh even hours later.

## 0.2.35 (2026-05-22)

### Fixes
- Replace the menubar fallback DispatchSource timer with a MainActor async loop to eliminate Swift 6 executor crashes during automatic refresh.
- Run CLI refreshes through capped temporary stdout/stderr files instead of blocking pipe drains so midnight/day-rollover refreshes cannot leave the popover stuck on "Loading Today…".

## 0.2.34 (2026-05-21)

### Fixes
- Revert the background timer queue because Swift 6 MainActor isolation crashes when the timer closure is installed from the app delegate; keep the coalesced automatic refresh path on the main queue.

## 0.2.33 (2026-05-21)

### Fixes
- Fix refresh timer crash by having the background timer post a main-thread notification instead of capturing MainActor app state from the timer queue.

## 0.2.32 (2026-05-21)

### Fixes
- Fix v0.2.31 crash by hopping from the background refresh timer queue back to the main queue before touching MainActor app state.

## 0.2.31 (2026-05-21)

### Fixes
- Move the fallback refresh timer off the main queue so the 30-second safety refresh is not delayed by popover/UI run-loop work.
- Coalesce timer and file-watch refreshes through one automatic refresh path.
- Do not show "Data may be stale" from an optimize-only error when the base usage payload is fresh.

## 0.2.30 (2026-05-21)

### Fixes
- Narrow macOS live-refresh file watching to actual usage stores instead of broad Cursor/OpenCode directories.
- Coalesce usage-log refreshes so file-change bursts cannot spawn a continuous refresh loop.

## 0.2.29 (2026-05-19)

### Fixes
- Let automatic menubar badge refreshes use the same 60s timeout as manual refreshes so large local session corpora do not falsely show "Data may be stale".

## 0.2.28 (2026-05-19)

### Fixes
- Make the macOS menubar refresh from real usage-log file changes instead of relying only on the 30s safety timer or manual popover refresh.
- Watch Claude, Codex, Cursor, and OpenCode usage directories with FSEvents and debounce refreshes during active coding.

## 0.2.13 (2026-05-06)

### Fixes
- Populate Project Spend from cached per-day project rollups so 7d/30d columns stay filled without blocking the menubar on slow historical re-parses
- Collapse `.worktrees` project paths like `exe-os-.worktrees-tom` back to their parent project names in the menubar
- Make Trend, Forecast, Stats, Project Spend, and Employee Spend respond to the selected Today/7 Days/30 Days/Month/All window instead of hardcoded day/month labels
- Default `exe-watcher optimize` to the 7-day window so the command stays interactive on larger local session corpora

### Tests
- Add TypeScript regression coverage for project-spend ranking/name cleanup
- Add Swift period-windowing tests for selected-range labels and zero-filled history windows

## 0.2.10 (2026-05-05)

### Fixes
- Resolve the menubar CLI from PATH, Homebrew, and every NVM Node bin instead of trusting only the latest NVM version or a broken PATH shim
- Keep the popover header and provider tabs locked to the selected period's all-provider payload so historical fetch failures no longer show today's provider totals beside a $0 header
- Surface human-readable CLI-not-found and timeout errors in the menubar instead of raw Swift enum dumps

### Tests
- Add Swift coverage for CLI path resolution, selected-period header consistency, historical-period error isolation, and period-to-CLI argument mapping

## 0.2.9 (2026-05-05)

### Fixes
- Match the active menubar period tab styling to the gold provider tabs, with dark purple text for contrast
- Make cold-start backfill period-aware so Today/7 Days/30 Days/Month/All fetch the history window that period needs
- Expand the menubar "All" period to a 365-day window so its totals line up with the backfill/history cap

## 0.2.8 (2026-05-05)

### Fixes
- Cold-start history now backfills at least 7 days so the default 7-day menubar view is populated immediately instead of showing only today
- Preserve the 30-day progressive catch-up limit for warm caches while allowing cold starts to parse recent historical spend

## 0.2.0 (2026-04-28)

### Features
- **AI Employees** — collapsible menubar section showing per-agent memory counts with 24h/7d/30d growth
- **Employee Spend** — model-aware cost breakdown per agent (Opus, Sonnet, Haiku rates)
- **Project Spend** — per-project cost across 24h/7d/30d periods in the menubar
- **Launch at login** — auto-registers via SMAppService Login Items (toggleable in System Settings)
- **Quit button** — clean shutdown from the menubar footer bar
- **Dynamic provider tabs** — only shows providers with actual spend data (no empty states)
- **App icon** — gold "EXE" on dark purple rounded square (Exe Foundry Bold)

### Fixes
- Eliminate battery drain from double timer, idle throttling, and QoS issues
- Use official API pricing over LiteLLM third-party markups
- Remove loading overlay — silent background refresh with pre-fetched periods for instant tab switching
- Fix double-counting in menubar JSON pipeline (cache + fresh parse overlap)

### Performance
- 7-day and 30-day queries from 2-5s down to ~1s (parse today only, daily cache for history)

## 0.1.1 (2026-04-25)

### Fixes
- Fix timezone-fragile day aggregator test (near-midnight UTC → stable midday)
- Bump version for npm publish

## 0.1.0 (2026-04-24)

### Fork & Rebrand
- Forked from [codeburn](https://github.com/getagentseal/codeburn) (MIT)
- Full rebrand: package name, CLI binary, config dirs, env vars, macOS app
- See upstream CHANGELOG for pre-fork history
