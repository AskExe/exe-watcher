# CodeBurn origin and adoption review

Reviewed October 16, 2026 (Asia/Makassar). This is a dated source comparison and proposed backlog, not a promise that every candidate will be implemented.

## Revisions and origin

| Evidence | Revision / result |
| --- | --- |
| Watcher baseline | [`09daeacbbc0dac550d9239876abfb6dbd559f8fd`](https://github.com/AskExe/exe-watcher/commit/09daeacbbc0dac550d9239876abfb6dbd559f8fd), package 0.2.62 |
| First Watcher commit | [`8545e35633958ab3fd12600c1ac89c528c867904`](https://github.com/AskExe/exe-watcher/commit/8545e35633958ab3fd12600c1ac89c528c867904), April 24, 2026, 14:40 +08:00 / 06:40 UTC; “Initial commit — exe-fuelbar (based on codeburn MIT)” |
| Matching upstream snapshot | [`d3c4de03759f0ded38052874fa829709d27fe7c6`](https://github.com/getagentseal/codeburn/commit/d3c4de03759f0ded38052874fa829709d27fe7c6), April 24, 2026, 11:53:52 +08:00; package 0.8.9 |
| Upstream reviewed | [`9a40cc603fcd194caca9daa8c5134a61ea7e0e2b`](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b), October 13, 2026, 16:10:38 +08:00; package 0.9.27; upstream `main` at review |
| GitHub repository metadata | [`AskExe/exe-watcher`](https://api.github.com/repos/AskExe/exe-watcher): created April 24, 2026, 14:39:55 +08:00; `fork: false`, no parent |

The root commit has no parents and contains 112 files. Comparing paths, modes, object types, and Git blob IDs against the matching upstream snapshot gives **112 identical files, zero changed files, zero Watcher-only files**. Upstream has two extra planning documents, omitted from the import: `docs/superpowers/plans/2026-04-19-model-comparison.md` and `docs/superpowers/specs/2026-04-19-model-comparison-design.md`.

The histories at the reviewed heads contain 186 Watcher commits and 2,539 upstream commits, with **zero shared commit IDs**. This supports a source snapshot import, not a history-preserving clone/fork. The initial package still used CodeBurn's name, author, repository, and version. Rebranding began at `401aca4` seven minutes later; the Watcher rename landed at `5986609` on April 30. Git does not record which download/copy command was used.

To reproduce, compare `git ls-tree -r 8545e35` here with `git ls-tree -r d3c4de0` in an upstream clone, matching entries by path; compare the two `git rev-list` sets separately. Keep upstream in a separate checkout so its history is not confused with Watcher's.

## What was inherited, and what changed here

Already present in the imported snapshot: the CLI/TUI; Claude, Codex, Cursor, Cursor Agent, Copilot, OpenCode, Pi and OMP integrations; native Swift menu bar app; Claude five-hour/weekly utilization and projections; capacity estimation; currency support; caching; classification; model comparisons; optimization; and tests. The former README credited several of these as Watcher additions; that has been corrected.

Subsequent Watcher work includes Exe branding and owl artwork; Exe OS agent/memory integration (`src/cli.ts`, `src/menubar-json.ts`); bounded scans and resumable historical accounting (`src/resource-budget.ts`, `src/history-build.ts`); event-driven refreshes (`mac/Sources/ExeWatcherMenubar/Data/RefreshCoalescer.swift`); provider discovery/recovery and pricing fixes; native Kimi support (`src/providers/kimi.ts`); self-contained macOS packaging; and AI time reporting (`src/time-tracking.ts`, `src/time-index.ts`). This identifies our development direction, not features claimed to be absent from today's upstream.

### README comparison refresh, October 16

The refreshed README dates the import prominently, documents 175 days of development as **nearly six months**, and records feature milestones from source history. Six calendar months will be reached on October 24, 2026. The README now brings AI time and employee memory/spend into its main feature sections, updates CLI/options and budget explanations, and identifies unreleased source functionality.

Current upstream `main` was rechecked and remained `9a40cc6` (0.9.27). Its [`src/sessions-report.ts`](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/sessions-report.ts) includes session duration and [`src/codex-throughput.ts`](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/codex-throughput.ts) measures Codex generation timing. Its JSON/desktop views also include agent/subagent breakdowns. Accordingly, the README does not claim that all time tracking or agent-spend reporting is exclusive to Watcher.

A targeted review across upstream `src/`, `mac/`, `app/` and `docs/` found no equivalent of Watcher's combined AI-running/elapsed-busy/interaction-time report, persistent employee-memory ledger, or Exe OS stats integration. The README labels these as findings for the reviewed revision. Local evidence is `src/time-tracking.ts`, `src/time-index.ts`, `src/menubar-json.ts`, `src/cli.ts`, and native `Views/AITimeSection.swift` / `Views/AgentsSection.swift`.

Accepted Watcher main advanced to `d5789f6` during this refresh; it was merged into the review branch before editing. This includes the 0.2.63 timing catch-up changes. Earlier 0.2.62 package-check results below remain historical results for their recorded baseline; this follow-up changes documentation only.

## Adoption candidates, in proposed order

Upstream paths below refer to the pinned [reviewed revision](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b). Candidates require selective adaptation: the two projects' data models and refresh policies have diverged.

| Priority | Upstream capability and source | Watcher today | Proposed adoption and acceptance |
| --- | --- | --- | --- |
| 1 | Multi-provider live quotas: `src/quota/index.ts`, `src/quota/codex.ts`, `docs/plans-and-quota.md` | Native floating readers for Claude, Codex, Kimi, Cursor, Copilot and Gemini (unreleased); no `quota` CLI | Add Claude/Codex quota JSON and menu bar rows with provider-reported windows, remaining %, reset time, and unavailable states. Verify missing/expired auth, account changes, 429s and malformed responses. |
| 1 | Provenance and pacing: `src/quota.ts`, `src/quota/types.ts` | Claude projections and capacity estimation already exist | Share a quota model across surfaces; label measured/estimated/stale readings. Preserve missing values. Test expired resets, early-window noise, zero limits and clock skew; upstream suppresses exhaustion ETAs for windows at or below six hours. |
| 1 | On-screen Capacity Dock: `mac/Sources/CodeBurnMenubar/CapacityDockController.swift`, `Views/CapacityDockView.swift`, `Data/CapacityDockPreferences.swift` | Implemented locally in `codex/watcher-floating-quota`: native six-provider quota widget plus all-agent timing | Hover details, pin/dismiss, reset timing, all-edge placement and saved preferences are implemented. Additional adapters and OS threshold alerts remain candidates. See [implementation handoff](floating-quota-handoff.md). |
| 2 | Quota threshold notifications: `mac/Sources/CodeBurnMenubar/Data/QuotaCrossing.swift`, `Data/EarlyQuotaResetMonitor.swift` | No quota-crossing notification monitor | Evaluate separate opt-in 80%/100% warnings and early-reset notices. Deduplicate per provider/window/reset cycle, persist across relaunches, honor notification permissions and use existing refreshes. |
| 2 | Offline diagnostics and token-source audit: `docs/cli.md`, `src/doctor.ts`, `src/audit-report.ts` | Discovery/pricing warnings, partial-history and call-count indicators | Add bounded, read-only provider diagnostics showing paths, coverage and pricing source; fixture checks must distinguish missing data from zero. |
| 2 | Local MCP tools: `src/mcp/server.ts`, `src/mcp/redact.ts`, `docs/mcp.md` | JSON CLI reports and Exe OS integration | Expose bounded usage/savings queries to our agents. Pseudonymize project names by default; include completeness warnings and no transcript/credential content. |
| 2 | Branch/worktree spend: `src/branch-spend.ts`, `docs/by-branch.md` | Project and agent spend; no branch-spend report | Attribute each turn once using recorded branch/worktree metadata. Keep unknown coverage explicit; test branch switches and parallel worktrees. |
| 3 | Shipped-work analysis: `src/yield.ts`, `docs/yield.md` | No yield command | Evaluate commit/PR correlation only after branch coverage exists. Label timestamp attribution as heuristic; test squash merges, reverts and ambiguity. |
| 3 | Reviewed config fixes and undo journal: `src/act/`, `docs/cli.md` | Optimize offers findings and copyable fixes | Consider opt-in preview/apply/undo with backups, symlink refusal and drift detection; preview must not mutate user configuration. |
| 3 | Session spending guard: `src/guard/`, `docs/guard.md` | Plan/budget display; no enforcing hooks | Evaluate opt-in warning/hard-cap hooks and per-session override. Verify install/uninstall preserves unrelated Claude hooks and failures behave as documented. |
| 3 | Additional providers: `src/providers/index.ts`, `docs/providers/` | Nine registered providers, including Kimi | Select from actual team use, e.g. Gemini CLI, Droid, Qwen or Cline. Add fixtures and discovery, token/dedup, unknown-price and resource-budget checks per adapter. |
| Later | Browser/desktop detail views: `docs/web.md`, `app/` | TUI and native macOS popover | Evaluate demand before importing Electron/web infrastructure. Any new surface must reuse our accounting and keep local access controls and refresh limits. |

### On-screen widget verified on the website

The October 16 follow-up identified the feature the user meant: the **Capacity Dock** section of [codeburn.app](https://codeburn.app/), illustrated in the [official screenshot](https://codeburn.app/capacity-dock.jpg?v=2). Its floating provider rail and expanded usage card show five-hour/weekly utilization and reset timing outside the menu bar popover. The website says it can attach to any screen edge or float freely.

This is native macOS UI within CodeBurn's menu utility, not part of its Electron desktop dependency. The pinned controller implements borderless, non-activating AppKit panels, including support for Spaces/full-screen. The dock specification adds hover expansion, click pinning, saved placement and a Settings toggle. Source: [controller](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/mac/Sources/CodeBurnMenubar/CapacityDockController.swift), [view](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/mac/Sources/CodeBurnMenubar/Views/CapacityDockView.swift), [specification](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/docs/design/capacity-dock.md). During adaptation, verify window layering against actual source: the controller uses shielding level while the older specification describes floating level.

The persistent widget is distinct from actual macOS notification banners. Upstream also implements warnings at **80%** and **100%**, deduplicated per quota cycle, with persisted notification state. `CodeBurnApp.swift` invokes `quotaCrossingMonitor.record(windows: store.quotaWindows)` during refresh. [Threshold notification source](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/mac/Sources/CodeBurnMenubar/Data/QuotaCrossing.swift). Early-reset notices have a separate monitor.

The earlier backlog grouped the dock with broader desktop/web work; this follow-up separates it as a priority-1 native feature. The follow-up implementation now provides a Watcher on-screen surface using six native quota readers; it has not been released.

### First implementation slice: optional floating quota widget

Implemented on `codex/watcher-floating-quota` (unreleased). See [handoff and checks](floating-quota-handoff.md). This also adds You + AI interaction estimates and AI agent-hours with Today/Week/Month/All Time controls. The remaining bullets describe the broader migration boundary, including future adapters beyond the six supported readers.

- Add an optional Watcher floating widget using SwiftUI/AppKit, reusing Claude and adapting Codex, Kimi, Cursor, Copilot and Gemini via the shared model. Include a show/hide setting, an expanded five-hour/weekly card, reset countdowns and saved position. This can stay within our native macOS app.
- Reuse the current Claude reader and usage presentation. Existing code: `mac/Sources/ExeWatcherMenubar/Data/SubscriptionClient.swift`, `SubscriptionUsage.swift`, `Views/HeatmapSection.swift` and `src/providers/codex.ts`.
- Use a provider-neutral snapshot with window identity/duration, utilization, reset, retrieval time, provenance and connection state. Keep subscription capacity separate from API-equivalent spend; dollars spent cannot establish a subscription's remaining quota.
- Decide credential ownership explicitly before porting upstream auth code. Upstream's quota command can refresh and write Codex credentials; it is not purely read-only. Test token rotation, concurrent account changes, file permissions and cancellation without using real user credentials.
- Retain Watcher's bounded, event-driven scan policy. Quota refreshes need their own timeouts, request coalescing and rate-limit backoff; importing upstream polling must not restore frequent usage-log scans.

## MIT obligations and release handling

The [upstream license](https://github.com/getagentseal/codeburn/blob/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/LICENSE) and [OSI MIT text](https://opensource.org/license/mit) require retaining the original copyright and permission notice in copies or substantial portions. Our release practice is to include the **entire MIT text, including the warranty/liability disclaimer**, with source and binary distributions. A README thank-you alone does not carry the required license text.

MIT permits modification, commercial distribution and a different product name. It does not require royalties, upstream contributions, publication of our modifications, a GitHub fork relationship, or an in-app credit screen. Exe AI may add its own copyright for its changes while preserving AgentSeal's. Branding/trademark permissions and other components' licenses are separate.

The initial import already preserved the original MIT license. Before this review, the current root license also retained the terms and both copyright holders, npm automatically included `LICENSE`, and `mac/Scripts/bundle-runtime.sh` copied it into the app. This review restores AgentSeal's copyright line verbatim, adds a self-contained `THIRD_PARTY_NOTICES.md`, explicitly packages it for npm/macOS, and adds visible macOS package attribution.

For future imports, inspect applicable third-party notices, not only CodeBurn's root MIT label. Current upstream includes separately licensed DeepSeek parsing code, vector assets and Lucide icons in `THIRD_PARTY_NOTICES.md`; copy relevant notices only when adopting those components. Preserve bundled dependency/runtime licenses too.

## Attribution review handoff (completed before implementation)

Owned branch: `codex/codeburn-attribution-review`, started from Watcher `09daeac` and now including accepted main `d5789f6`. Scope: attribution, release notice inclusion, README refresh and this comparison/backlog. Feature adoption was proposed at that stage; the subsequent native multi-provider implementation is recorded in the floating-display section and its linked handoff. No merge into main, npm publication, app release or deployment is part of this review.

Required checks: exact imported-tree comparison; verbatim upstream notice comparison; shell syntax for both packaging scripts; CLI typecheck/build; inspect an actual npm tarball for `LICENSE` and `THIRD_PARTY_NOTICES.md`; and verify notice files copied by the macOS runtime bundler. Full signed/notarized packaging is a release check for a future authorized release. Finish when the evidence and backlog are saved and these local checks pass. Record results below.

Validation completed October 16, 2026:

- Imported tree: all 112 files match the pinned upstream snapshot; no shared commit IDs between the reviewed histories.
- AgentSeal's notice in `THIRD_PARTY_NOTICES.md` matches upstream `LICENSE` verbatim. Root MIT text differs only by the additional Exe AI copyright line.
- Both packaging scripts pass `bash -n`; TypeScript typecheck and CLI build pass.
- Actual npm tarball: five files, including byte-identical `LICENSE` and `THIRD_PARTY_NOTICES.md`; no source maps.
- Actual macOS runtime bundle: both notices match the source, the Node license remains included, universal Node passes architecture verification, and the bundled CLI reports 0.2.62. No local `.env`/`.npmrc` or CLI source maps were copied.
- Changed-code and final integration review cover the eight intended files. Full app/DMG signing and notarization were not run; no release was requested.

Detailed local check output was saved at `/tmp/exe-watcher-codeburn-review-20261016/` (`checks.json`, `npm-pack.json`, `bundle-runtime.log`, and the npm tarball). Temporary runtime bundles and review caches were removed after verification. Session token usage figures were unavailable.

Website follow-up: verified the official Capacity Dock description/screenshot and pinned native panel/notification source; checked referenced paths against upstream's tree; reviewed the documentation-only diff and ran `git diff --check`. No runtime implementation changed, so the earlier build/package checks remain applicable.

README refresh checks: eight local links and both internal navigation anchors resolve; code fences are balanced; the 175-day date calculation matches; five CLI help smoke checks cover report/time/Optimize/Compare/menu bar options; source review covers employee data and upstream timing distinctions. Changed-content and final integration review passed for the two documentation files, with accepted main included and `git diff --check` clean. No runtime code changed in this refresh. Token usage figures remain unavailable.
