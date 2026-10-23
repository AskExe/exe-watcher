<p align="center">
  <img src="assets/owls/readme-owl.gif" alt="Watcher owl glancing and blinking above the EXE wordmark" width="280" />
</p>

<p align="center"><strong>The owl watching your AI team — spend, AI work time, and memory per employee, in your terminal and macOS menu bar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/exe-watcher"><img src="https://img.shields.io/npm/v/exe-watcher.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/exe-watcher"><img src="https://img.shields.io/npm/dt/exe-watcher.svg" alt="total downloads" /></a>
  <a href="https://github.com/AskExe/exe-watcher/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/exe-watcher.svg" alt="license" /></a>
  <a href="https://github.com/AskExe/exe-watcher"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg" alt="node version" /></a>
  <a href="https://discord.gg/pJ2DMWvtAx"><img src="https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <img src="assets/exe-watcher-readme.png" alt="Exe Watcher macOS menu bar spend dashboard" width="401" />
</p>

Exe Watcher shows what your AI coding work costs, how long the agents run, and how each Exe OS employee's memory grows. Track nine coding clients, models, projects, tokens, and optimization findings from local usage files. Spend and time tracking need no API keys, account, proxy, or wrappers around your tools; employee memory and spend appear when Exe OS supplies its local agent stats.

**Forked from [CodeBurn by AgentSeal](https://github.com/getagentseal/codeburn) on April 24, 2026.** Since then, Exe AI has developed Watcher for AI employee teams and parallel agent workflows. [Development timeline and comparison](#development-since-the-codeburn-fork) · [Origin and MIT attribution](#origin--attribution)

**macOS app:** Download the universal DMG from [Releases](https://github.com/AskExe/exe-watcher/releases/latest), drag **Watcher by EXE** into **Applications**, and open it. macOS 14+ on Apple Silicon or Intel. From 0.2.55, Node and the CLI are included.

**Terminal CLI** (Node 22.13+):

Node 23.0–23.3 require an upgrade to 23.4 or newer; SQLite is unavailable by default on those older versions.

```bash
npm install -g exe-watcher
exe-watcher report
```

Version 0.2.70 adds local active AI app tracking and broader, clearly labeled historical personal-time estimates. It also explains that first-time history setup can take 10 minutes or more for large AI histories, with saved progress and recovery details. Large Claude history scans resume within the existing resource limits. Recorded API-equivalent costs and saved totals are preserved through refresh failures, restarts and day changes. AI time and the floating quota display are included. Terminal installs require Node 22.13 or newer; the Mac app includes its own compatible runtime. Download the matching app from [Releases](https://github.com/AskExe/exe-watcher/releases/latest) or [odd.community/watcher](https://odd.community/watcher). To run the current CLI from source:

```bash
git clone https://github.com/AskExe/exe-watcher.git
cd exe-watcher
npm ci
npm run build
node dist/cli.js report
```

---

## Built for AI employee teams

- **Floating display** — a compact on-screen quota display for Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini, with **You + AI ≈** (historical sessions plus tracked app activity) and **AI Time** (work time added across all agents). Quota rings show **quota left**, default to **Weekly**, and have a **Weekly / 5h** toggle. Click either time button for its explanation. Time totals default to Today; switch to Week, Month or All Time. Enable it from the menu bar footer’s **Display settings → Floating quota display**. [Details](mac/README.md#floating-display).
- **AI running time** — adds recorded work across agents, so parallel work is counted as agent-hours.
- **Elapsed busy time** — merges overlapping runs to show how long at least one agent was working.
- **Your time ≈** — estimates interaction from short reply-to-next-prompt gaps, with known subagents excluded. It is not an attention or productivity measurement.
- **Memory per employee** — shows persistent memory counts and growth over 24 hours, 7 days, and 30 days from Exe OS. These are saved memories, not RAM usage.
- **Spend per employee** — puts model-aware 24-hour, 7-day, and 30-day cost beside the same Exe OS employee identities.
- **Bounded background work** — coalesces usage-file events, reuses cached periods, resumes historical recovery, and rests between scans.
- **Visible data limits** — distinguishes unknown timing, missing historical call counts, recovered usage, and models whose costs cannot be priced.
- **One local view** — Claude Code, Codex, Cursor, Cursor Agent, Copilot, OpenCode, Kimi Code, OMP, and Pi, with no usage-data upload service.

## Development since the CodeBurn fork

Watcher started as an import of CodeBurn 0.8.9 on **April 24, 2026**. By this review on **October 16, 2026**, it had **175 days of independent development—nearly six months**.

| Date (2026) | Watcher development milestone |
| --- | --- |
| April 24 | Imported the CodeBurn foundation and began the Exe rebrand as exe-fuelbar. |
| April 27–28 | Added Exe OS memory integration and the AI Employees section with per-agent memory growth and spend. |
| April 30 | Renamed the product to Watcher. |
| May–June | Improved accounting, period consistency, wake/recovery behavior, provider isolation, and model presentation. |
| October 3 | Added bounded event-driven usage refreshes, retained-history recovery, and pricing/accounting corrections. |
| October 14–15 | Added self-contained universal macOS packaging, the chosen owl artwork and animation, native Kimi usage, and clearer historical call coverage. |
| October 16 | Added the three AI time totals, provider coverage, a resumable timing index, automatic timing catch-up, and the floating quota/time display. |

### Where Watcher differs today

Comparison checked against [CodeBurn 0.9.27, revision 9a40cc6](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b) on October 16, 2026.

| Capability | Watcher | CodeBurn at the reviewed revision |
| --- | --- | --- |
| Three separate time totals across supported clients | AI running, overlap-adjusted elapsed busy, and estimated interaction time, filtered by period/provider/project | Session-duration and Codex generation-timing metrics exist; no equivalent three-total report was found. |
| Persistent memory per AI employee | Exe OS memory count plus 24h / 7d / 30d growth | No equivalent employee-memory ledger was found. |
| Exe OS employee integration | Memory and spend use Exe OS employee IDs and local daemon stats; includes agent-pipeline diagnostics | Agent/subagent spend views exist; no Exe OS employee/stats integration was found. |

Our subsequent work also includes accounting fixes, bounded history recovery, event-driven native refreshes, current API pricing, Kimi support, self-contained packaging, and Watcher's visual identity. These are documented improvements to our imported baseline; some capabilities also exist in today's CodeBurn. [Detailed evidence and adoption backlog](docs/codeburn-upstream-review.md) · [Changelog](CHANGELOG.md)

Watcher’s floating display takes inspiration from CodeBurn’s **Capacity Dock** and adds our two time totals. It supports six quota providers, including Claude and Codex, with Weekly as their default and a 5-hour toggle. OS threshold notifications and additional adapters remain in the [adoption backlog](docs/codeburn-upstream-review.md).

---

## Features

### Native macOS menu bar app

```bash
exe-watcher menubar            # install + launch
exe-watcher menubar --force    # reinstall latest
exe-watcher menubar --version v0.2.60  # install a specific version
exe-watcher                    # on macOS: prompts to install menubar app
```

> **Note:** Running `exe-watcher` with no subcommand on macOS prompts you to install the menubar app. In non-interactive environments (pipes, CI), it shows help instead. Use `exe-watcher --help` to see all available commands.

A Swift/SwiftUI popover that lives in your menu bar. Today's spend is always visible at a glance.

- **Period switcher** — Today, 7 Days, 30 Days, Month, All Time. Each period includes comparison to the previous window where available.
- **Provider tabs** — Switch between All, Claude, Codex, Cursor, and any other detected provider with spend.
- **Insight tabs** — Trend, Forecast, Pulse, and Stats summarize token/cost movement, projections, optimization wins, and usage streaks.
- **Activity breakdown** — Research, Building, Debugging, DevOps, Testing, and Planning with cost, turns, and one-shot rate.
- **Model breakdown** — See which models are driving spend and call volume.
- **Project spend** — Per-project cost across today / 7d / 30d.
- **AI time** — AI running, elapsed busy, and estimated interaction time for the selected period, with timing coverage details.
- **AI Employees** — Exe OS memory growth and employee spend, when local daemon data is available.
- **Optimization findings** — Menubar links open the full optimizer or report directly in Terminal.
- **Plan budgets** — Compare API-equivalent spend with built-in monthly budget presets or a custom budget.
- **Live Claude capacity** — Five-hour and weekly utilization, reset times, and projections from the signed-in Claude account. This optional view uses provider credentials and may request macOS Keychain access.
- **Capacity estimation** — Derives likely token limits from usage patterns when hard caps aren't published.
- **Multi-currency** — USD, GBP, EUR, JPY, AUD, CAD, CHF, CNY, SEK, NOK, DKK, NZD, SGD, HKD, KRW, INR, BRL.
- **Animated owl** — Glances and blinks while the popover is visible, with Reduce Motion support.

macOS pushes usage-log change notifications to Watcher; there is no repeating background usage scan. Rapid writes are combined, with at least two minutes of rest after a scan and longer after slow scans (nine times the scan duration). A failed notification gets at most two spaced retries before waiting for new data or a user action. Watcher also catches up on launch/wake and explicit user actions. Only one CLI child runs at a time, at low scheduling priority, with a 256 MiB V8 heap limit and a 60-second timeout. Historical and provider detail views load on demand. Failed scans retain the last successful total, including across app restarts on the same date; missing data after midnight displays a dash until a scan succeeds.

### AI time

The menu bar dashboard and full terminal report show three times beneath the spending overview. They follow the selected day, 7 days, 30 days, month or all-time view, with the same provider and project filters:

- **AI running:** recorded run time added across agents. Two agents running for one hour add two hours. Duplicate run IDs copied into forks count once.
- **Elapsed busy:** time when at least one agent was running. Those two parallel agents count as one elapsed hour.
- **Your time ≈:** historical conversation sessions plus foreground app activity tracked on this Mac. Historical sessions join nearby main-chat turn starts with a 15-minute gap; the displayed sensitivity range uses 10–30 minutes. It includes some AI waiting, excludes known subagents and long unattended gaps, and may include main-chat automation. Isolated turns get no invented padding. This is an estimate of engagement, not attention or typing. The older five-minute reply-gap estimate remains available in JSON as `userActiveMs` and in CLI details.

**Track active AI app time on this Mac** can be switched off in the AI time section. It counts foreground Codex, Hansel, Claude and ChatGPT app activity, with a two-minute idle cutoff. Cursor, supported editors and terminals count only alongside a recent matching AI turn; these ambiguous intervals are marked as contextual estimates. Browsers and unsupported apps remain unknown. No keyboard contents, window titles, screenshots, accessibility access or Terminal control are needed. App switching, sleep and console-session notifications drive tracking; a single 30-second idle check runs only while an eligible app is in front. Late checks never fill sleep or scheduler gaps. Daily totals are saved privately, at most every five minutes while continuously active and on app switch/exit; a crash can lose the unsaved tail. No usage scan or extra CLI process is triggered. A writer lock prevents two Watcher copies counting the same foreground activity.

The historical estimate stops when app tracking first begins, so it is never added over the same time as app activity. Period and provider views use the same boundaries. App tracking gaps while Watcher is closed or tracking is off stay unknown. Daily app totals have no project attribution; project-filtered CLI reports show historical sessions only. The stored tracking timezone is fixed to avoid overlapping days after travel. Custom partial-day CLI queries omit daily app totals they cannot precisely locate.

Timing recovery starts July 1, 2025 and uses retained local evidence. **Partial history** stays visible; missing timing is **Unknown**, never zero. Recorded durations may include tool execution and waiting, rather than only time generating tokens. Open runs are not extended to the present.

| Client | Available timing evidence |
|--------|---------------------------|
| Claude Code | Recorded turn durations; older prompt/reply clocks are inferred |
| Codex | Completed/interrupted run boundaries or durations; older reply clocks are inferred |
| Cursor IDE | Saved conversation message start/end clocks, when retained |
| Cursor Agent | Timestamped CLI result durations; ordinary text transcripts lack clocks |
| Copilot | Saved assistant turn start/end pairs |
| OpenCode | Completed message clocks, including archived sessions and subagents; late/missing completions use short inferred spans from saved parts |
| Kimi Code | Native saved step boundaries, including separate agents |
| Pi / OMP | Inferred prompt-to-final-reply spans |

Inferred spans are capped at 30 minutes; longer unmeasured gaps remain unknown. Deleted logs, unsupported formats and sessions without complete clocks cannot supply a full lifetime total. Provider details show how many files have usable timing in the selected period.

Timing uses a separate private index and leaves financial history intact. Existing usage-file events trigger small bounded updates; no extra polling service is installed. Historical recovery advances saved byte cursors in bounded passes, without rereading unchanged transcripts.

The menu bar continues known unfinished timing work in separate timing-only steps, without waiting for another file change or rerunning cost scans. Only one CLI child runs at a time; each step rests for at least nine times its elapsed runtime. Catch-up stops when the queue clears, an incomplete final record needs more data, a step fails, or two steps make no progress. Cost freshness timestamps stay unchanged. Provider file counts mean files with timing **in the selected view**, out of all discovered files.

```bash
exe-watcher time --period all                  # saved/recent timing and coverage
exe-watcher time --period week --format json
exe-watcher time --recover --period all        # one bounded historical pass
```

Repeat a recovery pass while files remain pending and progress advances. Automatic parsing is capped at 16 MiB per update; explicit historical parsing at 256 MiB per pass. Incomplete or unreadable records remain clearly marked.

### Memory and spend per AI employee

When [Exe OS](https://github.com/AskExe/exe-os) supplies local agent stats, Watcher adds an **AI Employees** section to the menu bar with two panels:

- **Memory** — Persistent memory count for each employee, with 24h / 7d / 30d growth columns. This tracks saved knowledge records, not runtime memory consumption or memory quality.
- **Employee Spend** — Per-employee cost across 24h / 7d / 30d, using the model-aware cost buckets supplied by Exe OS.

How it works:

1. Exe OS maps Claude Code sessions to employee IDs through its session-start integration.
2. Its daemon publishes employee memory/growth and model-aware spend buckets to `~/.exe-os/agent-stats.json`.
3. Watcher reads that local stats file; it does not open Exe OS's memory database or fetch memory contents.
4. The CLI's project view also groups recognized agent worktree paths under their parent project.

The section shows a waiting state when Exe OS is detected without stats, and marks data older than five minutes as stale. `exe-watcher agent-status` reports whether the local directory, daemon PID file, stats format and file freshness are available. Spend/time tracking works independently of Exe OS.

### Interactive TUI dashboard

```bash
exe-watcher report             # 7-day terminal dashboard, including on macOS
exe-watcher today              # today only
exe-watcher month              # this calendar month
```

Full-screen terminal dashboard with gradient charts, responsive panels, and keyboard navigation. Breaks down spend by day, project, model, activity type, tools, MCP servers, and shell commands. Auto-refreshes every 30 seconds.

**Keys:** `1`-`5` switch periods (Today / 7d / 30d / Month / All); left/right arrows or Tab cycle periods. `p` switches providers. `r` refreshes. `c` opens comparison and `o` opens Optimize when available. Escape or `b` returns from Optimize; `q` quits.

### Optimize

```bash
exe-watcher optimize           # bounded Claude Code analysis
exe-watcher optimize -p week   # scope to last 7 days
```

Scans your sessions and `~/.claude/` config for waste: re-read files, low read:edit ratios, uncapped bash output, unused MCP servers, ghost agents, bloated CLAUDE.md files. Returns exact copy-paste fixes and estimated savings. Grades your setup A through F.

In the full report, press `o` to see recommendations, `b` to return, or `r` to run the analysis again. Automatic refresh pauses while you read the optimizer. Large histories produce clearly marked partial recommendations from the newest selected sessions, within a smaller analysis budget. Partial checks omit the overall health grade and cleanup suggestions that require complete history. Nothing is applied automatically; token and dollar savings are estimates.

In the optimizer, press `c` to **copy all** recommendations and suggested fixes, ready to paste into Claude Code, or `e` to **save a Markdown file**. The file goes to Downloads when that folder exists, otherwise the current folder; the saved path appears on screen. Both actions use the displayed results without rescanning. Exports include the selected period, coverage warnings, estimates and complete fixes. If the system clipboard is unavailable, save the Markdown file instead.

### Compare

```bash
exe-watcher compare            # interactive model picker
```

Side-by-side model comparison on your own data. One-shot rate, retry rate, cost per edit, cache hit rate, delegation style, fast mode usage — broken down by task category.

---

## Supported providers

| Provider | Data source | Notes |
|----------|-------------|-------|
| **Claude Code** | `~/.claude/projects/` | Full support — tokens, cost, cache, tools |
| **Codex** (OpenAI) | `~/.codex/sessions/` | Full support |
| **Cursor** | SQLite (`state.vscdb`) | Auto mode estimated at Sonnet pricing |
| **Cursor Agent** | CLI sessions | Full support |
| **Copilot** | `~/.copilot/session-state/` | Output tokens only |
| **OpenCode** | SQLite (`~/.local/share/opencode/`) | Subtask sessions excluded |
| **Kimi Code** | `~/.kimi-code/sessions/` | Native `usage.record` logs, including subagents; rotating model aliases remain unpriced |
| **OMP** (Oh My Pi) | `~/.omp/agent/sessions/` | Full support |
| **Pi** | `~/.pi/agent/sessions/` | Full support |

All providers auto-detected. If multiple tools have data, press `p` in the dashboard to toggle between them. The provider plugin system makes adding new tools straightforward — each provider is a single file in `src/providers/`.

On a new Mac, install and open Watcher: no client executables, API keys, shell setup or account connection are required. It reads supported clients' saved usage in the standard folders above. The menu bar app also picks up the first session from a client installed after Watcher starts. Custom folders require the matching environment override or an additional Claude profile root; Finder-launched apps do not inherit variables set only in your terminal shell.

Models are independent of clients: GLM, Kimi, DeepSeek, Gemini and other known models are priced from the model name recorded by Claude Code, OpenCode or another supported client. Costs use current API list rates, including separately recorded cache reads and writes. Subscription quotas, discounts, broker markups and old invoices are not reconstructed. Missing model prices preserve token counts and show an incomplete-cost notice in the app.

This is not universal interception of every AI request. A client must retain a supported usage format with token counts. Deleted logs, cloud-only chats and unsupported formats (including Python Kimi CLI's `~/.kimi/` Wire events and older OpenCode JSON storage) cannot be recovered automatically. Copilot's saved data currently provides output tokens only; Cursor Auto mode uses an estimate. See the table for coverage before treating a total as complete.

---

## CLI reference

```bash
# Dashboard
exe-watcher report                             # interactive (default: 7 days)
exe-watcher today                              # today only
exe-watcher month                              # this month

# Reports
exe-watcher report -p 30days                   # rolling 30-day window
exe-watcher report -p all                      # everything on disk
exe-watcher report --from 2026-04-01 --to 2026-04-10
exe-watcher report --format json               # structured JSON to stdout
exe-watcher status                             # compact spending status

# Menubar data (used by the Swift app)
exe-watcher status --format menubar-json --period today --provider all

# Filter
exe-watcher report --provider claude           # single provider
exe-watcher report --project myapp             # project substring match
exe-watcher report --exclude tests             # exclude projects

# Tools
exe-watcher optimize                           # find waste, get fixes
exe-watcher optimize -p week                   # scope to last 7 days
exe-watcher compare                            # interactive model picker
exe-watcher export                             # CSV (today, 7d, 30d)
exe-watcher export -f json                     # JSON export

# AI time and employee diagnostics
exe-watcher time --period week --format json
exe-watcher time --recover --period all
exe-watcher agent-status                       # diagnose Exe OS stats freshness
```

`report` supports period, provider, project, exclusion, date-range and JSON options. `today`, `month`, `status` and `export` support provider/project/exclusion filters; Optimize and Compare accept period/provider options. `time` has period/provider/project/exclusion filters and text/JSON output. Use `<command> --help` for the options each command accepts.

---

## Configuration

### Currency

```bash
exe-watcher currency GBP              # any supported ISO 4217 code
exe-watcher currency --reset           # back to USD
```

Supported: USD, GBP, EUR, JPY, AUD, CAD, CHF, CNY, SEK, NOK, DKK, NZD, SGD, HKD, KRW, INR, BRL. Exchange rates from the ECB via [Frankfurter](https://www.frankfurter.app/), cached 24 hours. Applies everywhere: dashboard, menubar, exports.

### Plans

Track API-equivalent spend against a configured monthly budget:

```bash
exe-watcher plan set claude-max        # built-in $200 monthly budget
exe-watcher plan set claude-pro        # built-in $20 monthly budget
exe-watcher plan set cursor-pro        # built-in $20 monthly budget
exe-watcher plan set custom --monthly-usd 150 --provider claude
exe-watcher plan set none              # disable
```

These are Watcher's budget presets, not a live price list or a measurement of subscription capacity. The menu bar shows spend against the configured budget. Live Claude five-hour/weekly utilization is a separate provider-reported view.

### Model aliases

If a recorded model has no verified price, Watcher keeps its tokens and warns that cost is excluded. When an alias refers to a known underlying model, map it explicitly:

```bash
exe-watcher model-alias "my-proxy-model" "claude-opus-4-6"
exe-watcher model-alias --list
exe-watcher model-alias --remove "my-proxy-model"
```

Stored in `~/.config/exe-watcher/config.json` (or beneath `XDG_CONFIG_HOME`). User aliases override built-ins. Only alias models whose identity you know; an alias supplies pricing, not proof of the underlying model.

---

## Architecture

Two components, loosely coupled via CLI output:

```text
Provider usage files
       ↓
CLI: deduplicate → price tokens → cache daily totals → JSON
     timing evidence → separate bounded timing index → time totals
       ↓
macOS app: file notifications → one bounded CLI worker → menu bar
```

**CLI pipeline:** Parse provider session files from disk → deduplicate by message ID → compute cost per token type (input, output, cache write, cache read, web search) → aggregate by period, project, model, activity → output as TUI, JSON, or CSV.

**Menubar app:** Calls `exe-watcher status --format menubar-json --period <period> --provider <provider>` → decodes JSON → renders SwiftUI popover. Usage-file notifications trigger coalesced refreshes, with catch-up on launch and wake. Period and provider views load when selected. A single CLI worker has memory, runtime, and output limits; failed scans preserve the last successful total. There is no periodic background usage scan. Security: no shell injection — validated argv arrays are passed directly to child processes, not through a shell.

**Employee data:** Reads Exe OS's local summary file alongside the usage payload. The memory/spend panels use daemon-supplied employee identities and do not transmit memory records.

**Deduplication** per provider: API message ID (Claude), cumulative token cross-check (Codex), conversation/timestamp (Cursor), session+message ID (OpenCode), responseId (Pi/OMP).

---

## Test suite

Tests cover CLI data integrity, native scheduling and resource limits, and optional macOS Accessibility smoke checks. CLI end-to-end tests use isolated usage fixtures.

```bash
# Run CLI tests
npx vitest run

# Run native state and resource tests
swift test --package-path mac --filter ExeWatcherMenubarTests

# UI smoke tests require macOS Accessibility access
swift test --package-path mac --filter ExeWatcherUITests
```

---

## Activity tracking

6 categories classified from tool usage patterns and keywords. No LLM calls, fully deterministic.

| Category | What triggers it |
|----------|-----------------|
| Building | Edit, Write tools; "add", "create", "implement"; refactoring keywords |
| Debugging | Error/fix/bug keywords + tools |
| Testing | pytest, vitest, jest in Bash |
| Research | Read, Grep, WebSearch without edits; brainstorming; conversation |
| DevOps | git push/commit/merge; npm build, docker, deploy |
| Planning | EnterPlanMode, TaskCreate, Agent tool spawns |

---

## Reading the signals

| What you see | What it might mean |
|---|---|
| Cache hit < 80% | Unstable system prompt or caching not enabled |
| Lots of `Read` calls per session | Agent re-reading files, missing context |
| Low 1-shot rate (Coding 30%) | Agent struggling, retry loops |
| Opus on small turns | Overpowered model for simple tasks |
| Bash dominated by `git status`, `ls` | Agent exploring instead of executing |
| Research dominant | Investigating, discussing approaches, or reading without edits |

Starting points, not verdicts. A single experimental session with 60% cache hit is fine. That same number across weeks of work is a config issue.

---

## How it works

Reads session data directly from disk. No wrapper, no proxy, no API keys needed. Pricing refreshes every 24 hours from official OpenAI, Anthropic, MiniMax, Z.AI, Kimi and xAI pricing pages, supplemented by [LiteLLM](https://github.com/BerriAI/litellm). Official rates take precedence over reseller prices for unqualified model names. Offline use retains the last available catalog or the bundled rates verified October 1, 2026, with warnings when a refresh fails. Handles input, output, 5-minute and 1-hour cache writes, cache reads, long-context tiers, and recorded web search costs. Claude streaming records are reconciled by API message ID using cumulative token counters; final usage is counted once.

Counted usage keeps its recorded API-equivalent dollar amount. Pricing refreshes apply to newly counted usage and never trigger an automatic repricing of saved history. Committed daily totals remain cached; new dates and missing providers add usage on top. A small local ledger retains hashed usage identities and their dollar amounts independently of temporary parsing caches, so unchanged accounting stays fixed even after cache eviction or a session append. New or corrected accounting records are new data. JSON reports include `pricing` metadata with this recorded-rates basis, the current feed refresh timestamp and source URLs. These are estimates, not historical invoices. Recovered history with missing request details remains an estimate. Models without published token prices (including Codex Spark) retain their tokens and an explicit cost-exclusion warning; an unknown price is not a final zero-dollar value.

Switching Claude accounts does not filter usage: Watcher counts all retained sessions in the configured data directory and Claude Desktop account folders. Codex archived sessions also count. Add other Claude profile roots with `claudeConfigDirs` in `~/.config/exe-watcher/config.json`.

“All Time” includes the entire available history. To set the beginning of your coding journey, add `"historyStartDate": "2025-07-01"` to the same config. This defines the reporting window; it cannot recreate missing logs. Unknown model prices generate a warning while their tokens remain counted.

For unfiltered All Time Claude totals, Watcher also reconciles `stats-cache.json` cumulative model counters with retained logs through the snapshot's cutoff date. Only missing per-model/token counters are added. Recovered usage is separately identified as `historicalRecovery`: it has no fabricated dates, sessions, or projects, and uses standard API rates with 5-minute cache writes because TTL/speed metadata is unavailable. Daily charts show dated logs only. Project/provider sums include recovery only where attribution is known. Usage lost from both logs and cumulative counters remains unknown. These are API-equivalent estimates, not subscription charges or invoices.

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude data directory (default: `~/.claude`) |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `KIMI_CODE_HOME` | Override native Kimi Code data directory (default: `~/.kimi-code`) |
| `XDG_DATA_HOME` | Base data directory for OpenCode (default: `~/.local/share`) |
| `XDG_CONFIG_HOME` | Base directory for Watcher configuration (default: `~/.config`) |
| `EXE_WATCHER_CACHE_DIR` | Override cache directory (default: `~/.cache/exe-watcher`) |

### Optional analytics and error reporting

Watcher uses our self-hosted PostHog and Sentry through `https://data.odd.community`.
Basic usage statistics default on after a first-run disclosure. Sanitized error
diagnostics are a separate, optional choice and default off. Existing opt-outs
are preserved. In the Mac app, find both controls under the Settings gear. In the CLI:

```sh
exe-watcher telemetry --usage on --errors on
exe-watcher telemetry --usage off --errors off
```

Usage counts participating installations, foreground feature use, active Mac menu
time, and fixed success/failure outcomes, with numeric app version and coarse
platform metadata. Recording time is N/A. Errors include only category, class and app version.
No prompts, usage logs, project names, paths, spend, raw error text, native crash
dumps, screenshots or replay are sent. Background CLI scans do not count as use.
`DO_NOT_TRACK=1` or `EXE_WATCHER_TELEMETRY=0` disables collection. Turning a control
off clears its unsent queue; received reports remain. Our collector receives your
connection IP but does not forward it to PostHog/Sentry. No project keys are needed.
See [privacy, retry behavior and operator setup](docs/analytics/README.md).

---

## Contributing

Contributions welcome. The provider plugin system is the easiest entry point — each provider is a single file in `src/providers/`.

```
src/
  cli.ts            Entry point (Commander.js)
  dashboard.tsx     TUI (Ink — React for terminals)
  parser.ts         Session reader, dedup, date filter
  models.ts         Pricing catalog and verified model aliases
  official-pricing.ts  Official provider pricing overrides
  classifier.ts     Activity classifier (6 categories)
  compare-stats.ts  Model comparison engine
  menubar-json.ts   Menu bar payload, employee stats and project spend
  resource-budget.ts  Scan memory, runtime and output limits
  history-build.ts  Resumable historical accounting
  time-tracking.ts  AI running, elapsed busy and interaction estimates
  time-index.ts     Separate bounded timing index and recovery
  export.ts         CSV/JSON export
  config.ts         Config management
  currency.ts       Currency conversion
  providers/        One file per supported tool
mac/                Native macOS menubar app (Swift + SwiftUI)
tests/              CLI data integrity tests (Vitest)
```

---

## Origin & attribution

Watcher is an independently developed derivative of [CodeBurn](https://github.com/getagentseal/codeburn) by [AgentSeal](https://github.com/getagentseal), used under the MIT license. It began as a source import into a new repository on **April 24, 2026 at 14:40 Asia/Makassar (06:40 UTC)**, initially named exe-fuelbar. It is a fork in the development sense; GitHub does not list this repository as a fork.

The [initial import](https://github.com/AskExe/exe-watcher/commit/8545e35633958ab3fd12600c1ac89c528c867904) contains 112 files identical to the corresponding files in [CodeBurn commit d3c4de0](https://github.com/getagentseal/codeburn/commit/d3c4de03759f0ded38052874fa829709d27fe7c6), whose package version was 0.8.9. Upstream's commit history was not imported.

**The inherited foundation** includes the CLI/TUI, eight provider integrations, the native macOS menu bar app, subscription tracking (including Claude's five-hour and weekly windows), capacity estimation, currency support, model comparisons, and optimization analysis. These were already present at import and belong in CodeBurn's credit.

**Watcher's subsequent work** includes its Exe branding and owl artwork, Exe OS agent/memory integration, bounded event-driven refreshes and history recovery, accounting and pricing corrections, native Kimi Code support, self-contained macOS packaging, and AI running/elapsed/interaction time reporting. The roadmap serves our AI employee teams and multi-agent workflows.

AgentSeal's original copyright notice and the full MIT terms are preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The notices ship with the npm package and packaged macOS app. See the [dated upstream comparison and adoption backlog](docs/codeburn-upstream-review.md) for evidence and features to evaluate.

Thank you to AgentSeal and CodeBurn's contributors for the foundation.

---

## Star History

<a href="https://www.star-history.com/?repos=AskExe%2Fexe-watcher&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT. Includes CodeBurn by AgentSeal; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

---

Built by [Exe AI](https://askexe.com). Forked from [codeburn](https://github.com/getagentseal/codeburn) by AgentSeal (MIT). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).
