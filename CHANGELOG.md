# Changelog

## 0.2.65 (unreleased)

- Add `c` to copy all optimizer recommendations and `e` to save a private Markdown file, ready to share with Claude Code. Include complete fixes and partial-analysis warnings, reuse displayed results without another scan, and show copy/save confirmation or a recoverable error.

## 0.2.64 (unreleased)

- Make the floating display smaller with compact provider rings and a period pill. Turn You + AI and AI Time into metric buttons that open their explanations, with the same buttons in the detailed card.
- Add a Claude sign-in button to the floating display and prefer Claude Code's current macOS Keychain login over old credential files. Hide provider timing rows without recorded time.
- Keep the full-report optimizer useful on large histories with bounded, explicitly partial recommendations from the newest selected sessions. Retain the original hard resource limits and leave interrupted files uncached.
- Omit unused-configuration cleanup suggestions and overall health grades when analysis is partial. Pause automatic report refresh while reading optimizer results; manual retry and period changes remain available.

- Expand the floating display to six quota providers: Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini. Show multiple rings at once, switch provider details and save visibility choices, with Claude/Codex as defaults.
- Add read-only quota adapters with independent request coalescing and cooldowns, account-scoped stale readings, tenant-bound Copilot requests and bounded HTTP responses without redirects. Never rotate or copy credentials in the new adapters; missing/unlimited allowances stay explicit.

- Suppress the blue macOS focus outline on AI-time details and retry controls, matching the other popover controls.
- Add an optional native floating display, inspired by CodeBurn's Capacity Dock, with Claude five-hour/weekly quota rings, reset timing, hover details, pinning, edge snapping and saved placement.
- Show estimated You + AI interaction time and total AI work time across agents. Default to Today, with Week, Month and All Time controls independent of the main popover filters.
- Share quota requests with Plan, keep stale/missing readings explicit, and use passive credential reads with rate-limit backoff. Preserve the existing bounded usage/timing workers.
- Adopt the supplied owl's centered pupil cutouts across native artwork and app icons, and add a small looping owl GIF to the README with editable animation source.

## 0.2.63 (unreleased)

- Continue queued timing recovery automatically in small timing-only steps, so quiet logs finish without waiting for another usage event. Share one child-process slot, rest between steps, and stop when work is drained, blocked or cancelled.
- Use the existing automatic read/time limits across small blocks and leave incomplete final records asleep until an append arrives. Do not rescan costs or refresh their timestamps during timing catch-up.
- Keep newer timing results when a cost or Optimize response arrives, and clarify that provider file counts describe the selected view.

## 0.2.62 (unreleased)

- Add AI running time, elapsed busy time, and estimated interaction time below spend in the menu bar and terminal dashboards, following each period and provider selection.
- Recover retained timing evidence since July 1, 2025 across supported clients, including parallel sessions and subagents. Merge overlaps for elapsed time and interaction estimates; never infer attention from an open terminal.
- Keep missing history and formats without usable clocks explicitly unknown. Label inferred AI durations and personal-time estimates, with provider coverage details.
- Exclude unverified gaps when old OpenCode messages were closed in bulk much later. Recover short observed prefixes as estimates and preserve the remaining time as unknown.
- Save a bounded, resumable timing index independently of cost history. Tail appended records on existing file-change refreshes; use `exe-watcher time --recover` for a bounded historical pass.

## 0.2.61 (unreleased)

- Open the full report in one Terminal window when Terminal starts; keep existing shells untouched.
- Scope Optimize to the report's selected sessions, reuse bounded caches of compact detector inputs, and retain usage totals if an analysis reaches a resource limit. Keep standalone and menu bar optimization within the same scan limits.
- Explain in Optimize that its Claude Code recommendations require the user to apply any changes.
- Keep incomplete history rebuilds from replacing ALL totals with just today’s spend, including saved results from older CLIs. Preserve the last committed history during repricing.
- Resume oversized provider rebuilds without marking skipped dates complete; rebuild legacy partial stages safely.
- Cache verified per-file usage dates independently of prices, so historical scans skip unrelated files without dropping changed sessions.
- Reuse the bounded parsed-cache quota across launches and reserve it atomically, avoiding repeated full directory inventories.

## 0.2.60 (2026-10-15)

- Fix menu bar updates that macOS rejected as "damaged and can't be opened": the updater now unpacks the release with `ditto`, so the app's signature survives (it used `unzip`, which wrote `._` metadata files into the bundle). Apps on 0.2.59 or earlier still update with the old unpacker once; install this release from the DMG or with an updated `exe-watcher menubar --force`.
- Bring the owl to life. When the popover opens, the header owl looks left and right, blinks, tilts its head and settles, then keeps glancing and blinking for as long as the popover stays open. Clicking the menu bar owl plays a short glance and blink before returning to the static gold mark. With Reduce Motion the owl only blinks. Nothing animates or is scheduled while the popover is closed.
- Redraw the terminal loading-screen owl from the 01A logo itself (half-block pixel art in Exe Gold) instead of the old cartoon; it looks left, right and blinks while sessions are scanned.

## 0.2.58 (unreleased)

- Discover a supported client's first usage even when its data folder is created after Watcher starts. Include Copilot, custom Claude configuration roots and symlinked profiles in live monitoring, while ignoring unrelated home-folder events.
- Show when costs exclude usage without known API prices and when a provider's discovery fails. Label today's spend as an API-equivalent estimate.
- Verify default Codex, Claude Code, native Kimi Code and OpenCode discovery from an isolated new user home with no configuration, client executables or API keys. Check token normalization, cache pricing, provider totals, restarts and unknown models.
- Document supported clients, model pricing, custom data locations and formats that cannot yet be imported.

## 0.2.57 (unreleased)

- Include native Kimi Code wire logs for main agents and subagents, with separate uncached input, output and cache token counts. Ignore context-size measurements and deduplicate copied records.
- Add a Kimi provider tab and usage-file refresh notifications. Providers with free or unpriced models remain visible when their tokens are recorded.
- Add the missing Kimi contribution to valid historical caches without rescanning other clients. Value explicit K3 variants at K3 API rates; retain tokens and warnings for rotating coding aliases whose underlying API model is unknown.

## 0.2.56 (unreleased)

- Update all covered period summaries from one fresh daily scan. Switching between Today, Week, Month and All Time reuses the same historical daily totals.
- Keep period summaries in a private cache across same-day app restarts, and skip queued scans when another refresh has already supplied the result.
- Save completed provider scans during historical repricing so a timeout resumes work instead of restarting. Keep incomplete dates visible as warnings and preserve historical revalidation for late usage.

## 0.2.55 (2026-10-14)

- Adopt the chosen 01A owl with folded wings, a slim beak and the original eyes, preserving the existing fonts and palette. Use one native drawing for the header, loading state and menu bar, with simpler details at small sizes.
- Include three alternative owl studies and the current mark in an interactive comparison page.
- Package a universal macOS app with its matching CLI and a checksum-pinned Node runtime; no global Node/npm installation is needed for the downloaded app.
- Add a drag-to-install DMG, updater ZIP, SHA-256 checksums, Developer ID signing and Apple notarization support. Public tagged releases fail closed when signing credentials are missing.
- Quote Terminal launch arguments so reports also open from app paths containing spaces or apostrophes.
- Limit test discovery to the current checkout, excluding nested worktrees.

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
